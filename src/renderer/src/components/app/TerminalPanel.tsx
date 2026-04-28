import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Ban, Eraser, Play, RotateCcw, Square, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge, PtySessionSnapshot } from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/use-shortcut";
import "@xterm/xterm/css/xterm.css";

const TERMINAL_SESSION_ID = "maibot-desktop-shell";
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 32;

const statusText: Record<PtySessionSnapshot["status"], string> = {
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  exited: "已退出",
  error: "异常",
};

const terminalTheme = {
  background: "#0f1411",
  foreground: "#dfe8d1",
  cursor: "#9bd56c",
  cursorAccent: "#0f1411",
  selectionBackground: "#9bd56c44",
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

export function TerminalPanel({ active = true }: { active?: boolean }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const bridgeRef = useRef<DesktopBridge | null>(null);
  const isStartingRef = useRef(false);
  const [snapshot, setSnapshot] = useState<PtySessionSnapshot | null>(null);
  const [message, setMessage] = useState("正在准备 PTY bridge...");
  const [isStarting, setIsStarting] = useState(false);

  const writeSystemLine = useCallback((line: string) => {
    terminalRef.current?.writeln(`\x1b[38;2;155;213;108m[desktop]\x1b[0m ${line}`);
  }, []);

  const resizeCurrentSession = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const sessionId = sessionIdRef.current;

    if (!terminal || !fitAddon) {
      return;
    }

    fitAddon.fit();

    const bridge = bridgeRef.current ?? window.maibotDesktop ?? null;
    if (!sessionId || !bridge) {
      return;
    }

    bridge.pty.resize({
      sessionId,
      cols: terminal.cols,
      rows: terminal.rows,
    });
  }, []);

  const startSession = useCallback(async () => {
    const bridge = bridgeRef.current ?? window.maibotDesktop ?? null;
    if (!bridge || isStartingRef.current) {
      if (!bridge) {
        setMessage("Electron preload bridge 不可用");
        writeSystemLine("Electron preload bridge is not available");
      }
      return;
    }

    isStartingRef.current = true;
    setIsStarting(true);
    setMessage("正在启动 PTY 会话...");

    try {
      const dimensions = fitAddonRef.current?.proposeDimensions();
      const desktopSnapshot = await bridge.getSnapshot();
      const nextSnapshot = await bridge.pty.start({
        id: TERMINAL_SESSION_ID,
        title: "MaiBot 管理终端",
        cwd: desktopSnapshot.paths.installRoot,
        cols: dimensions?.cols ?? terminalRef.current?.cols ?? DEFAULT_COLS,
        rows: dimensions?.rows ?? terminalRef.current?.rows ?? DEFAULT_ROWS,
        encoding: "auto",
      });

      sessionIdRef.current = nextSnapshot.id;
      setSnapshot(nextSnapshot);
      setMessage(`PTY 已启动，PID ${nextSnapshot.pid ?? "未知"}`);
      writeSystemLine(`PTY started, pid=${nextSnapshot.pid ?? "unknown"}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setMessage(errorMessage);
      writeSystemLine(`start failed: ${errorMessage}`);
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
    }
  }, [writeSystemLine]);

  const stopSession = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const bridge = bridgeRef.current ?? window.maibotDesktop ?? null;
    if (!sessionId || !bridge) {
      return;
    }

    setMessage("正在温和停止 PTY，会在 10 秒后强制结束...");
    await bridge.pty.stop({
      sessionId,
      forceAfterMs: 10_000,
    });
  }, []);

  const killSession = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const bridge = bridgeRef.current ?? window.maibotDesktop ?? null;
    if (!sessionId || !bridge) {
      return;
    }

    setMessage("正在强制结束 PTY 进程树...");
    await bridge.pty.kill(sessionId);
  }, []);

  const clearTerminal = useCallback(async () => {
    terminalRef.current?.clear();

    const sessionId = sessionIdRef.current;
    const bridge = bridgeRef.current ?? window.maibotDesktop ?? null;
    if (sessionId && bridge) {
      try {
        await bridge.pty.clear(sessionId);
      } catch {
        sessionIdRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: false,
      fontFamily: "Cascadia Mono, JetBrains Mono, Consolas, monospace",
      fontSize: 13,
      fontWeight: "400",
      lineHeight: 1.18,
      scrollback: 8000,
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

    terminal.writeln("\x1b[38;2;155;213;108m[desktop]\x1b[0m PTY bridge ready");

    const terminalInput = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      const bridge = bridgeRef.current;
      if (!sessionId || !bridge) {
        return;
      }

      bridge.pty.input({
        sessionId,
        data,
      });
    });

    const terminalResize = terminal.onResize(({ cols, rows }) => {
      const sessionId = sessionIdRef.current;
      const bridge = bridgeRef.current;
      if (!sessionId || !bridge) {
        return;
      }

      bridge.pty.resize({
        sessionId,
        cols,
        rows,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      resizeCurrentSession();
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
      terminal.writeln("\x1b[38;2;155;213;108m[desktop]\x1b[0m Electron preload bridge connected");
      setMessage("PTY bridge 已连接，正在附加会话...");

      unsubscribeData = bridge.pty.onData((event) => {
        if (event.sessionId === sessionIdRef.current) {
          terminal.write(event.data);
        }
      });
      unsubscribeExit = bridge.pty.onExit((event) => {
        if (event.sessionId !== sessionIdRef.current) {
          return;
        }

        setMessage(`PTY 已退出，exit=${event.exitCode}${event.signal ? ` signal=${event.signal}` : ""}`);
        terminal.writeln("");
        writeSystemLine(`process exited with code ${event.exitCode}`);
      });
      unsubscribeError = bridge.pty.onError((event) => {
        if (event.sessionId === sessionIdRef.current) {
          setMessage(event.message);
          writeSystemLine(`error: ${event.message}`);
        }
      });
      unsubscribeSnapshot = bridge.pty.onSnapshot((nextSnapshot) => {
        if (nextSnapshot.id !== sessionIdRef.current && nextSnapshot.id !== TERMINAL_SESSION_ID) {
          return;
        }

        sessionIdRef.current = nextSnapshot.id;
        setSnapshot(nextSnapshot);
      });

      try {
        const sessions = await bridge.pty.list();
        if (cancelled) {
          return;
        }

        const existing = sessions.find((session) => session.id === TERMINAL_SESSION_ID);
        if (!existing) {
          await startSession();
          return;
        }

        if (existing.status === "exited" || existing.status === "error") {
          sessionIdRef.current = null;
          setSnapshot(existing);
          setMessage("旧 PTY 会话已结束，正在启动新会话...");
          await startSession();
          return;
        }

        sessionIdRef.current = existing.id;
        setSnapshot(existing);
        setMessage(`已附加到 PTY，PID ${existing.pid ?? "未知"}`);
        const buffer = await bridge.pty.getBuffer(existing.id);
        if (buffer) {
          terminal.write(buffer);
        } else {
          writeSystemLine(`attached to existing session, pid=${existing.pid ?? "unknown"}`);
        }
        resizeCurrentSession();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setMessage(errorMessage);
        writeSystemLine(`attach failed: ${errorMessage}`);
      }
    };

    void bindBridge();

    return () => {
      cancelled = true;
      if (bridgeRef.current === window.maibotDesktop) {
        bridgeRef.current = null;
      }
      unsubscribeData();
      unsubscribeExit();
      unsubscribeError();
      unsubscribeSnapshot();
      resizeObserver.disconnect();
      terminalInput.dispose();
      terminalResize.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [resizeCurrentSession, startSession, writeSystemLine]);

  const status = snapshot?.status ?? "starting";
  const canStart = !snapshot || snapshot.status === "exited" || snapshot.status === "error";
  const canStop = snapshot?.status === "running";
  const canKill = snapshot?.status === "running" || snapshot?.status === "stopping";

  useShortcut("Mod+Enter", () => startSession(), { enabled: active && canStart && !isStarting });
  useShortcut("Mod+Period", () => stopSession(), { enabled: active && canStop });
  useShortcut("Mod+Shift+Period", () => killSession(), { enabled: active && canKill });
  useShortcut("Mod+K", () => clearTerminal(), { enabled: active, allowInEditable: true });
  useShortcut("Mod+Shift+R", () => resizeCurrentSession(), { enabled: active });

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0f1411] text-[#dfe8d1]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#1f2620] bg-[#11150f] px-4">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="size-4 text-[#9bd56c]" />
          <h2 className="shrink-0 text-sm font-semibold tracking-tight text-[#e9f0db]">
            PTY 实时终端
          </h2>
          <Badge className="border-[#3a4434] bg-[#172017] text-[#b8ed88]" variant="outline">
            {statusText[status]}
          </Badge>
          <span className="truncate font-mono text-xs text-[#8f9a84]">
            {snapshot?.pid ? `pid ${snapshot.pid}` : message}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button disabled={!canStart || isStarting} onClick={startSession} size="sm" variant="outline">
            <Play />
            启动
            <Kbd className="ml-1" keys="Mod+Enter" size="xs" tone="muted" />
          </Button>
          <Button disabled={!canStop} onClick={stopSession} size="sm" variant="outline">
            <Square />
            停止
            <Kbd className="ml-1" keys="Mod+." size="xs" tone="muted" />
          </Button>
          <Button disabled={!canKill} onClick={killSession} size="sm" variant="outline">
            <Ban />
            强杀
            <Kbd className="ml-1" keys="Mod+Shift+." size="xs" tone="muted" />
          </Button>
          <Button onClick={clearTerminal} size="icon" title="清屏 (Mod+K)" variant="ghost">
            <Eraser />
          </Button>
          <Button onClick={resizeCurrentSession} size="icon" title="重新适配尺寸 (Mod+Shift+R)" variant="ghost">
            <RotateCcw />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <div
          className="size-full overflow-hidden rounded-md border border-[#20281f] bg-[#0f1411] p-2 shadow-inner"
          ref={containerRef}
        />
      </div>
    </section>
  );
}
