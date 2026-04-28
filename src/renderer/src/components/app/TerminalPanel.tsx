import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Loader2, RotateCcw, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopBridge, PtySessionSnapshot, ServiceDescriptor, ServiceId } from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/use-shortcut";
import "@xterm/xterm/css/xterm.css";

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

const terminalTheme = {
  background: "#0c100e",
  foreground: "#dfe8d1",
  cursor: "#9bd56c",
  cursorAccent: "#0c100e",
  selectionBackground: "#9bd56c44",
  black: "#0c100e",
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
};

async function waitForDesktopBridge(timeoutMs = 2_500): Promise<DesktopBridge | null> {
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    if (window.maibotDesktop?.pty) {
      return window.maibotDesktop;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return window.maibotDesktop?.pty ? window.maibotDesktop : null;
}

function isLiveStatus(status?: PtySessionSnapshot["status"]): boolean {
  return status === "starting" || status === "running" || status === "stopping";
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

export function TerminalPanel({
  active = true,
  services = [],
}: {
  active?: boolean;
  services?: ServiceDescriptor[];
}): React.JSX.Element {
  const [activeServiceId, setActiveServiceId] = useState<ServiceId>("maibot");
  const [sessions, setSessions] = useState<Record<string, PtySessionSnapshot | undefined>>({});
  const [message, setMessage] = useState("正在准备后台 PTY 视图...");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const bridgeRef = useRef<DesktopBridge | null>(null);
  const activeServiceIdRef = useRef<ServiceId>("maibot");
  const sessionsRef = useRef<Record<string, PtySessionSnapshot | undefined>>({});

  const servicesById = useMemo(
    () => new Map<ServiceId, ServiceDescriptor>(services.map((service) => [service.id, service])),
    [services],
  );

  const activeTerminal = serviceTerminals.find((terminal) => terminal.serviceId === activeServiceId) ?? serviceTerminals[0];
  const activeSession = sessions[activeTerminal.sessionId];
  const activeService = servicesById.get(activeServiceId);

  const writeSystemLine = useCallback((line: string) => {
    terminalRef.current?.writeln(`\x1b[38;2;155;213;108m[desktop]\x1b[0m ${line}`);
  }, []);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return;
    }

    fitAddon.fit();

    const bridge = bridgeRef.current;
    const target = serviceTerminals.find((item) => item.serviceId === activeServiceIdRef.current) ?? serviceTerminals[0];
    const session = sessionsRef.current[target.sessionId];
    if (!bridge || !session || !isLiveStatus(session.status)) {
      return;
    }

    bridge.pty.resize({
      sessionId: session.id,
      cols: terminal.cols,
      rows: terminal.rows,
    });
  }, []);

  const renderServiceBuffer = useCallback(
    async (serviceId: ServiceId) => {
      const bridge = bridgeRef.current ?? window.maibotDesktop ?? null;
      const terminal = terminalRef.current;
      if (!bridge || !terminal) {
        return;
      }

      const target = serviceTerminals.find((item) => item.serviceId === serviceId) ?? serviceTerminals[0];
      terminal.reset();

      try {
        const sessionList = await bridge.pty.list();
        const nextSessions = Object.fromEntries(sessionList.map((session) => [session.id, session]));
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
        const session = sessionList.find((item) => item.id === target.sessionId);

        if (!session) {
          writeSystemLine(`${target.title} 尚未启动。请在左侧服务栏启动模块。`);
          setMessage(`${target.title} 未启动，等待后台 PTY 会话`);
          return;
        }

        const buffer = await bridge.pty.getBuffer(session.id);
        if (buffer.length > 0) {
          terminal.write(buffer);
        } else {
          writeSystemLine(`已附加到 ${target.title}，暂无输出。`);
        }
        setMessage(`已附加到 ${target.title}${session.pid ? `，PID ${session.pid}` : ""}`);
        fitAndResize();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        writeSystemLine(`附加失败: ${errorMessage}`);
        setMessage(errorMessage);
      }
    },
    [fitAndResize, writeSystemLine],
  );

  const refreshSessions = useCallback(async () => {
    const bridge = bridgeRef.current ?? window.maibotDesktop ?? null;
    if (!bridge) {
      setMessage("Electron preload bridge 不可用");
      return;
    }

    setIsRefreshing(true);
    try {
      await renderServiceBuffer(activeServiceIdRef.current);
    } finally {
      setIsRefreshing(false);
    }
  }, [renderServiceBuffer]);

  useEffect(() => {
    activeServiceIdRef.current = activeServiceId;
    void renderServiceBuffer(activeServiceId);
  }, [activeServiceId, renderServiceBuffer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "JetBrains Mono, SF Mono, Cascadia Mono, Menlo, Consolas, monospace",
      fontSize: 12.5,
      fontWeight: "400",
      lineHeight: 1.2,
      scrollback: 12000,
      tabStopWidth: 4,
      theme: terminalTheme,
      windowsPty: { backend: "conpty" },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    fitAddon.fit();
    writeSystemLine("后台 PTY 视图 ready");

    const resizeObserver = new ResizeObserver(() => {
      fitAndResize();
    });
    resizeObserver.observe(container);

    let cancelled = false;
    let unsubscribeData = (): void => undefined;
    let unsubscribeExit = (): void => undefined;
    let unsubscribeError = (): void => undefined;
    let unsubscribeSnapshot = (): void => undefined;

    const bindBridge = async (): Promise<void> => {
      setMessage("正在等待 Electron preload bridge...");
      const bridge = await waitForDesktopBridge();

      if (cancelled) {
        return;
      }

      if (!bridge) {
        terminal.writeln("\x1b[31m[desktop]\x1b[0m Electron preload bridge 不可用");
        setMessage("Electron preload bridge 不可用");
        return;
      }

      bridgeRef.current = bridge;
      writeSystemLine("Electron preload bridge connected");

      unsubscribeData = bridge.pty.onData((event) => {
        const target = serviceTerminals.find((item) => item.sessionId === event.sessionId);
        if (!target || target.serviceId !== activeServiceIdRef.current) {
          return;
        }

        terminal.write(event.data);
      });
      unsubscribeExit = bridge.pty.onExit((event) => {
        setSessions((current) => {
          const existing = current[event.sessionId];
          const next = existing
            ? {
                ...current,
                [event.sessionId]: {
                  ...existing,
                  status: "exited" as const,
                  exitCode: event.exitCode,
                  signal: event.signal,
                  endedAt: Date.now(),
                },
              }
            : current;
          sessionsRef.current = next;
          return next;
        });

        if (event.sessionId === serviceTerminals.find((item) => item.serviceId === activeServiceIdRef.current)?.sessionId) {
          terminal.writeln("");
          writeSystemLine(`process exited with code ${event.exitCode}`);
        }
      });
      unsubscribeError = bridge.pty.onError((event) => {
        if (event.sessionId === serviceTerminals.find((item) => item.serviceId === activeServiceIdRef.current)?.sessionId) {
          writeSystemLine(`error: ${event.message}`);
          setMessage(event.message);
        }
      });
      unsubscribeSnapshot = bridge.pty.onSnapshot((snapshot) => {
        setSessions((current) => {
          const next = { ...current, [snapshot.id]: snapshot };
          sessionsRef.current = next;
          return next;
        });
      });

      await renderServiceBuffer(activeServiceIdRef.current);
    };

    void bindBridge();

    return () => {
      cancelled = true;
      bridgeRef.current = null;
      unsubscribeData();
      unsubscribeExit();
      unsubscribeError();
      unsubscribeSnapshot();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [fitAndResize, renderServiceBuffer, writeSystemLine]);

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
            <p className="truncate text-[11px] text-[#8f9a84]">{message}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button disabled={isRefreshing} onClick={refreshSessions} size="sm" variant="outline">
            {isRefreshing ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            刷新附加
            <Kbd className="ml-1" keys="Mod+Shift+R" size="xs" tone="muted" />
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[#1f2620] bg-[#0f1411] px-3 py-2">
        {serviceTerminals.map((item) => {
          const session = sessions[item.sessionId];
          const service = servicesById.get(item.serviceId);
          const selected = activeServiceId === item.serviceId;
          return (
            <button
              className={[
                "flex h-9 min-w-[160px] items-center justify-between gap-3 rounded-md border px-3 text-left transition-colors",
                selected
                  ? "border-[#5c7d45] bg-[#182217] text-[#eff8df]"
                  : "border-[#263027] bg-[#111711] text-[#aebaa6] hover:border-[#3b4939] hover:bg-[#151d15]",
              ].join(" ")}
              key={item.serviceId}
              onClick={() => setActiveServiceId(item.serviceId)}
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
        <div className="size-full overflow-hidden rounded-md border border-[#20281f] bg-[#0c100e] p-2 shadow-inner">
          <div className="size-full" ref={containerRef} />
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-[#1f2620] bg-[#101611] px-4 font-mono text-[11px] text-[#8f9a84]">
        <span>{activeSession?.pid ? `pid ${activeSession.pid}` : "等待后台服务启动"}</span>
        <span>{activeService?.command?.[0] ?? "启动命令会在服务启动后显示"}</span>
      </div>
    </section>
  );
}
