import type {
  DesktopBridge,
  PtyDataEvent,
  PtyErrorEvent,
  PtyExitEvent,
  PtySessionSnapshot,
} from "@shared/contracts";

export interface PtyLogLine {
  id: number;
  sessionId: string;
  raw: string;
  timestamp: number;
  partial?: boolean;
  stream?: "stdout" | "system";
}

const MAX_LINES_PER_SESSION = 200_000;
const SERVICE_SESSION_IDS = ["service:maibot", "service:napcat"];

async function waitForDesktopBridge(timeoutMs = 5_000): Promise<DesktopBridge | null> {
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    if (window.maibotDesktop?.pty) {
      return window.maibotDesktop;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return window.maibotDesktop?.pty ? window.maibotDesktop : null;
}

class PtyLogStore {
  private readonly listeners = new Set<() => void>();
  private readonly lines = new Map<string, PtyLogLine[]>();
  private readonly partials = new Map<string, string>();
  private readonly sessions = new Map<string, PtySessionSnapshot>();
  private bridge: DesktopBridge | null = null;
  private version = 0;
  private nextId = 1;
  private connecting = false;
  private connected = false;
  private notifyPending = false;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion(): number {
    return this.version;
  }

  getSession(sessionId: string): PtySessionSnapshot | undefined {
    return this.sessions.get(sessionId);
  }

  getLineCount(sessionId: string): number {
    return (this.lines.get(sessionId)?.length ?? 0) + (this.partials.get(sessionId) ? 1 : 0);
  }

  getLine(sessionId: string, index: number): PtyLogLine | undefined {
    const lines = this.lines.get(sessionId) ?? [];
    if (index < lines.length) {
      return lines[index];
    }

    const partial = this.partials.get(sessionId);
    return partial
      ? {
          id: -1,
          sessionId,
          raw: partial,
          timestamp: Date.now(),
          partial: true,
          stream: "stdout",
        }
      : undefined;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) {
      return;
    }

    this.connecting = true;
    const bridge = await waitForDesktopBridge();
    this.connecting = false;
    if (!bridge) {
      this.appendSystemLine("desktop", "Electron preload bridge 不可用");
      return;
    }

    this.bridge = bridge;
    this.connected = true;
    this.appendSystemLine("desktop", "Electron preload bridge connected");

    const sessions = await bridge.pty.list();
    for (const session of sessions) {
      this.sessions.set(session.id, session);
    }

    for (const sessionId of SERVICE_SESSION_IDS) {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        continue;
      }

      const buffer = await bridge.pty.getBuffer(session.id);
      this.replaceBuffer(session.id, buffer);
    }

    bridge.pty.onData((event) => this.onData(event));
    bridge.pty.onExit((event) => this.onExit(event));
    bridge.pty.onError((event) => this.onError(event));
    bridge.pty.onSnapshot((snapshot) => {
      this.sessions.set(snapshot.id, snapshot);
      this.scheduleNotify();
    });
    this.scheduleNotify();
  }

  private onData(event: PtyDataEvent): void {
    this.appendData(event.sessionId, event.data);
  }

  private onExit(event: PtyExitEvent): void {
    const existing = this.sessions.get(event.sessionId);
    if (existing) {
      this.sessions.set(event.sessionId, {
        ...existing,
        status: "exited",
        exitCode: event.exitCode,
        signal: event.signal,
        endedAt: Date.now(),
      });
    }
    this.appendSystemLine(event.sessionId, `process exited with code ${event.exitCode}`);
  }

  private onError(event: PtyErrorEvent): void {
    this.appendSystemLine(event.sessionId, `error: ${event.message}`);
  }

  private replaceBuffer(sessionId: string, buffer: string): void {
    this.lines.set(sessionId, []);
    this.partials.delete(sessionId);
    if (buffer.length > 0) {
      this.appendData(sessionId, buffer);
    }
  }

  private appendData(sessionId: string, data: string): void {
    const normalized = data.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    const combined = `${this.partials.get(sessionId) ?? ""}${normalized}`;
    const chunks = combined.split("\n");
    const tail = chunks.pop() ?? "";
    this.partials.set(sessionId, tail);

    const lines = this.lines.get(sessionId) ?? [];
    for (const chunk of chunks) {
      lines.push({
        id: this.nextId++,
        sessionId,
        raw: chunk,
        timestamp: Date.now(),
        stream: "stdout",
      });
    }

    if (lines.length > MAX_LINES_PER_SESSION) {
      lines.splice(0, lines.length - MAX_LINES_PER_SESSION);
    }

    this.lines.set(sessionId, lines);
    this.scheduleNotify();
  }

  private appendSystemLine(sessionId: string, raw: string): void {
    const lines = this.lines.get(sessionId) ?? [];
    lines.push({
      id: this.nextId++,
      sessionId,
      raw: `\x1b[38;2;155;213;108m[desktop]\x1b[0m ${raw}`,
      timestamp: Date.now(),
      stream: "system",
    });
    if (lines.length > MAX_LINES_PER_SESSION) {
      lines.splice(0, lines.length - MAX_LINES_PER_SESSION);
    }
    this.lines.set(sessionId, lines);
    this.scheduleNotify();
  }

  private scheduleNotify(): void {
    if (this.notifyPending) {
      return;
    }

    this.notifyPending = true;
    requestAnimationFrame(() => {
      this.notifyPending = false;
      this.version += 1;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }
}

export const ptyLogStore = new PtyLogStore();

export function initializePtyLogStore(): void {
  void ptyLogStore.connect();
}
