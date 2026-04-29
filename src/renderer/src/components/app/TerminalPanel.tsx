import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { PtySessionSnapshot, ServiceDescriptor, ServiceId } from "@shared/contracts";
import { ArrowDownToLine, Copy, Loader2, RotateCcw, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/use-shortcut";

const serviceTerminals: Array<{ serviceId: ServiceId; sessionId: string; title: string }> = [
  { serviceId: "maibot", sessionId: "service:maibot", title: "MaiBot Core" },
  { serviceId: "napcat", sessionId: "service:napcat", title: "NapCat" },
];

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

async function copyTerminalSelection(terminal: Terminal): Promise<void> {
  const selection = terminal.getSelection();
  if (!selection) {
    return;
  }

  await navigator.clipboard.writeText(selection);
}

export function TerminalPanel({
  active = true,
  services = [],
}: {
  active?: boolean;
  services?: ServiceDescriptor[];
}): React.JSX.Element {
  const [activeServiceId, setActiveServiceId] = useState<ServiceId>("maibot");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const sessionsRef = useRef(new Map<string, PtySessionSnapshot>());
  const terminalsRef = useRef(new Map<string, TerminalInstance>());
  const panesRef = useRef(new Map<string, HTMLDivElement>());
  const bridgeRef = useRef<typeof window.maibotDesktop | null>(null);
  const activeServiceIdRef = useRef(activeServiceId);

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

  const notifySessionsChanged = useCallback(() => {
    setSessionVersion((version) => version + 1);
  }, []);

  const fitTerminal = useCallback((sessionId: string) => {
    const instance = terminalsRef.current.get(sessionId);
    if (!instance?.opened) {
      return;
    }

    try {
      instance.fitAddon.fit();
    } catch {
      return;
    }
  }, []);

  const getTerminal = useCallback(
    (sessionId: string): TerminalInstance => {
      const existing = terminalsRef.current.get(sessionId);
      if (existing) {
        return existing;
      }

      const terminal = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily:
          '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        lineHeight: 1.22,
        scrollback: 100_000,
        tabStopWidth: 8,
        theme: {
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
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      const disposables: Disposable[] = [
        terminal.onData((data) => {
          if (!canWriteToSession(sessionsRef.current.get(sessionId))) {
            return;
          }

          void bridgeRef.current?.pty.input({ sessionId, data }).catch((error: unknown) => {
            writeSystemLine(terminal, error instanceof Error ? error.message : String(error));
          });
        }),
        terminal.onResize(({ cols, rows }) => {
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
    [],
  );

  const openTerminal = useCallback(
    (sessionId: string, element: HTMLDivElement) => {
      const instance = getTerminal(sessionId);
      if (!instance.opened) {
        instance.terminal.open(element);
        instance.opened = true;
      }

      requestAnimationFrame(() => fitTerminal(sessionId));
    },
    [fitTerminal, getTerminal],
  );

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
        if (buffer) {
          instance.terminal.write(buffer);
        }
        instance.bufferLoaded = true;
      } catch {
        instance.bufferLoaded = false;
      }
    },
    [getTerminal],
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
      requestAnimationFrame(() => fitTerminal(activeTerminal.sessionId));
    } finally {
      setIsRefreshing(false);
    }
  }, [activeTerminal.sessionId, fitTerminal, loadSessionBuffer, notifySessionsChanged]);

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
    ];

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [getTerminal, loadSessionBuffer, notifySessionsChanged, refreshSessions]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const sessionId = activeTerminal.sessionId;
    requestAnimationFrame(() => {
      fitTerminal(sessionId);
      getTerminal(sessionId).terminal.focus();
    });
  }, [active, activeTerminal.sessionId, fitTerminal, getTerminal, sessionVersion]);

  useEffect(() => {
    const pane = panesRef.current.get(activeTerminal.sessionId);
    if (!pane) {
      return;
    }

    const observer = new ResizeObserver(() => fitTerminal(activeTerminal.sessionId));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [activeTerminal.sessionId, fitTerminal]);

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
    <section className="flex h-full min-h-0 flex-col bg-[#0c100e] text-[#dfe8d1]">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-4 border-b border-[#1f2620] bg-[#101611] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="size-4 shrink-0 text-[#9bd56c]" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight text-[#e9f0db]">
              后台 PTY 终端
            </h2>
            <p className="truncate text-[11px] text-[#8f9a84]">
              {activeSession?.pid ? `PID ${activeSession.pid}` : "等待后台服务启动"} · Ctrl+C 复制选中内容
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button onClick={copySelection} size="sm" variant="outline">
            <Copy />
            复制
          </Button>
          <Button onClick={scrollToTail} size="sm" variant="outline">
            <ArrowDownToLine />
            底部
          </Button>
          <Button disabled={isRefreshing} onClick={refreshSessions} size="sm" variant="outline">
            {isRefreshing ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            附加
            <Kbd className="ml-1" keys="Mod+Shift+R" size="xs" tone="muted" />
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[#1f2620] bg-[#0f1411] px-3 py-2">
        {serviceTerminals.map((item) => {
          const session = sessionsRef.current.get(item.sessionId);
          const service = servicesById.get(item.serviceId);
          const selected = activeServiceId === item.serviceId;
          return (
            <button
              className={[
                "flex h-9 min-w-[174px] items-center justify-between gap-3 rounded-md border px-3 text-left transition-colors",
                selected
                  ? "border-[#5c7d45] bg-[#182217] text-[#eff8df]"
                  : "border-[#263027] bg-[#111711] text-[#aebaa6] hover:border-[#3b4939] hover:bg-[#151d15]",
              ].join(" ")}
              key={item.serviceId}
              onClick={() => selectService(item.serviceId)}
              type="button"
            >
              <span className="min-w-0 truncate text-xs font-semibold">{item.title}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Badge className="h-5 border-[#344132] bg-transparent px-1.5 text-[10px]" variant={serviceBadgeVariant(service)}>
                  {service?.status === "running" ? "服务运行" : service?.status === "error" ? "异常" : "未运行"}
                </Badge>
                <Badge className="h-5 border-[#344132] bg-[#121a12] px-1.5 text-[10px] text-[#b8ed88]" variant="outline">
                  {session ? statusText[session.status] : "无 PTY"}
                </Badge>
              </span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <div className="size-full overflow-hidden rounded-md border border-[#20281f] bg-[#0c100e] shadow-inner">
          {serviceTerminals.map((item) => (
            <div
              className={item.serviceId === activeServiceId ? "size-full" : "hidden"}
              key={item.sessionId}
              ref={setTerminalPane(item.sessionId)}
            />
          ))}
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-[#1f2620] bg-[#101611] px-4 font-mono text-[11px] text-[#8f9a84]">
        <span>{activeSession?.pid ? `pid ${activeSession.pid}` : "no pty"}</span>
        <span className="min-w-0 truncate pl-4 text-right">{activeService?.command?.[0] ?? "启动命令会在服务启动后显示"}</span>
      </div>
    </section>
  );
}
