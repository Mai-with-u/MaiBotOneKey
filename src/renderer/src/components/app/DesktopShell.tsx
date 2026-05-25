import {
  Code2,
  FolderOpen,
  GripHorizontal,
  Home,
  Loader2,
  MessageSquare,
  Play,
  Puzzle,
  Radar,
  RefreshCw,
  Server,
  Settings,
  Square,
  TerminalSquare,
} from "lucide-react";
import { type MouseEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  DesktopSnapshot,
  PluginBuilderMode,
  ServiceDescriptor,
  ServiceId,
  ServiceStatus,
  WindowState,
  WindowResizeEdge,
} from "@shared/contracts";
import { getDesktopSnapshot, normalizeDesktopSnapshot } from "@/lib/desktop-api";
import { useAppearance } from "@/lib/use-appearance";
import { useShortcut } from "@/lib/use-shortcut";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import maiMascotImage from "@/assets/mai2.png";
import { HomePanel } from "./HomePanel";
import { InitializationWizard } from "./InitializationWizard";
import { LiquidGlassLayer } from "./LiquidGlassLayer";
import { LocalChatPanel } from "./LocalChatPanel";
import { PluginBuilderPanel } from "./PluginBuilderPanel";
import { PluginMarketPanel } from "./PluginMarketPanel";
import { SettingsStatusPanel } from "./SettingsStatusPanel";
import { StartupAgreementDialog } from "./StartupAgreementDialog";
import { TerminalPanel } from "./TerminalPanel";
import { Titlebar } from "./Titlebar";
import { WebviewPanel } from "./WebviewPanel";

const statusText: Record<ServiceStatus, string> = {
  stopped: "未启动",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  error: "异常",
};

const statusDotColor: Record<ServiceStatus, string> = {
  stopped: "bg-muted-foreground/40",
  starting: "bg-warning",
  running: "bg-success",
  stopping: "bg-warning",
  error: "bg-destructive",
};

const PLUGIN_BUILDER_MODE_STORAGE_KEY = "maibot-onekey.plugin-builder-mode";
const OPENCODE_TERMINAL_SESSION_PREFIX = "user-terminal:opencode:";

