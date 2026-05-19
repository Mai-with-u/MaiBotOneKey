import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { IBufferLine, ILink, ILinkProvider } from "@xterm/xterm";
import type { LogEntry, PtySessionSnapshot, ServiceDescriptor, ServiceId, TerminalSettings } from "@shared/contracts";
import { ArrowDownToLine, Copy, Loader2, RotateCcw, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/use-shortcut";

const XTERM_THEME = {
  background: "#0c100e",
  foreground: "#dfe8d1",
  cursor: "#b8ed88",
  cursorAccent: "#0c100e",
  selectionBackground: "#496240",
  black: "#11150f",
  red: "#e26d5a",
  green: "#9bd56c",
  yellow: "#d5ba65",
  blue: "#7bb5e8",
  magenta: "#c98ee8",
  cyan: "#70d5c1",
  white: "#dfe8d1",
  brightBlack: "#596151",
  brightRed: "#f28c78",
  brightGreen: "#b8ed88",
  brightYellow: "#ecd37d",
  brightBlue: "#9fd1ff",
  brightMagenta: "#dfadff",
  brightCyan: "#96ead9",
  brightWhite: "#f2f8e8",
} as const satisfies NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"];

const serviceTerminals: Array<{ serviceId: ServiceId; sessionId: string; title: string }> = [
  { serviceId: "maibot", sessionId: "service:maibot", title: "MaiBot Core" },
  { serviceId: "napcat", sessionId: "service:napcat", title: "NapCat" },
];

const MIN_VISIBLE_TERMINAL_WIDTH = 240;
const MIN_VISIBLE_TERMINAL_HEIGHT = 120;
const TERMINAL_LINK_PATTERN = /\b(?:https?:\/\/[^\s<>"'，。；）\])]+|logs\/[^\s<>"'，。；）\])]+\.(?:html|txt|json|log))/giu;

const statusText: Record<PtySessionSnapshot["status"], string> = {
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  exited: "已退出",
  error: "异常",
};

interface Disposable {
  dispose: () => void;
}

interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  disposables: Disposable[];
  opened: boolean;
  bufferLoaded: boolean;
}

function serviceBadgeVariant(service?: ServiceDescriptor): "success" | "warning" | "danger" | "outline" {
  if (!service) {
    return "outline";
  }
  if (service.status === "running") {
    return "success";
  }
  if (service.status === "starting" || service.status === "stopping") {
    return "warning";
  }
  if (service.status === "error") {
    return "danger";
  }
  return "outline";
}

function writeSystemLine(terminal: Terminal, message: string): void {
  terminal.writeln(`\x1b[38;2;155;213;108m[desktop]\x1b[0m ${message}`);
}

function canWriteToSession(session?: PtySessionSnapshot): boolean {
  return session?.status === "running";
}

interface TerminalLinkMatch {
  text: string;
  startCell: number;
  endCell: number;
}

function lineTextWithCellMap(line: IBufferLine): { text: string; cells: number[] } {
  let text = "";
  const cells: number[] = [];
  for (let cellIndex = 0; cellIndex < line.length; cellIndex += 1) {
    const cell = line.getCell(cellIndex);
    if (!cell || cell.getWidth() === 0) {
      continue;
    }
    const chars = cell.getChars() || " ";
    for (let charIndex = 0; charIndex < chars.length; charIndex += 1) {
      cells.push(cellIndex);
    }
    text += chars;
  }
  return { text: text.trimEnd(), cells };
}

function terminalLinkMatches(line: IBufferLine): TerminalLinkMatch[] {
  const { text, cells } = lineTextWithCellMap(line);
  const matches: TerminalLinkMatch[] = [];
  for (const match of text.matchAll(TERMINAL_LINK_PATTERN)) {
    const rawText = match[0].replace(/[，。；、,.]+$/u, "");
    if (!rawText || match.index === undefined) {
      continue;
    }
    const startIndex = match.index;
    const endIndex = startIndex + rawText.length - 1;
    const startCell = cells[startIndex];
    const endCell = cells[endIndex];
    if (startCell === undefined || endCell === undefined) {
      continue;
    }
    matches.push({ text: rawText, startCell, endCell });
  }
  return matches;
}

function localTerminalPath(maibotRoot: string | undefined, text: string): string | null {
  if (!maibotRoot || !text.startsWith("logs/")) {
    return null;
  }
  return `${maibotRoot.replace(/[\\/]+$/u, "")}\\${text.replace(/\//gu, "\\")}`;
}

function createTerminalLinkProvider(terminal: Terminal, maibotRoot: string | undefined): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback): void {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1) ?? terminal.buffer.active.getLine(bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }
      const links: ILink[] = terminalLinkMatches(line).map((match) => ({
        range: {
          start: { x: match.startCell + 1, y: bufferLineNumber },
          end: { x: match.endCell + 1, y: bufferLineNumber },
        },
        text: match.text,
        activate: (_event, text): void => {
          const localPath = localTerminalPath(maibotRoot, text);
          if (localPath) {
            void window.maibotDesktop?.openPath(localPath);
            return;
          }
          if (/^https?:\/\//iu.test(text)) {
            void window.maibotDesktop?.openExternal(text);
          }
        },
      }));
      callback(links.length ? links : undefined);
    },
  };
}

