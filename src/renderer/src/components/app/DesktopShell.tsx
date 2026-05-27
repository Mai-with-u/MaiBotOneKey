import {
  ChevronDown,
  Code2,
  GripHorizontal,
  Home,
  Info,
  ListTree,
  Loader2,
  MessageSquare,
  Play,
  Puzzle,
  Radar,
  RefreshCw,
  Settings,
  Square,
  TerminalSquare,
} from "lucide-react";
import { type FocusEvent, type MouseEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
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
import { LocalChatPanel } from "./LocalChatPanel";
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

const statusColor: Record<ServiceStatus, string> = {
  stopped: "var(--retro-ink, var(--muted-foreground))",
  starting: "var(--warning)",
  running: "var(--retro-rust, var(--success))",
  stopping: "var(--warning)",
  error: "var(--destructive)",
};

const PLUGIN_BUILDER_MODE_STORAGE_KEY = "maibot-onekey.plugin-builder-mode";
const OPENCODE_TERMINAL_SESSION_PREFIX = "user-terminal:opencode:";
const toolbarMenuItemClassName =
  "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
const retroTopActionIconClassName =
  "[&_svg]:!size-6 [&_svg]:fill-none [&_svg]:stroke-[3] [&_svg]:[stroke-linecap:square] [&_svg]:[stroke-linejoin:miter]";

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
  const mode = window.localStorage.getItem(PLUGIN_BUILDER_MODE_STORAGE_KEY);
  return mode === "disabled" ? "disabled" : "agent";
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
      {canStart ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`启动 ${service.name}`}
              disabled={isTransitioning}
              onClick={() => onStart(service.id)}
              className="grid size-5 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Play className="size-3" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>启动</TooltipContent>
        </Tooltip>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

function ServiceTabControls({
  service,
  busy,
  retro,
  onStart,
  onStop,
  onRestart,
}: {
  service: ServiceDescriptor | undefined;
  busy: boolean;
  retro: boolean;
  onStart: (id: ServiceId) => void;
  onStop: (id: ServiceId) => void;
  onRestart: (id: ServiceId) => void;
}): React.JSX.Element | null {
  if (!service) {
    return null;
  }

  return (
    <div className={cn("flex h-full shrink-0 items-center pl-0.5 pr-2.5", !retro && "border-l border-current/20")}>
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

function MaiBotOfflineIllustration({ waiting }: { waiting: boolean }): React.JSX.Element {
  return (
    <svg
      aria-hidden
      className="mx-auto h-auto w-[min(385px,52vw)] text-[var(--retro-ink,var(--foreground))]"
      fill="none"
      viewBox="0 0 320 220"
    >
      <defs>
        <linearGradient id="maibot-offline-screen" x1="76" x2="244" y1="46" y2="128" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--retro-ink, currentColor)" stopOpacity=".98" />
          <stop offset="1" stopColor="var(--retro-ink, currentColor)" stopOpacity=".88" />
        </linearGradient>
      </defs>
      <rect
        fill="var(--retro-recessed, transparent)"
        fillOpacity=".9"
        height="150"
        rx="6"
        stroke="currentColor"
        strokeWidth="1.75"
        width="238"
        x="41"
        y="18"
      />
      <rect
        fill="url(#maibot-offline-screen)"
        height="130"
        rx="5"
        width="216"
        x="52"
        y="27"
      />
      {waiting ? (
        <path
          className="animate-pulse"
          d="M60 90h25c5 0 7-6 11-6 5 0 7 17 13 17 7 0 9-31 17-31 8 0 11 41 20 41 8 0 11-55 21-55 9 0 13 45 22 45 7 0 9-21 16-21 5 0 7 10 12 10h47"
          stroke="var(--retro-paper-soft,var(--background))"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity=".32"
          strokeWidth="2.5"
        />
      ) : null}
      <path
        d="M60 90h204"
        stroke="var(--retro-paper-soft,var(--background))"
        strokeDasharray="12 9"
        strokeLinecap="round"
        strokeOpacity=".24"
        strokeWidth="3"
      />
      <path d="M93 168v12M227 168v12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" />
      <rect
        fill="var(--retro-recessed, transparent)"
        fillOpacity=".9"
        height="30"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.75"
        width="238"
        x="41"
        y="180"
      />
      {[60, 78, 96, 114].map((x) => (
        <path d={`M${x} 189h9`} key={x} stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
      ))}
      {[60, 78, 96, 114].map((x) => (
        <path d={`M${x} 199h9`} key={x} stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
      ))}
      <circle cx="222" cy="194" fill="currentColor" r="4.2" />
      <circle cx="241" cy="194" fill="currentColor" r="4.2" />
      <circle fill="var(--retro-rust, var(--primary))" cx="263" cy="194" r="7.5" />
    </svg>
  );
}

function MaiBotWebuiStatusPanel({
  service,
  busy,
  onStart,
  retro,
}: {
  service: ServiceDescriptor | undefined;
  busy: boolean;
  onStart: (id: ServiceId) => void;
  retro: boolean;
}): React.JSX.Element {
  const status = service?.status ?? "stopped";
  const health = service?.health ?? "unknown";
  const [showWebUiUnavailable, setShowWebUiUnavailable] = useState(false);
  const webUiUnreachable = status === "running" && health === "unreachable";

  useEffect(() => {
    if (!webUiUnreachable) {
      setShowWebUiUnavailable(false);
      return undefined;
    }

    const timer = window.setTimeout(() => setShowWebUiUnavailable(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [webUiUnreachable]);

  const canStart = service && (status === "stopped" || status === "error");
  const waiting =
    busy
    || status === "starting"
    || status === "stopping"
    || (status === "running" && (health !== "unreachable" || !showWebUiUnavailable));
  const title = !service
    ? "MAIBOT 未发现"
    : status === "stopped"
      ? "MAIBOT 尚未启动"
      : status === "starting"
        ? "MAIBOT 正在启动"
        : status === "running"
          ? showWebUiUnavailable
            ? "MAIBOT WEBUI 暂不可访问"
            : "等待 WebUI 启动"
          : status === "stopping"
            ? "MAIBOT 正在停止"
            : "MAIBOT 启动异常";
  const description = !service || status === "stopped"
    ? "当前没有运行中的 Maibot 实例，信号连接未建立。"
    : status === "starting"
      ? "正在启动 Maibot Core，请稍等片刻。"
      : status === "running"
        ? showWebUiUnavailable
          ? "服务进程已启动，但 WebUI 端口暂不可访问。"
          : "WebUI 正在加载，完成后会自动打开。"
        : status === "stopping"
          ? "正在停止 Maibot Core。"
          : "启动过程中发生异常，请查看终端日志。";

  return (
    <section className="relative grid h-full min-h-0 place-items-center overflow-hidden bg-transparent p-6 text-[var(--retro-ink,var(--foreground))]">
      <div className="relative z-10 flex w-full max-w-[530px] flex-col items-center text-center">
        {retro ? <MaiBotOfflineIllustration waiting={waiting} /> : null}

        <h3 className={cn(retro ? "mt-4" : "mt-0", "text-[34px] font-black leading-tight tracking-[0.02em] text-[var(--retro-ink,var(--foreground))]")}>
          {title}
        </h3>
        <p className="mt-3 text-[15px] font-semibold text-[var(--retro-ink-soft,var(--muted-foreground))]">
          {description}
        </p>

        <div className="my-7 flex w-full items-center gap-3 text-[var(--retro-ink-soft,var(--muted-foreground))]">
          <span className="size-2.5 rounded-full bg-current opacity-70" />
          <span className="h-px flex-1 bg-current opacity-45" />
          <span className="size-2.5 rounded-full bg-current opacity-70" />
        </div>

        <div className="w-[min(500px,100%)] border-2 border-[var(--retro-line,var(--border))] bg-[var(--retro-recessed,transparent)] px-4 py-3 text-left">
          <div className="flex items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center text-[var(--retro-ink,var(--foreground))]">
              <Info className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-black text-[var(--retro-ink,var(--foreground))]">提示</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-[var(--retro-ink-soft,var(--muted-foreground))]">
                {canStart ? (
                  <>
                    <span>点击</span>
                    <Button
                      className="h-7 border-[var(--retro-rust,var(--primary))] px-2 text-xs"
                      disabled={busy}
                      onClick={() => onStart(service.id)}
                      size="sm"
                      variant="outline"
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <Play />}
                      启动
                    </Button>
                    <span>建立连接并开始使用。</span>
                  </>
                ) : (
                  <span>{waiting ? "正在等待 Maibot 建立连接。" : "请先在服务状态中确认 Maibot 配置。"}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FloatingShell({
  expanded,
  edge,
  maibotService,
  onExpand,
  onCollapse,
  onRestore,
  onWindowState,
}: {
  expanded: boolean;
  edge: "left" | "right" | null;
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
      .moveFloatingTo(point.clientX, point.clientY)
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
            className="grid h-24 w-6 place-items-center overflow-hidden rounded-full border border-primary/30 bg-card shadow-xl"
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
          className="relative grid size-20 cursor-grab place-items-center overflow-hidden rounded-full border border-primary/30 bg-card shadow-xl active:cursor-grabbing"
          data-app-region="no-drag"
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
      className="flex h-screen min-h-0 flex-col overflow-hidden border border-border bg-background text-foreground shadow-2xl"
      data-floating-shell="true"
      style={{
        borderRadius: "var(--app-window-radius, 16px)",
      }}
    >
      <div
        className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-border bg-card px-2 active:cursor-grabbing"
        data-app-region="no-drag"
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
  retro,
}: {
  isStartingOpenCode: boolean;
  onStartOpenCode: () => void;
  retro: boolean;
}): React.JSX.Element {
  return (
    <section className={cn("flex h-full min-h-0", retro ? "bg-transparent" : "bg-background")}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 overflow-auto px-6 py-6">
        <div className="retro-panel retro-panel-bare p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="retro-control grid size-8 shrink-0 place-items-center text-primary">
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

        <div className="retro-panel retro-panel-bare grid min-h-[360px] flex-1 place-items-center p-6 text-center">
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

const RETRO_TAB_ITEM_SELECTOR = "[data-retro-tab-item='true']";

function retroTabItemForValue(list: HTMLElement, value: string): HTMLElement | null {
  return Array.from(list.querySelectorAll<HTMLElement>(RETRO_TAB_ITEM_SELECTOR)).find(
    (item) => item.dataset.retroTabValue === value,
  ) ?? null;
}

function formatCssPixel(value: number): string {
  return `${Number(value.toFixed(3))}px`;
}

function syncRetroTabDividers(list: HTMLElement | null): void {
  if (!list) {
    return;
  }

  const items = Array.from(list.querySelectorAll<HTMLElement>(RETRO_TAB_ITEM_SELECTOR));
  if (items.length < 2) {
    list.style.setProperty("--retro-tab-divider-background", "none");
    return;
  }

  const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
  const lineWidth = 2 / pixelRatio;
  const listLeft = list.getBoundingClientRect().left;
  const layers = items.slice(0, -1).map((item) => {
    const itemRight = item.getBoundingClientRect().right - listLeft;
    const x = Math.round(itemRight * pixelRatio) / pixelRatio;
    const from = formatCssPixel(x);
    const to = formatCssPixel(x + lineWidth);
    return `linear-gradient(to right, transparent 0 ${from}, var(--retro-tab-divider-color) ${from} ${to}, transparent ${to} 100%)`;
  });

  list.style.setProperty("--retro-tab-divider-background", layers.join(", "));
}

function moveRetroTabIndicator(list: HTMLElement | null, item: HTMLElement | null): void {
  if (!list || !item) {
    list?.style.setProperty("--retro-tab-indicator-opacity", "0");
    return;
  }

  const listRect = list.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  list.style.setProperty("--retro-tab-indicator-x", `${itemRect.left - listRect.left}px`);
  list.style.setProperty("--retro-tab-indicator-width", `${itemRect.width}px`);
  list.style.setProperty("--retro-tab-indicator-opacity", "1");
}

export function DesktopShell(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState("home");
  const [webviewToolbarHost, setWebviewToolbarHost] = useState<HTMLDivElement | null>(null);
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
  const retroTabsRef = useRef<HTMLDivElement | null>(null);
  const appearance = useAppearance();
  const theme = useTheme();
  const useRetroChrome = appearance.mode === "future-retro";

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
  const serviceById = useMemo(
    () => new Map(services.map((s) => [s.id, s])),
    [services],
  );
  const maibotService = serviceById.get("maibot");
  const maibotWebviewReady = maibotService?.status === "running" && maibotService.health === "ready";
  const maibotWebviewReloadTrigger =
    maibotWebviewReady
      ? maibotService.url
      : null;
  const qqBackendService = serviceById.get("napcat");
  const qqBackendName =
    qqBackendService?.name ?? (snapshot?.initState.qqBackend === "snowluma" ? "SnowLuma" : "NapCat");
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
      if (pluginBuilderMode === "disabled") {
        setActiveTab("home");
        return;
      }
      setActiveTab("pluginbuilder");
      return;
    }
    setActiveTab(value);
  }, [pluginBuilderMode, showTerminalTab]);

  const syncRetroTabIndicator = useCallback((value: string) => {
    const list = retroTabsRef.current;
    if (!list) {
      return;
    }
    moveRetroTabIndicator(list, retroTabItemForValue(list, value));
  }, []);

  const handleRetroTabsPointerOver = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!useRetroChrome) {
      return;
    }

    const item = (event.target as HTMLElement).closest<HTMLElement>(RETRO_TAB_ITEM_SELECTOR);
    if (!item || !retroTabsRef.current?.contains(item)) {
      return;
    }
    moveRetroTabIndicator(retroTabsRef.current, item);
  }, [useRetroChrome]);

  const handleRetroTabsFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    if (!useRetroChrome) {
      return;
    }

    const item = (event.target as HTMLElement).closest<HTMLElement>(RETRO_TAB_ITEM_SELECTOR);
    if (!item || !retroTabsRef.current?.contains(item)) {
      return;
    }
    moveRetroTabIndicator(retroTabsRef.current, item);
  }, [useRetroChrome]);

  const handleRetroTabsPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!useRetroChrome || event.button !== 0) {
      return;
    }

    const list = retroTabsRef.current;
    const item = (event.target as HTMLElement).closest<HTMLElement>(RETRO_TAB_ITEM_SELECTOR);
    if (!list || !item || !list.contains(item)) {
      return;
    }

    list.removeAttribute("data-retro-pressing");
    void list.offsetWidth;
    list.setAttribute("data-retro-pressing", "true");
  }, [useRetroChrome]);

  const handleRetroTabsPointerLeave = useCallback(() => {
    syncRetroTabIndicator(activeTab);
  }, [activeTab, syncRetroTabIndicator]);

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
  }, [activeTab, showTerminalTab]);

  useEffect(() => {
    if (activeTab === "pluginbuilder" && pluginBuilderMode === "disabled") {
      setActiveTab("home");
    }
  }, [activeTab, pluginBuilderMode]);

  useEffect(() => {
    if (!useRetroChrome) {
      moveRetroTabIndicator(retroTabsRef.current, null);
      syncRetroTabDividers(retroTabsRef.current);
      return;
    }

    let frame = 0;
    const syncNow = (): void => {
      syncRetroTabDividers(retroTabsRef.current);
      syncRetroTabIndicator(activeTab);
    };
    const sync = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncNow);
    };

    sync();
    const observer = new ResizeObserver(sync);
    const list = retroTabsRef.current;
    if (list) {
      observer.observe(list);
      for (const item of list.querySelectorAll<HTMLElement>(RETRO_TAB_ITEM_SELECTOR)) {
        observer.observe(item);
      }
    }

    window.addEventListener("resize", sync);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [activeTab, maibotService?.status, pluginBuilderMode, showTerminalTab, syncRetroTabIndicator, useRetroChrome]);

  useEffect(() => {
    const list = retroTabsRef.current;
    if (!list || !useRetroChrome) {
      return;
    }

    const clearPressing = (event: AnimationEvent): void => {
      if (event.animationName === "retro-tab-indicator-press") {
        list.removeAttribute("data-retro-pressing");
      }
    };

    list.addEventListener("animationend", clearPressing);
    list.addEventListener("animationcancel", clearPressing);
    return () => {
      list.removeAttribute("data-retro-pressing");
      list.removeEventListener("animationend", clearPressing);
      list.removeEventListener("animationcancel", clearPressing);
    };
  }, [useRetroChrome]);

  // Global shortcuts
  useShortcut("Mod+L", openLogs);
  useShortcut("Mod+Shift+S", startAll);
  useShortcut("Mod+Shift+X", stopAll);
  useShortcut("Mod+Shift+L", theme.toggle);

  if (floatingMode) {
    return (
      <TooltipProvider delayDuration={250}>
        <FloatingShell
          edge={floatingEdge}
          expanded={floatingExpanded}
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
          "bg-background",
          useRetroChrome && "retro-shell",
        )}
      >
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <Titlebar
            appVersion={snapshot?.appVersion ?? "0.1.0"}
            retro={useRetroChrome}
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
                  useRetroChrome
                    ? "flex h-12 shrink-0 items-stretch gap-0 border-b-3 border-[var(--retro-tabbar-line)] pl-6 pr-5"
                    : "flex h-10 shrink-0 items-center gap-3 border-b border-border px-3",
                  "bg-card",
                )}
              >
                <TabsList
                  className={cn(useRetroChrome ? "retro-tabs h-full" : "h-8 bg-card")}
                  onFocusCapture={handleRetroTabsFocus}
                  onPointerDown={handleRetroTabsPointerDown}
                  onPointerLeave={handleRetroTabsPointerLeave}
                  onPointerOver={handleRetroTabsPointerOver}
                  ref={retroTabsRef}
                >
                  <TabsTrigger
                    data-retro-active={useRetroChrome && activeTab === "home" ? "true" : undefined}
                    data-retro-tab-item={useRetroChrome ? "true" : undefined}
                    data-retro-tab-value={useRetroChrome ? "home" : undefined}
                    value="home"
                    className={cn("gap-1.5", useRetroChrome && "px-5")}
                  >
                    <Home data-retro-fill={useRetroChrome ? "true" : undefined} />
                    首页
                  </TabsTrigger>
                  <div
                    className={cn(
                      useRetroChrome
                        ? "relative flex h-full shrink-0 items-center border-0 bg-transparent text-muted-foreground transition-colors hover:text-foreground/90"
                        : "flex h-7 shrink-0 items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground/90",
                      activeTab === "maibot" && (
                        useRetroChrome
                          ? "text-primary-foreground"
                          : "border-primary/45 bg-primary/15 text-primary shadow-sm"
                      ),
                    )}
                    data-retro-active={useRetroChrome && activeTab === "maibot" ? "true" : undefined}
                    data-retro-tab-item={useRetroChrome ? "true" : undefined}
                    data-retro-tab-value={useRetroChrome ? "maibot" : undefined}
                  >
                    <TabsTrigger
                      value="maibot"
                      className={cn(
                        "h-full flex-none gap-1.5 border-0 bg-transparent text-inherit hover:text-inherit",
                        useRetroChrome
                          ? "px-2 data-[state=active]:bg-transparent data-[state=active]:text-inherit"
                          : "px-2.5 data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:text-inherit data-[state=active]:shadow-none",
                      )}
                    >
                      <Radar className={cn(useRetroChrome && "text-[var(--retro-gold)]")} />
                      MaiBot
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: maibotService ? statusColor[maibotService.status] : "var(--muted-foreground)" }}
                      />
                      <span
                        className={cn(
                          "hidden shrink-0 text-[10.5px] font-normal tabular-nums xl:inline",
                          useRetroChrome && activeTab === "maibot" ? "text-primary-foreground/80" : undefined,
                          !maibotService && "text-muted-foreground",
                        )}
                        style={maibotService && !useRetroChrome ? { color: statusColor[maibotService.status] } : undefined}
                      >
                        {maibotService ? statusText[maibotService.status] : "未发现"}
                      </span>
                    </TabsTrigger>
                    <ServiceTabControls
                      service={maibotService}
                      busy={actionBusy?.startsWith("maibot:") ?? false}
                      retro={useRetroChrome}
                      onStart={startService}
                      onStop={stopService}
                      onRestart={restartService}
                    />
                  </div>
                  <TabsTrigger
                    data-retro-active={useRetroChrome && activeTab === "localchat" ? "true" : undefined}
                    data-retro-tab-item={useRetroChrome ? "true" : undefined}
                    data-retro-tab-value={useRetroChrome ? "localchat" : undefined}
                    value="localchat"
                    className={cn("gap-1.5", useRetroChrome && "px-5")}
                  >
                    <MessageSquare />
                    聊聊
                  </TabsTrigger>
                  {showTerminalTab ? (
                    <TabsTrigger
                      data-retro-active={useRetroChrome && activeTab === "terminal" ? "true" : undefined}
                      data-retro-tab-item={useRetroChrome ? "true" : undefined}
                      data-retro-tab-value={useRetroChrome ? "terminal" : undefined}
                      value="terminal"
                      className={cn("gap-1.5", useRetroChrome && "px-5")}
                    >
                      <TerminalSquare />
                      终端
                    </TabsTrigger>
                  ) : null}
                  <TabsTrigger
                    data-retro-active={useRetroChrome && activeTab === "plugins" ? "true" : undefined}
                    data-retro-tab-item={useRetroChrome ? "true" : undefined}
                    data-retro-tab-value={useRetroChrome ? "plugins" : undefined}
                    value="plugins"
                    className={cn("gap-1.5", useRetroChrome && "px-5")}
                  >
                    <Puzzle />
                    插件
                  </TabsTrigger>
                  {pluginBuilderMode !== "disabled" ? (
                    <TabsTrigger
                      data-retro-active={useRetroChrome && activeTab === "pluginbuilder" ? "true" : undefined}
                      data-retro-tab-item={useRetroChrome ? "true" : undefined}
                      data-retro-tab-value={useRetroChrome ? "pluginbuilder" : undefined}
                      value="pluginbuilder"
                      className={cn("gap-1.5", useRetroChrome && "px-5")}
                    >
                      <Code2 />
                      编写器
                    </TabsTrigger>
                  ) : null}
                </TabsList>
                <div
                  className={cn(
                    activeTab === "maibot" || activeTab === "localchat"
                      ? "ml-auto flex min-w-0 flex-1 items-center justify-end"
                      : "hidden",
                    useRetroChrome ? "h-full px-2 py-1" : "h-full",
                  )}
                  ref={setWebviewToolbarHost}
                />
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-1",
                    activeTab !== "maibot" && activeTab !== "localchat" && "ml-auto",
                    useRetroChrome && "py-1",
                  )}
                >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="设置"
                      className={cn(
                        useRetroChrome
                          ? [
                              cn("retro-top-action text-primary-foreground [&_svg]:stroke-primary-foreground", retroTopActionIconClassName),
                              activeTab === "settings"
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-[var(--retro-ink)] bg-[var(--retro-ink)] text-primary-foreground hover:bg-[var(--retro-ink)]",
                            ]
                          : "size-7",
                      )}
                      onClick={() => selectTab("settings")}
                      size="icon-sm"
                      variant={useRetroChrome ? "secondary" : activeTab === "settings" ? "default" : "secondary"}
                    >
                      <Settings />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    设置
                  </TooltipContent>
                </Tooltip>
                {useRetroChrome ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="启动全部服务"
                        className={cn("retro-top-action w-16 border-primary bg-primary px-0 text-primary-foreground hover:bg-primary/90", retroTopActionIconClassName)}
                        disabled={actionBusy !== null}
                        onClick={startAll}
                        size="sm"
                        variant="secondary"
                      >
                        {actionBusy === "all:start" ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Play />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span className="flex items-center gap-1">
                        启动全部服务 <Kbd keys="Mod+Shift+S" size="xs" tone="inverse" />
                      </span>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <div className="flex shrink-0 items-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label="启动全部服务"
                          className="h-7 w-8 rounded-r-none px-0 text-[11px]"
                          disabled={actionBusy !== null}
                          onClick={startAll}
                          size="sm"
                          variant="default"
                        >
                          {actionBusy === "all:start" ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Play />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="flex items-center gap-1">
                          启动全部服务 <Kbd keys="Mod+Shift+S" size="xs" tone="inverse" />
                        </span>
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuPrimitive.Root>
                      <DropdownMenuPrimitive.Trigger asChild>
                        <Button
                          aria-label="选择要启动的服务"
                          className="-ml-px h-7 w-5 rounded-l-none border-l border-primary-foreground/25 px-0 text-[11px]"
                          disabled={actionBusy !== null}
                          size="sm"
                          variant="default"
                        >
                          <ChevronDown className="size-3" />
                        </Button>
                      </DropdownMenuPrimitive.Trigger>
                      <DropdownMenuPrimitive.Portal>
                        <DropdownMenuPrimitive.Content
                          align="end"
                          className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/15"
                          sideOffset={6}
                        >
                          <DropdownMenuPrimitive.Item className={toolbarMenuItemClassName} onSelect={startAll}>
                            <Play className="size-3.5" />
                            <span className="flex-1">启动全部服务</span>
                            <Kbd keys="Mod+Shift+S" size="xs" />
                          </DropdownMenuPrimitive.Item>
                          <DropdownMenuPrimitive.Item
                            className={toolbarMenuItemClassName}
                            disabled={!maibotService}
                            onSelect={() => startService("maibot")}
                          >
                            <Play className="size-3.5" />
                            启动 MaiBot
                          </DropdownMenuPrimitive.Item>
                          <DropdownMenuPrimitive.Item
                            className={toolbarMenuItemClassName}
                            disabled={!qqBackendService}
                            onSelect={() => startService("napcat")}
                          >
                            <Play className="size-3.5" />
                            启动 {qqBackendName}
                          </DropdownMenuPrimitive.Item>
                        </DropdownMenuPrimitive.Content>
                      </DropdownMenuPrimitive.Portal>
                    </DropdownMenuPrimitive.Root>
                  </div>
                )}
                {!useRetroChrome ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="停止全部"
                        size="icon-sm"
                        variant="ghost"
                        onClick={stopAll}
                        disabled={actionBusy !== null && !canInterruptStartup}
                        className="size-7"
                      >
                        {actionBusy === "all:stop" ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Square />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span className="flex items-center gap-1">
                        停止全部 <Kbd keys="Mod+Shift+X" size="xs" tone="inverse" />
                      </span>
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="打开日志目录"
                      size="icon-sm"
                      variant="ghost"
                      onClick={openLogs}
                      className={cn(useRetroChrome ? cn("retro-top-action border-border bg-card", retroTopActionIconClassName) : "size-7")}
                    >
                      <ListTree />
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
                  onRestartService={restartService}
                  onStartService={startService}
                  onStopService={stopService}
                  serviceActionBusy={actionBusy}
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
              {maibotWebviewReady ? (
                <WebviewPanel
                  active={activeTab === "maibot"}
                  emptyText="MaiBot Core 启动后会在这里载入官方 WebUI。"
                  title="MaiBot WebUI"
                  toolbarPlacement="external"
                  toolbarTarget={webviewToolbarHost}
                  reloadTrigger={maibotWebviewReloadTrigger}
                  url={maibotService?.url ?? "http://127.0.0.1:8001"}
                />
              ) : (
                <MaiBotWebuiStatusPanel
                  busy={actionBusy?.startsWith("maibot:") ?? false}
                  onStart={startService}
                  retro={useRetroChrome}
                  service={maibotService}
                />
              )}
            </TabsContent>

            <TabsContent
              forceMount
              value="localchat"
              className="min-h-0 flex-1 outline-none data-[state=inactive]:hidden"
            >
              <LocalChatPanel
                active={activeTab === "localchat"}
                maibotService={maibotService}
                retro={useRetroChrome}
                toolbarPlacement="external"
                toolbarTarget={webviewToolbarHost}
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
                  retro={useRetroChrome}
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
                retro={useRetroChrome}
                requestedConfigPluginId={requestedConfigPluginId}
              />
            </TabsContent>

            {pluginBuilderMode !== "disabled" ? (
              <TabsContent
                value="pluginbuilder"
                className="min-h-0 flex-1 overflow-hidden outline-none"
              >
                <PluginCodingAgentPanel
                  isStartingOpenCode={isStartingOpenCode}
                  onStartOpenCode={startOpenCode}
                  retro={useRetroChrome}
                />
              </TabsContent>
            ) : null}

            <TabsContent
              value="settings"
              className="settings-scroll-scope min-h-0 flex-1 overflow-hidden outline-none"
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