function createOpenCodeSessionId(): string {
  const randomId =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${OPENCODE_TERMINAL_SESSION_PREFIX}${randomId}`;
}

function joinDesktopPath(platform: NodeJS.Platform | undefined, root: string, ...segments: string[]): string {
  const separator = platform === "win32" || root.includes("\\") ? "\\" : "/";
  const cleanRoot = root.replace(/[\\/]+$/u, "");
  const cleanSegments = segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/gu, ""));
  return [cleanRoot, ...cleanSegments].filter(Boolean).join(separator);
}

function opencodeExecutablePath(snapshot: DesktopSnapshot | null): string {
  const platform = snapshot?.platform;
  const filename = platform === "win32" ? "opencode.exe" : "opencode";
  return joinDesktopPath(platform, snapshot?.paths.runtimeRoot ?? "runtime", "opencode", filename);
}

function opencodeLaunchEnv(snapshot: DesktopSnapshot): Record<string, string> {
  const useBundledPluginInstructions = snapshot.openCodeSettings.useBundledPluginInstructions !== false;
  const config: { autoupdate: false; instructions?: string[] } = { autoupdate: false };
  const env: Record<string, string> = {};

  if (useBundledPluginInstructions) {
    config.instructions = [snapshot.paths.opencodePluginInstructionsPath];
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  }

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return env;
}

function readPluginBuilderMode(): PluginBuilderMode {
  if (typeof window === "undefined") {
    return "agent";
  }
  return window.localStorage.getItem(PLUGIN_BUILDER_MODE_STORAGE_KEY) === "nodes" ? "nodes" : "agent";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const resizeHandles: Array<{ edge: WindowResizeEdge; className: string }> = [
  { edge: "top", className: "inset-x-3 top-0 h-1.5 cursor-ns-resize" },
  { edge: "right", className: "inset-y-3 right-0 w-1.5 cursor-ew-resize" },
  { edge: "bottom", className: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize" },
  { edge: "left", className: "inset-y-3 left-0 w-1.5 cursor-ew-resize" },
  { edge: "top-left", className: "left-0 top-0 size-3 cursor-nwse-resize" },
  { edge: "top-right", className: "right-0 top-0 size-3 cursor-nesw-resize" },
  { edge: "bottom-right", className: "bottom-0 right-0 size-3 cursor-nwse-resize" },
  { edge: "bottom-left", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
];

function WindowResizeHandles(): React.JSX.Element {
  const resizingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);

  const startResize = useCallback((edge: WindowResizeEdge, event: PointerEvent<HTMLDivElement>) => {
    const bridge = window.maibotDesktop?.window;
    if (!bridge) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    resizingRef.current = true;
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    void bridge.startResize(edge, event.screenX, event.screenY);
  }, []);

  const resize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void window.maibotDesktop?.window.resizeTo(event.screenX, event.screenY);
  }, []);

  const finishResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }

    resizingRef.current = false;
    pointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
    void window.maibotDesktop?.window.finishResize();
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[80]">
      {resizeHandles.map((handle) => (
        <div
          className={cn("pointer-events-auto absolute", handle.className)}
          key={handle.edge}
          onPointerCancel={finishResize}
          onPointerDown={(event) => startResize(handle.edge, event)}
          onPointerMove={resize}
          onPointerUp={finishResize}
        />
      ))}
    </div>
  );
}

function ServiceControlButtons({
  service,
  busy,
  onStart,
  onStop,
  onRestart,
  className,
}: {
  service: ServiceDescriptor;
  busy: boolean;
  onStart: (id: ServiceId) => void;
  onStop: (id: ServiceId) => void;
  onRestart: (id: ServiceId) => void;
  className?: string;
}): React.JSX.Element {
  const isTransitioning =
    service.status === "starting" || service.status === "stopping" || busy;
  const isStarting = service.status === "starting";
  const canStart = service.status === "stopped" || service.status === "error";
  const canStop =
    service.status === "running" ||
    service.status === "starting" ||
    service.status === "error";
  const stopDisabled = !canStop || (busy && !isStarting) || service.status === "stopping";

  return (
    <div
      className={cn("flex shrink-0 items-center gap-0.5", className)}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`启动 ${service.name}`}
            disabled={!canStart || isTransitioning}
            onClick={() => onStart(service.id)}
            className="grid size-5 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy && canStart ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Play className="size-3" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>启动</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`停止 ${service.name}`}
            disabled={stopDisabled}
            onClick={() => onStop(service.id)}
            className="grid size-5 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Square className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>停止</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`重启 ${service.name}`}
            disabled={isTransitioning}
            onClick={() => onRestart(service.id)}
            className="grid size-5 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <RefreshCw className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>重启</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ServiceTabControls({
  service,
  busy,
  onStart,
  onStop,
  onRestart,
}: {
  service: ServiceDescriptor | undefined;
  busy: boolean;
  onStart: (id: ServiceId) => void;
  onStop: (id: ServiceId) => void;
  onRestart: (id: ServiceId) => void;
}): React.JSX.Element | null {
  if (!service) {
    return null;
  }

  return (
    <div className="flex h-full shrink-0 items-center border-l border-current/20 px-0.5">
      <ServiceControlButtons
        service={service}
        busy={busy}
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
      />
    </div>
  );
}

function FloatingShell({
  expanded,
  edge,
  liquidGlass,
  maibotService,
  onExpand,
  onCollapse,
  onRestore,
  onWindowState,
}: {
  expanded: boolean;
  edge: "left" | "right" | null;
  liquidGlass: boolean;
  maibotService: ServiceDescriptor | undefined;
  onExpand: () => void;
  onCollapse: () => void;
  onRestore: () => void;
  onWindowState: (state: WindowState) => void;
}): React.JSX.Element {
  const dragRef = useRef<{
    offsetX: number;
    offsetY: number;
    startScreenX: number;
    startScreenY: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  const dragRequestPendingRef = useRef(false);
  const dragPointRef = useRef<{
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
  } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);

  const updateFloatingState = useCallback((state?: WindowState) => {
    if (state) {
      onWindowState(state);
    }
  }, [onWindowState]);

  const suppressNextClickBriefly = useCallback(() => {
    suppressNextClickRef.current = true;
    window.setTimeout(() => {
      suppressNextClickRef.current = false;
    }, 250);
  }, []);

  const expandFromClick = useCallback((event: MouseEvent<HTMLElement>) => {
    if (suppressNextClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onExpand();
  }, [onExpand]);

  const flushDragMove = useCallback(() => {
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (dragRequestPendingRef.current) {
      return;
    }
    const point = dragPointRef.current;
    if (!point) {
      return;
    }
    dragPointRef.current = null;
    dragRequestPendingRef.current = true;
    void window.maibotDesktop?.window
      .moveFloatingTo(point.screenX, point.screenY, point.clientX, point.clientY)
      .then(updateFloatingState)
      .finally(() => {
        dragRequestPendingRef.current = false;
        flushDragMove();
      });
  }, [updateFloatingState]);

  const scheduleDragMove = useCallback(() => {
    if (dragFrameRef.current !== null) {
      return;
    }
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      flushDragMove();
    });
  }, [flushDragMove]);

  const startDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    dragRef.current = {
      offsetX: event.clientX,
      offsetY: event.clientY,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      moved: false,
      pointerId: event.pointerId,
    };
    dragPointRef.current = null;
  }, []);

  const cancelDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    dragPointRef.current = null;
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const drag = useCallback((event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    if (event.pointerType === "mouse" && (event.buttons & 1) !== 1) {
      cancelDrag(event);
      return;
    }
    const movedDistance = Math.hypot(event.screenX - current.startScreenX, event.screenY - current.startScreenY);
    if (movedDistance < 4) {
      return;
    }
    if (event.screenX === current.startScreenX && event.screenY === current.startScreenY) {
      return;
    }
    current.moved = true;
    dragPointRef.current = {
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: current.offsetX,
      clientY: current.offsetY,
    };
    scheduleDragMove();
  }, [cancelDrag, scheduleDragMove]);

  const finishDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    dragPointRef.current = null;
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current.moved) {
      suppressNextClickBriefly();
      void window.maibotDesktop?.window.finishFloatingDrag().then(updateFloatingState);
    }
  }, [suppressNextClickBriefly, updateFloatingState]);

  if (!expanded) {
    if (edge) {
      return (
        <div
          className={cn(
            "flex h-screen cursor-grab select-none items-center justify-center bg-transparent active:cursor-grabbing",
            edge === "left" ? "pl-0.5" : "pr-0.5",
          )}
          data-floating-shell="true"
          onClick={expandFromClick}
          onPointerCancel={(event) => finishDrag(event)}
          onPointerDown={startDrag}
          onPointerMove={drag}
          onPointerUp={(event) => finishDrag(event)}
          title="拖动悬浮条，点击展开"
        >
          <div
            className={cn(
              "grid h-24 w-6 place-items-center overflow-hidden rounded-full border border-primary/30 shadow-xl",
              liquidGlass ? "bg-transparent" : "bg-card",
            )}
            data-liquid-edge-chip={liquidGlass ? "true" : undefined}
          >
            <img
              alt=""
              className="h-14 max-w-none select-none object-cover"
              draggable={false}
              src={maiMascotImage}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="grid h-screen place-items-center bg-transparent" data-floating-shell="true">
        <button
          className={cn(
            "relative grid size-20 cursor-grab place-items-center overflow-hidden rounded-full border border-primary/30 shadow-xl active:cursor-grabbing",
            liquidGlass ? "bg-transparent" : "bg-card",
          )}
          data-app-region="no-drag"
          data-liquid-floating-orb={liquidGlass ? "true" : undefined}
          onClick={expandFromClick}
          onPointerCancel={(event) => finishDrag(event)}
          onPointerDown={startDrag}
          onPointerMove={drag}
          onPointerUp={(event) => finishDrag(event)}
          title="打开悬浮菜单"
          type="button"
        >
          <span className="absolute inset-x-3 bottom-1 h-7 rounded-full bg-primary/20 blur-md" />
          <img alt="" className="relative mt-3 w-20 select-none drop-shadow-xl" draggable={false} src={maiMascotImage} />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-screen min-h-0 flex-col overflow-hidden border border-border text-foreground shadow-2xl",
        liquidGlass ? "bg-transparent" : "bg-background",
      )}
      data-floating-shell="true"
      style={{
        borderRadius: "var(--app-window-radius, 16px)",
      }}
    >
      <div
        className={cn(
          "flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-border px-2 active:cursor-grabbing",
          liquidGlass ? "bg-transparent" : "bg-card",
        )}
        data-app-region="no-drag"
        data-liquid-titlebar={liquidGlass ? "true" : undefined}
        onPointerCancel={(event) => finishDrag(event)}
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={(event) => finishDrag(event)}
      >
        <GripHorizontal className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">MaiBot 悬浮球</span>
        <div
          className="flex shrink-0 items-center gap-1"
          data-app-region="no-drag"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Button className="h-7 px-2 text-[11px]" onClick={onCollapse} size="sm" variant="secondary">
            收起
          </Button>
          <Button className="h-7 px-2 text-[11px]" onClick={onRestore} size="sm" variant="default">
            展开
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <LocalChatPanel active maibotService={maibotService} />
      </div>
    </div>
  );
}

function PluginCodingAgentPanel({
  isStartingOpenCode,
  onStartOpenCode,
  openCodePath,
}: {
  isStartingOpenCode: boolean;
  onStartOpenCode: () => void;
  openCodePath: string;
}): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 overflow-auto px-6 py-6">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <Code2 className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">内置 Coding Agent</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  当前编写器默认使用代码代理模式，适合直接用自然语言描述插件需求。
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid min-h-[360px] flex-1 place-items-center rounded-lg border border-dashed border-border bg-card/70 p-6 text-center">
          <div className="max-w-md">
            <Code2 className="mx-auto size-8 text-primary" />
            <h3 className="mt-3 text-sm font-semibold">Coding Agent 工作区</h3>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              OpenCode 会在 MaiBot 目录中启动，终端页会自动切到对应会话。
            </p>
            <Button className="mt-4" disabled={isStartingOpenCode} onClick={onStartOpenCode} size="sm" variant="default">
              {isStartingOpenCode ? <Loader2 className="size-4 animate-spin" /> : <TerminalSquare className="size-4" />}
              启动 OpenCode
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function DesktopShell(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState("home");
  const [pluginMode, setPluginMode] = useState<"market" | "manage">("manage");
  const [pluginBuilderMode, setPluginBuilderModeState] = useState<PluginBuilderMode>(() => readPluginBuilderMode());
  const [isStartingOpenCode, setIsStartingOpenCode] = useState(false);
  const [terminalFocusSessionId, setTerminalFocusSessionId] = useState<string | null>(null);
  const [requestedConfigPluginId, setRequestedConfigPluginId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [floatingMode, setFloatingMode] = useState(false);
  const [floatingExpanded, setFloatingExpanded] = useState(false);
  const [floatingEdge, setFloatingEdge] = useState<"left" | "right" | null>(null);
  const appearance = useAppearance();
  const theme = useTheme();

  const setPluginBuilderMode = useCallback((mode: PluginBuilderMode) => {
    setPluginBuilderModeState(mode);
    window.localStorage.setItem(PLUGIN_BUILDER_MODE_STORAGE_KEY, mode);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const next = await getDesktopSnapshot();
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    let mounted = true;
    refreshSnapshot().then((next) => {
      if (mounted) setSnapshot(next);
    });

    const offSnapshot = window.maibotDesktop?.onSnapshot((next) => {
      setSnapshot(normalizeDesktopSnapshot(next));
    });
    const offServices = window.maibotDesktop?.services.onSnapshot((services) => {
      setSnapshot((current) => (current ? { ...current, services } : current));
    });
    const offLogs = window.maibotDesktop?.logs.onEntry((entry) => {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              recentLogs: [...(current.recentLogs ?? []), entry].slice(-1000),
            }
          : current,
      );
    });
    window.maibotDesktop?.window.getState().then((state) => {
      if (mounted) {
        setFloatingMode(state.isFloating === true);
        setFloatingEdge(state.floatingEdge ?? null);
      }
    });
    const offWindowState = window.maibotDesktop?.window.onState((state) => {
      if (typeof state.isFloating === "boolean") {
        setFloatingMode(state.isFloating);
      }
      setFloatingEdge(state.floatingEdge ?? null);
    });

    return () => {
      mounted = false;
      offSnapshot?.();
      offServices?.();
      offLogs?.();
      offWindowState?.();
    };
  }, [refreshSnapshot]);

  const services = snapshot?.services ?? [];
  const messagePlatformReady =
    snapshot?.initState.messagePlatformConfigured === true &&
    Boolean(snapshot.initState.qqAccount?.trim());
  const serviceById = useMemo(
    () => new Map(services.map((s) => [s.id, s])),
    [services],
  );
  const maibotService = serviceById.get("maibot");
  const qqBackendService = serviceById.get("napcat");
  const showQqBackendTab = messagePlatformReady && Boolean(qqBackendService);
  const qqBackendDefaultUrl =
    snapshot?.initState.qqBackend === "snowluma" ? "http://127.0.0.1:5099" : "http://127.0.0.1:6099/webui";
  const showTerminalTab = snapshot?.terminalSettings.useEmbeddedTerminal === true;
  const openCodePath = useMemo(() => opencodeExecutablePath(snapshot), [snapshot]);
  const canInterruptStartup =
    actionBusy === "all:start" ||
    services.some((service) => service.status === "starting");

  const openLogs = useCallback(() => {
    void window.maibotDesktop?.openLogsDirectory();
  }, []);

  const runServiceAction = useCallback(
    async (
      key: string,
      action: () => Promise<ServiceDescriptor | ServiceDescriptor[]>,
    ) => {
      setActionBusy(key);
      setActionError(null);
      try {
        const result = await action();
        const next = Array.isArray(result) ? result : [result];
        setSnapshot((current) => {
          if (!current) return current;
          const byId = new Map(current.services.map((s) => [s.id, s]));
          for (const s of next) byId.set(s.id, s);
          return {
            ...current,
            services: current.services.map((s) => byId.get(s.id) ?? s),
          };
        });
        await refreshSnapshot();
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setActionBusy(null);
      }
    },
    [refreshSnapshot],
  );

  const startAll = useCallback(() => {
    void runServiceAction(
      "all:start",
      async () => window.maibotDesktop?.services.startAll() ?? [],
    );
  }, [runServiceAction]);
  const stopAll = useCallback(() => {
    void runServiceAction(
      "all:stop",
      async () => window.maibotDesktop?.services.stopAll() ?? [],
    );
  }, [runServiceAction]);
  const startService = useCallback(
    (id: ServiceId) =>
      void runServiceAction(`${id}:start`, async () => {
        if (!window.maibotDesktop) throw new Error("Electron bridge 未连接");
        return window.maibotDesktop.services.start(id);
      }),
    [runServiceAction],
  );
  const stopService = useCallback(
    (id: ServiceId) =>
      void runServiceAction(`${id}:stop`, async () => {
        if (!window.maibotDesktop) throw new Error("Electron bridge 未连接");
        return window.maibotDesktop.services.stop(id);
      }),
    [runServiceAction],
  );
  const restartService = useCallback(
    (id: ServiceId) =>
      void runServiceAction(`${id}:restart`, async () => {
        if (!window.maibotDesktop) throw new Error("Electron bridge 未连接");
        return window.maibotDesktop.services.restart(id);
      }),
    [runServiceAction],
  );

  const enterFloatingMode = useCallback(() => {
    setFloatingExpanded(false);
    setFloatingEdge(null);
    void window.maibotDesktop?.window.setFloatingMode(true).then((state) => {
      setFloatingMode(state.isFloating === true);
      setFloatingEdge(state.floatingEdge ?? null);
    });
  }, []);

  const setFloatingPanel = useCallback((expanded: boolean) => {
    setFloatingExpanded(expanded);
    if (expanded) {
      setFloatingEdge(null);
    }
    void window.maibotDesktop?.window.setFloatingPanelExpanded(expanded).then((state) => {
      setFloatingEdge(state.floatingEdge ?? null);
    });
  }, []);

  const restoreMainWindow = useCallback(() => {
    setFloatingExpanded(false);
    setFloatingEdge(null);
    void window.maibotDesktop?.window.setFloatingMode(false).then((state) => {
      setFloatingMode(state.isFloating === true);
      setFloatingEdge(state.floatingEdge ?? null);
    });
  }, []);

  const syncWindowState = useCallback((state: WindowState) => {
    setFloatingMode(state.isFloating === true);
    setFloatingEdge(state.floatingEdge ?? null);
  }, []);

  const selectTab = useCallback((value: string) => {
    if (value === "terminal" && !showTerminalTab) {
      setActiveTab("home");
      return;
    }
    if (value === "qqbackend" && !showQqBackendTab) {
      setActiveTab("home");
      return;
    }
    if (value === "pluginmarket") {
      setPluginMode("market");
      setActiveTab("plugins");
      return;
    }
    if (value === "pluginmanage") {
      setPluginMode("manage");
      setActiveTab("plugins");
      return;
    }
    if (value === "pluginbuilder") {
      setActiveTab("pluginbuilder");
      return;
    }
    setActiveTab(value);
  }, [showQqBackendTab, showTerminalTab]);

  const openPluginConfig = useCallback((pluginId: string) => {
    setPluginMode("manage");
    setRequestedConfigPluginId(pluginId);
    setActiveTab("plugins");
  }, []);

  const openTerminalSession = useCallback((sessionId: string) => {
    setTerminalFocusSessionId(sessionId);
    setActiveTab("terminal");
  }, []);

  const startOpenCode = useCallback(async () => {
    const bridge = window.maibotDesktop;
    if (!bridge?.pty) {
      toast.error("Electron 终端桥接未连接");
      return;
    }
    if (!snapshot) {
      toast.error("桌面状态还没有准备好");
      return;
    }
    if (snapshot.terminalSettings.useEmbeddedTerminal !== true) {
      toast.error("请先在设置中启用内嵌终端");
      return;
    }

    setIsStartingOpenCode(true);
    try {
      const session = await bridge.pty.start({
        id: createOpenCodeSessionId(),
        title: "OpenCode 编写器",
        cwd: snapshot.paths.maibotRoot,
        command: [openCodePath, snapshot.paths.maibotRoot],
        encoding: "utf8",
        env: opencodeLaunchEnv(snapshot),
      });
      openTerminalSession(session.id);
      toast.success("OpenCode 已在终端中启动");
    } catch (error) {
      toast.error(`OpenCode 启动失败：${errorMessage(error)}`);
    } finally {
      setIsStartingOpenCode(false);
    }
  }, [openCodePath, openTerminalSession, snapshot]);

  useEffect(() => {
    if (activeTab === "terminal" && !showTerminalTab) {
      setActiveTab("home");
    }
    if (activeTab === "qqbackend" && !showQqBackendTab) {
      setActiveTab("home");
    }
  }, [activeTab, showQqBackendTab, showTerminalTab]);

  // Global shortcuts
  useShortcut("Mod+L", openLogs);
  useShortcut("Mod+Shift+S", startAll);
  useShortcut("Mod+Shift+X", stopAll);
  useShortcut("Mod+Shift+L", theme.toggle);

  if (floatingMode) {
    return (
      <TooltipProvider delayDuration={250}>
        {floatingExpanded ? (
          <LiquidGlassLayer
            dark={theme.resolved === "dark"}
            enabled={appearance.liquidGlass}
          />
        ) : null}
        <FloatingShell
          edge={floatingEdge}
          expanded={floatingExpanded}
          liquidGlass={appearance.liquidGlass}
          maibotService={maibotService}
          onCollapse={() => setFloatingPanel(false)}
          onExpand={() => setFloatingPanel(true)}
          onRestore={restoreMainWindow}
          onWindowState={syncWindowState}
        />
        <Toaster />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={250}>
      <WindowResizeHandles />
      <div
        className={cn(
          "relative flex h-screen min-h-0 flex-col overflow-hidden text-foreground",
          appearance.liquidGlass ? "bg-transparent" : "bg-background",
        )}
        data-liquid-shell={appearance.liquidGlass ? "true" : undefined}
        style={{
          borderRadius: "var(--app-window-radius, 16px)",
        }}
      >
        <LiquidGlassLayer
          dark={theme.resolved === "dark"}
          enabled={appearance.liquidGlass}
        />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <Titlebar
            appVersion={snapshot?.appVersion ?? "0.1.0"}
            liquidGlass={appearance.liquidGlass}
            theme={theme}
          />

          {actionError ? (
            <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-[12px] text-destructive">
              {actionError}
            </div>
          ) : null}

          {/* Main */}
          <main className="flex min-h-0 flex-1 flex-col">
            <Tabs
              value={activeTab}
              onValueChange={selectTab}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div
                className={cn(
                  "flex h-10 shrink-0 items-center gap-3 border-b border-border px-3",
                  appearance.liquidGlass ? "bg-transparent" : "bg-card",
                )}
                data-liquid-band={appearance.liquidGlass ? "true" : undefined}
              >
                <TabsList className="h-8 bg-card">
                  <TabsTrigger value="home" className="gap-1.5">
                    <Home />
                    首页
                  </TabsTrigger>
                  <div
                    className={cn(
                      "flex h-7 shrink-0 items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground/90",
                      activeTab === "maibot" && "border-primary/45 bg-primary/15 text-primary shadow-sm",
                    )}
                  >
                    <TabsTrigger
                      value="maibot"
                      className="h-full flex-none gap-1.5 border-0 bg-transparent px-2.5 text-inherit hover:text-inherit data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:text-inherit data-[state=active]:shadow-none"
                    >
                      <Radar />
                      MaiBot
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          maibotService ? statusDotColor[maibotService.status] : "bg-muted-foreground/30",
                        )}
                      />
                      <span className="hidden shrink-0 text-[10.5px] font-normal text-muted-foreground tabular-nums xl:inline">
                        {maibotService ? statusText[maibotService.status] : "未发现"}
                      </span>
                    </TabsTrigger>
                    <ServiceTabControls
                      service={maibotService}
                      busy={actionBusy?.startsWith("maibot:") ?? false}
                      onStart={startService}
                      onStop={stopService}
                      onRestart={restartService}
                    />
                  </div>
                  <TabsTrigger value="localchat" className="gap-1.5">
                    <MessageSquare />
                    聊聊
                  </TabsTrigger>
                  {showTerminalTab ? (
                    <TabsTrigger value="terminal" className="gap-1.5">
                      <TerminalSquare />
                      终端
                    </TabsTrigger>
                  ) : null}
                  <TabsTrigger value="plugins" className="gap-1.5">
                    <Puzzle />
                    插件
                  </TabsTrigger>
                  <TabsTrigger value="pluginbuilder" className="gap-1.5">
                    <Code2 />
                    编写器
                  </TabsTrigger>
                  {showQqBackendTab ? (
                    <div
                      className={cn(
                        "flex h-7 shrink-0 items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground/90",
                        activeTab === "qqbackend" && "border-primary/45 bg-primary/15 text-primary shadow-sm",
                      )}
                    >
                      <TabsTrigger
                        value="qqbackend"
                        className="h-full flex-none gap-1.5 border-0 bg-transparent px-2.5 text-inherit hover:text-inherit data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:text-inherit data-[state=active]:shadow-none"
                      >
                        <Server />
                        {qqBackendService?.name ?? "QQ 后端"}
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            qqBackendService ? statusDotColor[qqBackendService.status] : "bg-muted-foreground/30",
                          )}
                        />
                        <span className="hidden shrink-0 text-[10.5px] font-normal text-muted-foreground tabular-nums xl:inline">
                          {qqBackendService ? statusText[qqBackendService.status] : "未发现"}
                        </span>
                      </TabsTrigger>
                      <ServiceTabControls
                        service={qqBackendService}
                        busy={actionBusy?.startsWith("napcat:") ?? false}
                        onStart={startService}
                        onStop={stopService}
                        onRestart={restartService}
                      />
                    </div>
                  ) : null}
                </TabsList>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="h-7 px-2.5 text-[11px]"
                      onClick={() => selectTab("settings")}
                      size="sm"
                      variant={activeTab === "settings" ? "default" : "secondary"}
                    >
                      <Settings />
                      设置
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    设置
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="default"
                      onClick={startAll}
                      disabled={actionBusy !== null}
                      className="h-7 px-2.5 text-[11px]"
                    >
                      {actionBusy === "all:start" ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Play />
                      )}
                      启动全部
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="flex items-center gap-1">
                      启动全部服务 <Kbd keys="Mod+Shift+S" size="xs" tone="inverse" />
                    </span>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={stopAll}
                      disabled={actionBusy !== null && !canInterruptStartup}
                      className="h-7 px-2 text-[11px]"
                    >
                      {actionBusy === "all:stop" ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Square />
                      )}
                      停止
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="flex items-center gap-1">
                      停止全部 <Kbd keys="Mod+Shift+X" size="xs" tone="inverse" />
                    </span>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={openLogs}
                      className="h-7 px-2 text-[11px]"
                    >
                      <FolderOpen />
                      日志
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="flex items-center gap-1">
                      打开日志目录 <Kbd keys="Mod+L" size="xs" tone="inverse" />
                    </span>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <TabsContent value="home" className="min-h-0 flex-1 outline-none">
              {snapshot ? (
                <HomePanel
                  active={activeTab === "home"}
                  onEnterFloatingMode={enterFloatingMode}
                  onOpenPluginConfig={openPluginConfig}
                  onOpenTab={selectTab}
                  onSnapshot={setSnapshot}
                  snapshot={snapshot}
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在读取首页状态
                  </span>
                </div>
              )}
            </TabsContent>

            <TabsContent
              forceMount
              value="maibot"
              className="min-h-0 flex-1 outline-none data-[state=inactive]:hidden"
            >
              <WebviewPanel
                active={activeTab === "maibot"}
                emptyText="MaiBot Core 启动后会在这里载入官方 WebUI。"
                title="MaiBot WebUI"
                url={maibotService?.url ?? "http://127.0.0.1:8001"}
              />
            </TabsContent>

            <TabsContent
              forceMount
              value="localchat"
              className="min-h-0 flex-1 outline-none data-[state=inactive]:hidden"
            >
              <LocalChatPanel
                active={activeTab === "localchat"}
                maibotService={maibotService}
              />
            </TabsContent>

            {showTerminalTab ? (
              <TabsContent
                forceMount
                value="terminal"
                className="min-h-0 flex-1 outline-none data-[state=inactive]:hidden"
              >
                <TerminalPanel
                  active={activeTab === "terminal"}
                  recentLogs={snapshot?.recentLogs ?? []}
                  requestedSessionId={terminalFocusSessionId}
                  services={services}
                  terminalSettings={snapshot?.terminalSettings}
                  maibotRoot={snapshot?.paths.maibotRoot}
                />
              </TabsContent>
            ) : null}

            <TabsContent
              value="plugins"
              className="min-h-0 flex-1 overflow-hidden outline-none"
            >
              <PluginMarketPanel
                maibotService={maibotService}
                maibotVersion={snapshot?.moduleVersions.maibotLocal}
                mode={pluginMode}
                onModeChange={setPluginMode}
                onRequestedConfigHandled={() => setRequestedConfigPluginId(null)}
                requestedConfigPluginId={requestedConfigPluginId}
              />
            </TabsContent>

            <TabsContent
              value="pluginbuilder"
              className="min-h-0 flex-1 overflow-hidden outline-none"
            >
              {pluginBuilderMode === "nodes" ? (
                <PluginBuilderPanel
                  isStartingOpenCode={isStartingOpenCode}
                  onStartOpenCode={startOpenCode}
                  openCodePath={openCodePath}
                />
              ) : (
                <PluginCodingAgentPanel
                  isStartingOpenCode={isStartingOpenCode}
                  onStartOpenCode={startOpenCode}
                  openCodePath={openCodePath}
                />
              )}
            </TabsContent>

            {showQqBackendTab ? (
              <TabsContent
                forceMount
                value="qqbackend"
                className="min-h-0 flex-1 outline-none data-[state=inactive]:hidden"
              >
                <WebviewPanel
                  active={activeTab === "qqbackend"}
                  emptyText={`${qqBackendService?.name ?? "QQ 后端"} 启动后会在这里载入 WebUI。`}
                  title={`${qqBackendService?.name ?? "QQ 后端"} WebUI`}
                  url={qqBackendService?.url ?? qqBackendDefaultUrl}
                />
              </TabsContent>
            ) : null}

            <TabsContent
              value="settings"
              className="min-h-0 flex-1 overflow-hidden outline-none"
            >
              {snapshot ? (
                <SettingsStatusPanel
                  onOpenPluginConfig={openPluginConfig}
                  onSnapshot={setSnapshot}
                  onPluginBuilderModeChange={setPluginBuilderMode}
                  pluginBuilderMode={pluginBuilderMode}
                  snapshot={snapshot}
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在读取桌面状态…
                  </span>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </main>

        {snapshot ? (
          <StartupAgreementDialog onSnapshot={setSnapshot} snapshot={snapshot} />
        ) : null}
        {snapshot ? (
          <InitializationWizard onOpenTab={setActiveTab} onSnapshot={setSnapshot} snapshot={snapshot} />
        ) : null}
          <Toaster />
        </div>
      </div>
    </TooltipProvider>
  );
}