function serviceIdFromLog(entry: LogEntry): ServiceId | undefined {
  return entry.source === "maibot" || entry.source === "napcat" ? entry.source : undefined;
}

async function copyTerminalSelection(terminal: Terminal): Promise<void> {
  const selection = terminal.getSelection();
  if (!selection) {
    return;
  }

  await navigator.clipboard.writeText(selection);
}

export function TerminalPanel({
  active = true,
  recentLogs = [],
  services = [],
  terminalSettings,
  maibotRoot,
}: {
  active?: boolean;
  recentLogs?: LogEntry[];
  services?: ServiceDescriptor[];
  terminalSettings?: TerminalSettings;
  maibotRoot?: string;
}): React.JSX.Element {
  const [activeServiceId, setActiveServiceId] = useState<ServiceId>("maibot");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const sessionsRef = useRef(new Map<string, PtySessionSnapshot>());
  const terminalsRef = useRef(new Map<string, TerminalInstance>());
  const panesRef = useRef(new Map<string, HTMLDivElement>());
  const bridgeRef = useRef<typeof window.maibotDesktop | null>(null);
  const activeServiceIdRef = useRef(activeServiceId);
  const prePtyNoticeRef = useRef(new Map<ServiceId, string>());
  const recentLogsRef = useRef<LogEntry[]>(recentLogs);
  const writtenSystemLogIdsRef = useRef(new Set<string>());
  const terminalFontSize = terminalSettings?.fontSize ?? 12;

  const servicesById = useMemo(
    () => new Map<ServiceId, ServiceDescriptor>(services.map((service) => [service.id, service])),
    [services],
  );

  const activeTerminal = serviceTerminals.find((terminal) => terminal.serviceId === activeServiceId) ?? serviceTerminals[0];
  const activeSession = sessionsRef.current.get(activeTerminal.sessionId);
  const activeService = servicesById.get(activeServiceId);

  useEffect(() => {
    activeServiceIdRef.current = activeServiceId;
  }, [activeServiceId]);

  useEffect(() => {
    recentLogsRef.current = recentLogs;
  }, [recentLogs]);

  const notifySessionsChanged = useCallback(() => {
    setSessionVersion((version) => version + 1);
  }, []);

  const fitTerminal = useCallback((sessionId: string) => {
    const instance = terminalsRef.current.get(sessionId);
    if (!instance?.opened) {
      return;
    }

    const pane = panesRef.current.get(sessionId);
    const rect = pane?.getBoundingClientRect();
    if (
      !rect ||
      rect.width < MIN_VISIBLE_TERMINAL_WIDTH ||
      rect.height < MIN_VISIBLE_TERMINAL_HEIGHT
    ) {
      return;
    }

    try {
      instance.fitAddon.fit();
    } catch {
      return;
    }
  }, []);

  const scheduleFitTerminal = useCallback(
    (sessionId: string) => {
      requestAnimationFrame(() => {
        fitTerminal(sessionId);
        window.setTimeout(() => fitTerminal(sessionId), 80);
      });
    },
    [fitTerminal],
  );

  const getTerminal = useCallback(
    (sessionId: string): TerminalInstance => {
      const existing = terminalsRef.current.get(sessionId);
      if (existing) {
        return existing;
      }

      const terminal = new Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily:
          '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: terminalFontSize,
        lineHeight: 1.22,
        scrollback: 100_000,
        tabStopWidth: 8,
        theme: XTERM_THEME,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      const disposables: Disposable[] = [
        terminal.registerLinkProvider(createTerminalLinkProvider(terminal, maibotRoot)),
        terminal.onData((data) => {
          if (!canWriteToSession(sessionsRef.current.get(sessionId))) {
            return;
          }

          void bridgeRef.current?.pty.input({ sessionId, data }).catch((error: unknown) => {
            writeSystemLine(terminal, error instanceof Error ? error.message : String(error));
          });
        }),
        terminal.onResize(({ cols, rows }) => {
          const pane = panesRef.current.get(sessionId);
          const rect = pane?.getBoundingClientRect();
          if (
            !rect ||
            rect.width < MIN_VISIBLE_TERMINAL_WIDTH ||
            rect.height < MIN_VISIBLE_TERMINAL_HEIGHT
          ) {
            return;
          }

          void bridgeRef.current?.pty.resize({ sessionId, cols, rows }).catch(() => undefined);
        }),
      ];

      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown" && event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c") {
          event.preventDefault();
          event.stopPropagation();
          void copyTerminalSelection(terminal);
          return false;
        }

        if (event.type === "keydown" && !canWriteToSession(sessionsRef.current.get(sessionId))) {
          return false;
        }

        return true;
      });

      const instance = { terminal, fitAddon, disposables, opened: false, bufferLoaded: false };
      terminalsRef.current.set(sessionId, instance);
      return instance;
    },
    [maibotRoot, terminalFontSize],
  );

  useEffect(() => {
    for (const [sessionId, instance] of terminalsRef.current) {
      instance.terminal.options.fontSize = terminalFontSize;
      scheduleFitTerminal(sessionId);
    }
  }, [scheduleFitTerminal, terminalFontSize]);

  const openTerminal = useCallback(
    (sessionId: string, element: HTMLDivElement) => {
      const instance = getTerminal(sessionId);
      if (!instance.opened) {
        instance.terminal.open(element);
        instance.opened = true;
      }

      scheduleFitTerminal(sessionId);
    },
    [getTerminal, scheduleFitTerminal],
  );

  const writeStoredSystemLogs = useCallback(
    (sessionId: string) => {
      const terminal = getTerminal(sessionId).terminal;
      for (const entry of recentLogsRef.current) {
        const serviceId = serviceIdFromLog(entry);
        if (!serviceId || entry.stream !== "system" || `service:${serviceId}` !== sessionId) {
          continue;
        }
        writeSystemLine(terminal, entry.message);
        writtenSystemLogIdsRef.current.add(entry.id);
      }
    },
    [getTerminal],
  );

  useEffect(() => {
    for (const item of serviceTerminals) {
      const service = servicesById.get(item.serviceId);
      const session = sessionsRef.current.get(item.sessionId);
      if (session || service?.status !== "starting") {
        prePtyNoticeRef.current.delete(item.serviceId);
        continue;
      }

      const message = service.detail || "正在启动；后台会先检查并更新依赖，完成后再创建 PTY";
      if (prePtyNoticeRef.current.get(item.serviceId) === message) {
        continue;
      }

      prePtyNoticeRef.current.set(item.serviceId, message);
      writeSystemLine(getTerminal(item.sessionId).terminal, message);
    }
  }, [getTerminal, servicesById, sessionVersion]);

  const setTerminalPane = useCallback(
    (sessionId: string) => (element: HTMLDivElement | null) => {
      if (!element) {
        panesRef.current.delete(sessionId);
        return;
      }

      panesRef.current.set(sessionId, element);
      openTerminal(sessionId, element);
    },
    [openTerminal],
  );

  const loadSessionBuffer = useCallback(
    async (sessionId: string, force = false) => {
      const bridge = bridgeRef.current;
      const instance = getTerminal(sessionId);
      if (!bridge?.pty || (!force && instance.bufferLoaded)) {
        return;
      }

      try {
        const buffer = await bridge.pty.getBuffer(sessionId);
        instance.terminal.reset();
        writeStoredSystemLogs(sessionId);
        if (buffer) {
          instance.terminal.write(buffer);
        }
        instance.bufferLoaded = true;
      } catch {
        instance.bufferLoaded = false;
      }
    },
    [getTerminal, writeStoredSystemLogs],
  );

  const refreshSessions = useCallback(async () => {
    const bridge = window.maibotDesktop;
    if (!bridge?.pty) {
      return;
    }

    setIsRefreshing(true);
    bridgeRef.current = bridge;
    try {
      const sessions = await bridge.pty.list();
      sessionsRef.current = new Map(sessions.map((session) => [session.id, session]));
      await Promise.all(serviceTerminals.map((item) => loadSessionBuffer(item.sessionId, true)));
      notifySessionsChanged();
      const currentService = serviceTerminals.find((item) => item.serviceId === activeServiceIdRef.current) ?? serviceTerminals[0];
      scheduleFitTerminal(currentService.sessionId);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadSessionBuffer, notifySessionsChanged, scheduleFitTerminal]);

  useEffect(() => {
    void refreshSessions();

    const bridge = window.maibotDesktop;
    if (!bridge?.pty) {
      return;
    }

    bridgeRef.current = bridge;
    const disposers = [
      bridge.pty.onData((event) => {
        getTerminal(event.sessionId).terminal.write(event.data);
      }),
      bridge.pty.onExit((event) => {
        const existing = sessionsRef.current.get(event.sessionId);
        if (existing) {
          sessionsRef.current.set(event.sessionId, {
            ...existing,
            status: "exited",
            exitCode: event.exitCode,
            signal: event.signal,
            endedAt: Date.now(),
          });
        }
        writeSystemLine(getTerminal(event.sessionId).terminal, `process exited with code ${event.exitCode}`);
        notifySessionsChanged();
      }),
      bridge.pty.onError((event) => {
        writeSystemLine(getTerminal(event.sessionId).terminal, `error: ${event.message}`);
      }),
      bridge.pty.onSnapshot((snapshot) => {
        sessionsRef.current.set(snapshot.id, snapshot);
        void loadSessionBuffer(snapshot.id);
        notifySessionsChanged();
      }),
      bridge.logs.onEntry((entry) => {
        const serviceId = serviceIdFromLog(entry);
        if (!serviceId || entry.stream !== "system") {
          return;
        }

        if (writtenSystemLogIdsRef.current.has(entry.id)) {
          return;
        }
        writtenSystemLogIdsRef.current.add(entry.id);
        const sessionId = `service:${serviceId}`;
        writeSystemLine(getTerminal(sessionId).terminal, entry.message);
      }),
    ];

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [getTerminal, loadSessionBuffer, notifySessionsChanged, refreshSessions]);

  useEffect(() => {
    for (const entry of recentLogs) {
      const serviceId = serviceIdFromLog(entry);
      if (!serviceId || entry.stream !== "system" || writtenSystemLogIdsRef.current.has(entry.id)) {
        continue;
      }
      writtenSystemLogIdsRef.current.add(entry.id);
      writeSystemLine(getTerminal(`service:${serviceId}`).terminal, entry.message);
    }
  }, [getTerminal, recentLogs]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const sessionId = activeTerminal.sessionId;
    requestAnimationFrame(() => {
      scheduleFitTerminal(sessionId);
      getTerminal(sessionId).terminal.focus();
    });
  }, [active, activeTerminal.sessionId, getTerminal, scheduleFitTerminal, sessionVersion]);

  useEffect(() => {
    const pane = panesRef.current.get(activeTerminal.sessionId);
    if (!pane) {
      return;
    }

    const observer = new ResizeObserver(() => {
      scheduleFitTerminal(activeTerminal.sessionId);
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [activeTerminal.sessionId, scheduleFitTerminal]);

  useEffect(() => {
    return () => {
      for (const instance of terminalsRef.current.values()) {
        for (const disposable of instance.disposables) {
          disposable.dispose();
        }
        instance.terminal.dispose();
      }
      terminalsRef.current.clear();
    };
  }, []);

  const copySelection = useCallback(() => {
    void copyTerminalSelection(getTerminal(activeTerminal.sessionId).terminal);
  }, [activeTerminal.sessionId, getTerminal]);

  const scrollToTail = useCallback(() => {
    getTerminal(activeTerminal.sessionId).terminal.scrollToBottom();
  }, [activeTerminal.sessionId, getTerminal]);

  const selectService = useCallback((serviceId: ServiceId) => {
    setActiveServiceId(serviceId);
  }, []);

  useShortcut("Mod+Shift+R", refreshSessions, { enabled: active });

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="size-3.5 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold tracking-tight text-foreground">
              后台 PTY 终端
            </h2>
            <p className="truncate text-[10px] text-muted-foreground">
              {activeSession?.pid ? `PID ${activeSession.pid}` : "等待后台服务启动"} · Ctrl+C 复制选中内容
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button className="h-7 px-2 text-xs" onClick={copySelection} size="sm" variant="outline">
            <Copy />
            复制
          </Button>
          <Button className="h-7 px-2 text-xs" onClick={scrollToTail} size="sm" variant="outline">
            <ArrowDownToLine />
            底部
          </Button>
          <Button className="h-7 px-2 text-xs" disabled={isRefreshing} onClick={refreshSessions} size="sm" variant="outline">
            {isRefreshing ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            附加
            <Kbd className="ml-1" keys="Mod+Shift+R" size="xs" tone="muted" />
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-card/60 px-2.5 py-1">
        {serviceTerminals.map((item) => {
          const session = sessionsRef.current.get(item.sessionId);
          const service = servicesById.get(item.serviceId);
          const selected = activeServiceId === item.serviceId;
          return (
            <button
              className={[
                "flex h-7 min-w-[154px] items-center justify-between gap-2 rounded-md border px-2.5 text-left transition-colors",
                selected
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-accent/40 hover:text-foreground",
              ].join(" ")}
              key={item.serviceId}
              onClick={() => selectService(item.serviceId)}
              type="button"
            >
              <span className="min-w-0 truncate text-[11px] font-semibold">{service?.name ?? item.title}</span>
              <span className="flex shrink-0 items-center gap-1">
                <Badge className="h-4 px-1.5 text-[9.5px]" variant={serviceBadgeVariant(service)}>
                  {service?.status === "running" ? "服务运行" : service?.status === "error" ? "异常" : "未运行"}
                </Badge>
                <Badge className="h-4 px-1.5 text-[9.5px]" variant="outline">
                  {session ? statusText[session.status] : "无 PTY"}
                </Badge>
              </span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div
          className="relative size-full overflow-hidden rounded-md border border-border shadow-inner"
          style={{ backgroundColor: XTERM_THEME.background }}
        >
          {serviceTerminals.map((item) => (
            <div
              aria-hidden={item.serviceId !== activeServiceId}
              className={[
                "absolute inset-0 size-full",
                item.serviceId === activeServiceId
                  ? "z-10 opacity-100"
                  : "z-0 opacity-0 pointer-events-none",
              ].join(" ")}
              key={item.sessionId}
              ref={setTerminalPane(item.sessionId)}
            />
          ))}
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-card px-3 font-mono text-[10px] text-muted-foreground">
        <span>{activeSession?.pid ? `pid ${activeSession.pid}` : "no pty"}</span>
        <span className="min-w-0 truncate pl-4 text-right">{activeService?.command?.[0] ?? "启动命令会在服务启动后显示"}</span>
      </div>
    </section>
  );
}
