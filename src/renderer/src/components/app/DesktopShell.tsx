import {
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  Home,
  Info,
  Loader2,
  MessageSquare,
  Play,
  Puzzle,
  RefreshCw,
  Settings,
  Square,
  TerminalSquare,
} from "lucide-react";
import { type CSSProperties, type FocusEvent, type MouseEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { toast } from "sonner";
import type {
  CodexPetOption,
  DesktopSnapshot,
  LocalChatConnectionState,
  LocalChatEvent,
  LocalChatMessageEvent,
  PluginBuilderMode,
  ServiceDescriptor,
  ServiceId,
  ServiceStatus,
  WindowState,
  WindowResizeEdge,
} from "@shared/contracts";
import { getDesktopSnapshot, normalizeDesktopSnapshot } from "@/lib/desktop-api";
import { localChatErrorMessage } from "@/lib/local-chat-error";
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

const statusColor: Record<ServiceStatus, string> = {
  stopped: "var(--retro-ink, var(--muted-foreground))",
  starting: "var(--warning)",
  running: "var(--retro-rust, var(--success))",
  stopping: "var(--warning)",
  error: "var(--destructive)",
};

function isServiceProcessActive(service: ServiceDescriptor): boolean {
  return service.managed || service.status === "starting" || service.status === "running" || service.status === "stopping";
}

const PLUGIN_BUILDER_MODE_STORAGE_KEY = "maibot-onekey.plugin-builder-mode";
const PLUGIN_SURFACE_MODE_STORAGE_KEY = "maibot-onekey.plugin-surface-mode";
const STARTUP_WIZARD_KEY = "maibot-startup-wizard-seen";
const HOME_ENTRY_GUIDE_KEY = "maibot-onekey.home-entry-guide-seen.v2";
const OPENCODE_TERMINAL_SESSION_PREFIX = "user-terminal:opencode:";
const MAIBOT_DEFAULT_WEBUI_URL = "http://127.0.0.1:8001";
const MAIBOT_CHAT_WEBUI_PATH = "/chat/embed";
const WEBUI_CHAT_USER_ID_STORAGE_KEY = "maibot-onekey.webui-chat-user-id";
const WEBUI_CHAT_USER_NAME_STORAGE_KEY = "maibot-onekey.webui-chat-user-name";
const CODEX_PET_ATLAS_COLUMNS = 8;
const CODEX_PET_ATLAS_ROWS = 9;
const CODEX_PET_CELL_WIDTH = 192;
const CODEX_PET_CELL_HEIGHT = 208;
type CodexPetMotion = "idle" | "waving" | "running-right" | "running-left";
const CODEX_PET_MOTION_CONFIG: Record<CodexPetMotion, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
};
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

interface WebviewEntryTarget {
  entryUrl: string;
  postAuthTargetUrl?: string;
}

type PluginPanelMode = "market" | "manage";
type PluginSurfaceMode = "webui" | "native";

function pluginWebuiPathForMode(mode: PluginPanelMode): string {
  return mode === "market" ? "/plugins/embed" : "/plugin-config/embed";
}

function pluginConfigWebuiPath(pluginId: string): string {
  const params = new URLSearchParams({ plugin: pluginId });
  return `/plugin-config/embed?${params.toString()}`;
}

function pluginWebviewTitle(path: string, mode: PluginPanelMode): string {
  if (path.startsWith("/plugin-config")) {
    return "MaiBot WebUI 插件管理";
  }
  return mode === "market" ? "MaiBot WebUI 插件市场" : "MaiBot WebUI 插件管理";
}

function createMaibotWebviewTarget(url: string, targetPath: string): WebviewEntryTarget {
  try {
    const entryUrl = new URL(url);
    const targetUrl = new URL(url);
    const targetPathUrl = new URL(targetPath, targetUrl.origin);
    targetUrl.pathname = targetPathUrl.pathname;
    targetUrl.search = targetPathUrl.search;
    targetUrl.hash = targetPathUrl.hash;

    const entryPath = entryUrl.pathname.replace(/\/+$/u, "") || "/";
    const isAuthEntry = entryPath === "/auth" && entryUrl.searchParams.has("token");

    return {
      entryUrl: isAuthEntry ? entryUrl.toString() : targetUrl.toString(),
      postAuthTargetUrl: isAuthEntry ? targetUrl.toString() : undefined,
    };
  } catch {
    return { entryUrl: url };
  }
}

function createMaibotChatWebviewTarget(url: string): WebviewEntryTarget {
  return createMaibotWebviewTarget(url, MAIBOT_CHAT_WEBUI_PATH);
}

function selectedCodexPetOption(snapshot: DesktopSnapshot | null): CodexPetOption | null {
  if (snapshot?.launcherUiSettings.floatingMascotMode !== "codex-pet") {
    return null;
  }
  const options = snapshot.codexPetSettings.options;
  return options.find((option) => option.id === snapshot.launcherUiSettings.floatingCodexPetId) ?? options[0] ?? null;
}

function CodexPetSprite({
  pet,
  height,
  motion = "idle",
  className,
}: {
  pet: CodexPetOption;
  height: number;
  motion?: CodexPetMotion;
  className?: string;
}): React.JSX.Element {
  const width = Math.round((height * CODEX_PET_CELL_WIDTH) / CODEX_PET_CELL_HEIGHT);
  const config = CODEX_PET_MOTION_CONFIG[motion];
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex(0);
  }, [motion, pet.spritesheetUrl]);

  useEffect(() => {
    const duration = config.durations[frameIndex] ?? config.durations[0] ?? 140;
    const timeout = window.setTimeout(() => {
      setFrameIndex((current) => (current + 1) % config.durations.length);
    }, duration);
    return () => window.clearTimeout(timeout);
  }, [config.durations, frameIndex]);

  return (
    <span
      aria-label={pet.displayName}
      className={cn("codex-pet-sprite block shrink-0 overflow-hidden select-none", className)}
      role="img"
      style={{
        "--codex-pet-frame-width": `${width}px`,
        width,
        height,
      } as CSSProperties}
    >
      <img
        alt=""
        className="codex-pet-sprite-frame block h-full max-w-none select-none"
        draggable={false}
        src={pet.spritesheetUrl}
        style={{
          width: width * CODEX_PET_ATLAS_COLUMNS,
          height: height * CODEX_PET_ATLAS_ROWS,
          transform: `translate(${-frameIndex * width}px, ${-config.row * height}px)`,
        }}
      />
    </span>
  );
}

function readPluginBuilderMode(): PluginBuilderMode {
  if (typeof window === "undefined") {
    return "agent";
  }
  const mode = window.localStorage.getItem(PLUGIN_BUILDER_MODE_STORAGE_KEY);
  return mode === "disabled" ? "disabled" : "agent";
}

function readPluginSurfaceMode(): PluginSurfaceMode {
  if (typeof window === "undefined") {
    return "webui";
  }
  const mode = window.localStorage.getItem(PLUGIN_SURFACE_MODE_STORAGE_KEY);
  return mode === "native" ? "native" : "webui";
}

function readStorageFlag(key: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeStorageFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Local storage can be unavailable in isolated previews.
  }
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
  context = "webui",
}: {
  service: ServiceDescriptor | undefined;
  busy: boolean;
  onStart: (id: ServiceId) => void;
  retro: boolean;
  context?: "webui" | "plugins";
}): React.JSX.Element {
  const status = service?.status ?? "stopped";
  const health = service?.health ?? "unknown";
  const pluginContext = context === "plugins";
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
  const title = pluginContext
    ? !service
      ? "插件未连接"
      : status === "stopped"
        ? "插件未连接"
        : status === "starting"
          ? "插件连接中"
          : status === "running"
            ? showWebUiUnavailable
              ? "插件页面暂不可访问"
              : "等待插件页面"
            : status === "stopping"
              ? "插件连接正在断开"
              : "插件连接异常"
    : !service
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
  const description = pluginContext
    ? !service || status === "stopped"
      ? "插件页面需要连接到正在运行的 MaiBot Core。"
      : status === "starting"
        ? "正在启动 MaiBot Core，插件连接建立后会自动载入。"
        : status === "running"
          ? showWebUiUnavailable
            ? "MaiBot Core 已运行，但插件 WebUI 入口暂时无法访问。"
            : "插件页面正在加载，完成后会自动打开。"
          : status === "stopping"
            ? "MaiBot Core 正在停止，插件连接暂不可用。"
            : "插件连接建立失败，请查看终端日志。"
    : !service || status === "stopped"
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
                    <span>{pluginContext ? "连接插件页面。" : "建立连接并开始使用。"}</span>
                  </>
                ) : (
                  <span>{waiting ? (pluginContext ? "正在等待插件页面建立连接。" : "正在等待 Maibot 建立连接。") : "请先在服务状态中确认 Maibot 配置。"}</span>
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
  edge,
  maibotService,
  codexPet,
  onRestore,
  onWindowState,
  useNativeGlass,
}: {
  edge: "left" | "right" | null;
  maibotService: ServiceDescriptor | undefined;
  codexPet: CodexPetOption | null;
  onRestore: () => void;
  onWindowState: (state: WindowState) => void;
  useNativeGlass: boolean;
}): React.JSX.Element {
  const dragRef = useRef<{
    offsetX: number;
    offsetY: number;
    startScreenX: number;
    startScreenY: number;
    lastScreenX: number;
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
  const [petMotion, setPetMotion] = useState<CodexPetMotion>("idle");
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [bubbleDraft, setBubbleDraft] = useState("");
  const [bubbleMessages, setBubbleMessages] = useState<LocalChatMessageEvent[]>([]);
  const [bubbleState, setBubbleState] = useState<LocalChatConnectionState>("idle");
  const [bubbleError, setBubbleError] = useState<string | null>(null);
  const [bubbleSending, setBubbleSending] = useState(false);

  const updateFloatingState = useCallback((state?: WindowState) => {
    if (state) {
      onWindowState(state);
    }
  }, [onWindowState]);

  useEffect(() => {
    const glassCollapsed = useNativeGlass && !bubbleOpen;
    document.documentElement.dataset.floatingGlassCollapsed = glassCollapsed ? "true" : "false";
    document.documentElement.dataset.floatingBubbleOpen = bubbleOpen ? "true" : "false";
    void window.maibotDesktop?.window.setFloatingGlassEffect(glassCollapsed);
    return () => {
      document.documentElement.dataset.floatingGlassCollapsed = "false";
      document.documentElement.dataset.floatingBubbleOpen = "false";
      void window.maibotDesktop?.window.setFloatingGlassEffect(false);
    };
  }, [bubbleOpen, useNativeGlass]);

  useEffect(() => {
    void window.maibotDesktop?.window.setFloatingBubbleExpanded(bubbleOpen);
    return () => {
      void window.maibotDesktop?.window.setFloatingBubbleExpanded(false);
    };
  }, [bubbleOpen]);

  useEffect(() => {
    if (!bubbleOpen) {
      return undefined;
    }
    if (maibotService?.status !== "running") {
      setBubbleState("idle");
      setBubbleError(maibotService?.status === "starting" ? "MaiBot Core 正在启动" : "请先启动 MaiBot Core");
      return undefined;
    }
    const bridge = window.maibotDesktop?.localChat;
    const unsubscribe = bridge?.onEvent((event: LocalChatEvent) => {
      if ("type" in event) {
        setBubbleState(event.state);
        if (event.state === "connected") {
          setBubbleError(null);
        }
        return;
      }
      setBubbleSending(false);
      setBubbleMessages((current) => [...current, event].slice(-6));
    });

    setBubbleState("connecting");
    setBubbleError(null);
    void bridge?.connect()
      .then(async (state) => {
        setBubbleState(state);
        if (state !== "connected") {
          setBubbleError("聊天服务还没准备好");
          return;
        }
        const history = await bridge.listMessages();
        setBubbleMessages(history.slice(-6));
      })
      .catch((error) => {
        setBubbleState("error");
        setBubbleError(localChatErrorMessage(error));
      });

    return () => {
      unsubscribe?.();
    };
  }, [bubbleOpen, maibotService?.status]);

  const startBubbleMaiBotCore = useCallback(() => {
    if (!maibotService || maibotService.status === "starting" || maibotService.status === "stopping") {
      return;
    }
    setBubbleError(null);
    void window.maibotDesktop?.services.start("maibot").catch((error) => {
      setBubbleError(localChatErrorMessage(error));
    });
  }, [maibotService]);

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
    setBubbleOpen((current) => !current);
  }, []);

  const sendBubbleMessage = useCallback(() => {
    const content = bubbleDraft.trim();
    if (!content || bubbleSending || bubbleState !== "connected") {
      return;
    }
    setBubbleDraft("");
    setBubbleSending(true);
    setBubbleError(null);
    void window.maibotDesktop?.localChat
      .send({ content })
      .then((sent) => {
        if (sent) {
          setBubbleMessages((current) => [...current, sent].slice(-6));
        }
      })
      .catch((error) => {
        setBubbleDraft(content);
        setBubbleError(localChatErrorMessage(error));
      })
      .finally(() => setBubbleSending(false));
  }, [bubbleDraft, bubbleSending, bubbleState]);

  const handlePetPointerEnter = useCallback(() => {
    if (!dragRef.current) {
      setPetMotion("waving");
    }
  }, []);

  const handlePetPointerLeave = useCallback(() => {
    if (!dragRef.current) {
      setPetMotion("idle");
    }
  }, []);

  const settlePetMotion = useCallback((target: HTMLElement) => {
    setPetMotion(target.matches(":hover") ? "waving" : "idle");
  }, []);

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
      lastScreenX: event.screenX,
      moved: false,
      pointerId: event.pointerId,
    };
    dragPointRef.current = null;
    setPetMotion("running-right");
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
    settlePetMotion(event.currentTarget);
  }, [settlePetMotion]);

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
    const deltaX = event.screenX - current.lastScreenX;
    if (deltaX < -1) {
      setPetMotion("running-left");
    } else if (deltaX > 1) {
      setPetMotion("running-right");
    }
    current.lastScreenX = event.screenX;
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
    settlePetMotion(event.currentTarget);
  }, [settlePetMotion, suppressNextClickBriefly, updateFloatingState]);

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
        onPointerEnter={handlePetPointerEnter}
        onPointerLeave={handlePetPointerLeave}
        onPointerMove={drag}
        onPointerUp={(event) => finishDrag(event)}
        title="拖动悬浮条，点击展开"
      >
        <div
          className="floating-collapsed-surface grid h-24 w-6 place-items-center overflow-hidden rounded-full border border-primary/30 bg-card shadow-xl"
        >
          {codexPet ? (
            <CodexPetSprite className="max-w-none" height={56} motion={petMotion} pet={codexPet} />
          ) : (
            <img
              alt=""
              className="h-14 max-w-none select-none object-cover"
              draggable={false}
              src={maiMascotImage}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "floating-collapsed-root h-screen bg-transparent",
        bubbleOpen ? "relative" : useNativeGlass ? "grid place-items-start" : "grid place-items-center",
      )}
      data-floating-shell="true"
    >
      {bubbleOpen ? (
        <div className="floating-pet-chat absolute inset-0 bg-transparent">
          <div className="absolute bottom-[94px] right-[70px] flex w-[254px] flex-col items-end gap-1.5">
            {bubbleError ? (
              <div className="floating-chat-bubble floating-chat-bubble-bot text-destructive">
                <div>{bubbleError}</div>
                {maibotService && maibotService.status !== "running" && maibotService.status !== "stopping" ? (
                  <button
                    className="mt-1 text-[11px] font-semibold underline underline-offset-2"
                    onClick={(event) => {
                      event.stopPropagation();
                      startBubbleMaiBotCore();
                    }}
                    type="button"
                  >
                    启动 MaiBot Core
                  </button>
                ) : null}
              </div>
            ) : bubbleMessages.length > 0 ? (
              bubbleMessages.slice(-3).map((message) => (
                <div
                  className={cn(
                    "floating-chat-bubble",
                    message.role === "user" ? "floating-chat-bubble-user" : "floating-chat-bubble-bot",
                  )}
                  key={message.id}
                >
                  {message.content || (message.role === "bot" ? "……" : "")}
                </div>
              ))
            ) : (
              <div className="floating-chat-bubble floating-chat-bubble-bot">
                {bubbleState === "connecting" ? "正在连接聊天服务……" : "直接和麦麦说话。"}
              </div>
            )}
            {bubbleSending ? (
              <div className="floating-chat-bubble floating-chat-bubble-bot">麦麦正在想……</div>
            ) : null}
          </div>
          <div className="absolute bottom-2 left-2 w-[252px]">
            <form
              className="floating-pet-chat-input flex items-center gap-1.5 rounded-full px-2 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                sendBubbleMessage();
              }}
            >
              <button
                aria-label="返回启动器"
                className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background/45 hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  setBubbleOpen(false);
                  onRestore();
                }}
                title="返回启动器"
                type="button"
              >
                <Home className="size-3.5" />
              </button>
              <input
                className="h-7 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
                onChange={(event) => setBubbleDraft(event.target.value)}
                placeholder={bubbleState === "connected" ? "直接输入..." : maibotService?.status === "running" ? "等待聊天服务" : "先启动 MaiBot Core"}
                value={bubbleDraft}
              />
              <Button className="h-7 rounded-full px-2 text-xs" disabled={!bubbleDraft.trim() || bubbleSending || bubbleState !== "connected"} size="sm" type="submit">
                发送
              </Button>
            </form>
          </div>
          <button
            className="absolute bottom-2 right-2 grid size-20 cursor-grab place-items-center border-0 bg-transparent p-0 active:cursor-grabbing"
            data-app-region="no-drag"
            onClick={expandFromClick}
            onPointerCancel={(event) => finishDrag(event)}
            onPointerDown={startDrag}
            onPointerEnter={handlePetPointerEnter}
            onPointerLeave={handlePetPointerLeave}
            onPointerMove={drag}
            onPointerUp={(event) => finishDrag(event)}
            title="收起气泡"
            type="button"
          >
            {codexPet ? (
              <CodexPetSprite className="drop-shadow-xl" height={78} motion={petMotion} pet={codexPet} />
            ) : (
              <img alt="" className="w-20 select-none drop-shadow-xl" draggable={false} src={maiMascotImage} />
            )}
          </button>
        </div>
      ) : (
        <button
          className={cn(
            useNativeGlass
              ? "floating-glass-stack relative h-[86px] w-20 cursor-grab appearance-none rounded-none border-0 bg-transparent p-0 shadow-none outline-none active:cursor-grabbing"
              : "floating-collapsed-surface relative grid size-20 cursor-grab place-items-center overflow-hidden rounded-full border border-primary/30 bg-card shadow-xl active:cursor-grabbing",
          )}
          data-app-region="no-drag"
          onClick={expandFromClick}
          onPointerCancel={(event) => finishDrag(event)}
          onPointerDown={startDrag}
          onPointerEnter={handlePetPointerEnter}
          onPointerLeave={handlePetPointerLeave}
          onPointerMove={drag}
          onPointerUp={(event) => finishDrag(event)}
          title="打开悬浮菜单"
          type="button"
        >
          {useNativeGlass ? (
            <>
              <span className="floating-glass-pane grid h-20 w-20 place-items-center overflow-hidden">
                {codexPet ? (
                  <CodexPetSprite className="relative mt-1 drop-shadow-xl" height={78} motion={petMotion} pet={codexPet} />
                ) : (
                  <img alt="" className="relative mt-3 w-20 select-none drop-shadow-xl" draggable={false} src={maiMascotImage} />
                )}
              </span>
              <span className="floating-glass-bars" aria-hidden="true" />
            </>
          ) : (
            <>
              <span className="floating-collapsed-glow absolute inset-x-3 bottom-1 h-7 rounded-full bg-primary/20 blur-md" />
              {codexPet ? (
                <CodexPetSprite className="relative mt-1 drop-shadow-xl" height={78} motion={petMotion} pet={codexPet} />
              ) : (
                <img alt="" className="relative mt-3 w-20 select-none drop-shadow-xl" draggable={false} src={maiMascotImage} />
              )}
            </>
          )}
        </button>
      )}
    </div>
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

function HomeEntryGuide({
  open,
  onConfirm,
}: {
  open: boolean;
  onConfirm: () => void;
}): React.JSX.Element | null {
  const [confirmed, setConfirmed] = useState({ localchat: false, messagePlatform: false });
  const [targets, setTargets] = useState<{
    localchat: DOMRect | null;
    messagePlatform: DOMRect | null;
  }>({ localchat: null, messagePlatform: null });

  useEffect(() => {
    if (!open) {
      setConfirmed({ localchat: false, messagePlatform: false });
      return;
    }

    const updateTargets = () => {
      const localchat = document.querySelector<HTMLElement>("[data-home-guide-target='localchat']");
      const messagePlatform = document.querySelector<HTMLElement>("[data-home-guide-target='message-platform']");
      setTargets({
        localchat: localchat?.getBoundingClientRect() ?? null,
        messagePlatform: messagePlatform?.getBoundingClientRect() ?? null,
      });
    };

    updateTargets();
    const frame = window.requestAnimationFrame(updateTargets);
    window.addEventListener("resize", updateTargets);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateTargets);
    };
  }, [open]);

  const confirmLocalchat = useCallback(() => {
    setConfirmed((current) => {
      const next = { ...current, localchat: true };
      if (next.messagePlatform) {
        window.setTimeout(onConfirm, 0);
      }
      return next;
    });
  }, [onConfirm]);

  const confirmMessagePlatform = useCallback(() => {
    setConfirmed((current) => {
      const next = { ...current, messagePlatform: true };
      if (next.localchat) {
        window.setTimeout(onConfirm, 0);
      }
      return next;
    });
  }, [onConfirm]);

  if (!open) {
    return null;
  }

  const localchatRect = targets.localchat;
  const messagePlatformRect = targets.messagePlatform;
  const messagePlatformBubbleTop = messagePlatformRect ? Math.max(64, messagePlatformRect.top - 150) : 300;
  const messagePlatformBubbleLeft = messagePlatformRect ? Math.max(16, messagePlatformRect.left + 24) : 24;
  const messagePlatformBubbleWidth = messagePlatformRect ? Math.min(420, messagePlatformRect.width - 48) : 420;
  const spotlightRects = [
    localchatRect
      ? {
          height: localchatRect.height + 10,
          rx: 8,
          x: localchatRect.left - 5,
          y: localchatRect.top - 5,
          width: localchatRect.width + 10,
        }
      : null,
    messagePlatformRect
      ? {
          height: messagePlatformRect.height + 12,
          rx: 12,
          x: messagePlatformRect.left - 6,
          y: messagePlatformRect.top - 6,
          width: messagePlatformRect.width + 12,
        }
      : null,
  ].filter((rect): rect is { height: number; rx: number; width: number; x: number; y: number } => Boolean(rect));
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  const overlayPath = [
    `M0 0H${viewportWidth}V${viewportHeight}H0Z`,
    ...spotlightRects.map((rect) => (
      `M${rect.x + rect.rx} ${rect.y}` +
      `H${rect.x + rect.width - rect.rx}` +
      `Q${rect.x + rect.width} ${rect.y} ${rect.x + rect.width} ${rect.y + rect.rx}` +
      `V${rect.y + rect.height - rect.rx}` +
      `Q${rect.x + rect.width} ${rect.y + rect.height} ${rect.x + rect.width - rect.rx} ${rect.y + rect.height}` +
      `H${rect.x + rect.rx}` +
      `Q${rect.x} ${rect.y + rect.height} ${rect.x} ${rect.y + rect.height - rect.rx}` +
      `V${rect.y + rect.rx}` +
      `Q${rect.x} ${rect.y} ${rect.x + rect.rx} ${rect.y}` +
      "Z"
    )),
  ].join("");

  return (
    <div className="fixed inset-0 z-[95]">
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
        <path d={overlayPath} fill="rgba(18,16,13,0.62)" fillRule="evenodd" />
      </svg>
      {spotlightRects.map((rect, index) => (
        <div
          className="pointer-events-none absolute border-2 border-primary shadow-[0_0_0_1px_rgb(255_255_255_/_0.25),0_12px_28px_rgb(0_0_0_/_0.18)]"
          key={index}
          style={{
            borderRadius: rect.rx,
            height: rect.height,
            left: rect.x,
            top: rect.y,
            width: rect.width,
          }}
        />
      ))}

      <section
        className="absolute w-[min(420px,calc(100vw-2rem))] rounded-md border border-border px-4 py-3 text-card-foreground shadow-2xl"
        style={{
          backgroundColor: "var(--retro-paper, var(--card))",
          backgroundImage: "var(--retro-paper-texture-layer, var(--retro-paper-texture, none))",
          backgroundSize: "165px 165px",
          left: localchatRect ? Math.max(16, localchatRect.left - 64) : 188,
          top: localchatRect ? localchatRect.bottom + 20 : 96,
        }}
      >
        <span
          className="absolute -top-3 left-20 size-5 rotate-45 border-l border-t border-border"
          style={{
            backgroundColor: "var(--retro-paper, var(--card))",
            backgroundImage: "var(--retro-paper-texture-layer, var(--retro-paper-texture, none))",
            backgroundSize: "165px 165px",
          }}
        />
        <p className="text-sm font-semibold leading-relaxed text-foreground">
          可以在聊聊页面进行本地聊天。
        </p>
        <div className="mt-3 flex justify-end">
          <Button disabled={confirmed.localchat} onClick={confirmLocalchat} size="sm">
            <CheckCircle2 />
            {confirmed.localchat ? "已确定" : "确定"}
          </Button>
        </div>
      </section>

      <section
        className="absolute rounded-md border border-border px-4 py-3 text-card-foreground shadow-2xl"
        style={{
          backgroundColor: "var(--retro-paper, var(--card))",
          backgroundImage: "var(--retro-paper-texture-layer, var(--retro-paper-texture, none))",
          backgroundSize: "165px 165px",
          left: messagePlatformBubbleLeft,
          top: messagePlatformBubbleTop,
          width: `min(${messagePlatformBubbleWidth}px, calc(100vw - 2rem))`,
        }}
      >
          <span
            className="absolute -bottom-3 left-16 size-5 rotate-45 border-b border-r border-border"
            style={{
              backgroundColor: "var(--retro-paper, var(--card))",
              backgroundImage: "var(--retro-paper-texture-layer, var(--retro-paper-texture, none))",
              backgroundSize: "165px 165px",
            }}
          />
          <p className="text-sm font-semibold leading-relaxed text-foreground">
            可以在此处配置 NapCat 来和 QQ 进行连接。只有在这里配置之后，你才可以让麦麦连接 QQ。
          </p>
          <div className="mt-3 flex justify-end">
            <Button disabled={confirmed.messagePlatform} onClick={confirmMessagePlatform} size="sm">
              <CheckCircle2 />
              {confirmed.messagePlatform ? "已确定" : "确定"}
            </Button>
          </div>
      </section>
    </div>
  );
}

export function DesktopShell(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState("home");
  const [webviewToolbarHost, setWebviewToolbarHost] = useState<HTMLDivElement | null>(null);
  const [webuiChatIdentity, setWebuiChatIdentity] = useState<{ userId?: string; userName?: string }>(() => ({
    userId: window.localStorage.getItem(WEBUI_CHAT_USER_ID_STORAGE_KEY) ?? undefined,
    userName: window.localStorage.getItem(WEBUI_CHAT_USER_NAME_STORAGE_KEY) ?? undefined,
  }));
  const [pluginMode, setPluginModeState] = useState<PluginPanelMode>("manage");
  const [pluginSurfaceMode, setPluginSurfaceModeState] = useState<PluginSurfaceMode>(() => readPluginSurfaceMode());
  const [pluginManageWebviewPath, setPluginManageWebviewPath] = useState(() => pluginWebuiPathForMode("manage"));
  const [pluginMarketWebviewPath, setPluginMarketWebviewPath] = useState(() => pluginWebuiPathForMode("market"));
  const [pluginManageWebviewVisited, setPluginManageWebviewVisited] = useState(true);
  const [pluginMarketWebviewVisited, setPluginMarketWebviewVisited] = useState(false);
  const [pluginBuilderMode, setPluginBuilderModeState] = useState<PluginBuilderMode>(() => readPluginBuilderMode());
  const [isStartingOpenCode, setIsStartingOpenCode] = useState(false);
  const [terminalFocusSessionId, setTerminalFocusSessionId] = useState<string | null>(null);
  const [requestedConfigPluginId, setRequestedConfigPluginId] = useState<string | null>(null);
  const [requestedDetailPluginId, setRequestedDetailPluginId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [floatingMode, setFloatingMode] = useState(false);
  const [floatingEdge, setFloatingEdge] = useState<"left" | "right" | null>(null);
  const [homeEntryGuideSeen, setHomeEntryGuideSeen] = useState(() => readStorageFlag(HOME_ENTRY_GUIDE_KEY));
  const retroTabsRef = useRef<HTMLDivElement | null>(null);
  const appearance = useAppearance();
  const theme = useTheme();
  const useRetroChrome = appearance.mode === "future-retro";

  const setPluginBuilderMode = useCallback((mode: PluginBuilderMode) => {
    setPluginBuilderModeState(mode);
    window.localStorage.setItem(PLUGIN_BUILDER_MODE_STORAGE_KEY, mode);
  }, []);

  const setPluginSurfaceMode = useCallback((mode: PluginSurfaceMode) => {
    setPluginSurfaceModeState(mode);
    window.localStorage.setItem(PLUGIN_SURFACE_MODE_STORAGE_KEY, mode);
  }, []);

  const setPluginMode = useCallback((mode: PluginPanelMode) => {
    setPluginModeState(mode);
    if (mode === "manage") {
      setPluginManageWebviewVisited(true);
    } else {
      setPluginMarketWebviewVisited(true);
    }
  }, []);

  const rememberWebuiIdentity = useCallback((identity: { userId?: string; userName?: string }) => {
    if (!identity.userId && !identity.userName) {
      return;
    }
    setWebuiChatIdentity((current) => {
      const next = {
        userId: identity.userId ?? current.userId,
        userName: identity.userName ?? current.userName,
      };
      if (next.userId) {
        window.localStorage.setItem(WEBUI_CHAT_USER_ID_STORAGE_KEY, next.userId);
      }
      if (next.userName) {
        window.localStorage.setItem(WEBUI_CHAT_USER_NAME_STORAGE_KEY, next.userName);
      }
      return next;
    });
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
  const useNativeLocalChat = snapshot?.launcherUiSettings?.chatPageMode === "native";
  const maibotChatWebviewTarget = useMemo(
    () => createMaibotChatWebviewTarget(maibotService?.url ?? MAIBOT_DEFAULT_WEBUI_URL),
    [maibotService?.url],
  );
  const maibotPluginManageWebviewTarget = useMemo(
    () => createMaibotWebviewTarget(maibotService?.url ?? MAIBOT_DEFAULT_WEBUI_URL, pluginManageWebviewPath),
    [maibotService?.url, pluginManageWebviewPath],
  );
  const maibotPluginMarketWebviewTarget = useMemo(
    () => createMaibotWebviewTarget(maibotService?.url ?? MAIBOT_DEFAULT_WEBUI_URL, pluginMarketWebviewPath),
    [maibotService?.url, pluginMarketWebviewPath],
  );
  const maibotPluginManageWebviewTitle = useMemo(
    () => pluginWebviewTitle(pluginManageWebviewPath, "manage"),
    [pluginManageWebviewPath],
  );
  const maibotPluginMarketWebviewTitle = useMemo(
    () => pluginWebviewTitle(pluginMarketWebviewPath, "market"),
    [pluginMarketWebviewPath],
  );
  const maibotWebviewReloadTrigger =
    maibotWebviewReady
      ? maibotService.url
      : null;
  const qqBackendService = serviceById.get("napcat");
  const qqBackendName =
    qqBackendService?.name ?? (snapshot?.initState.qqBackend === "snowluma" ? "SnowLuma" : "NapCat");
  const floatingCodexPet = selectedCodexPetOption(snapshot);
  const pluginEffectiveSurfaceMode: PluginSurfaceMode = pluginMode === "market" ? "webui" : pluginSurfaceMode;
  const messagePlatformConfigured = Boolean(
    snapshot?.initState.messagePlatformConfigured && snapshot.initState.qqAccount?.trim(),
  );
  const showTerminalTab = snapshot?.terminalSettings.useEmbeddedTerminal === true;
  const showTopPluginBuilderEntry =
    activeTab === "plugins" &&
    pluginMode === "manage" &&
    pluginEffectiveSurfaceMode !== "webui" &&
    pluginBuilderMode !== "disabled";
  const openCodePath = useMemo(() => opencodeExecutablePath(snapshot), [snapshot]);
  const canInterruptStartup =
    actionBusy === "all:start" ||
    services.some((service) => service.status === "starting");
  const hasActiveServiceProcess =
    actionBusy === "all:start" ||
    services.some(isServiceProcessActive);
  const showHomeEntryGuide =
    activeTab === "home" &&
    Boolean(snapshot?.startupAgreement.isConfirmed) &&
    readStorageFlag(STARTUP_WIZARD_KEY) &&
    !homeEntryGuideSeen;

  const openMaiBotRoot = useCallback(() => {
    const maibotRoot = snapshot?.paths.maibotRoot;
    if (!maibotRoot) {
      toast.error("MaiBot 根目录还没有就绪");
      return;
    }
    void window.maibotDesktop?.openPath(maibotRoot);
  }, [snapshot?.paths.maibotRoot]);

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
  const runPrimaryServiceAction = useCallback(() => {
    if (hasActiveServiceProcess) {
      stopAll();
      return;
    }
    startAll();
  }, [hasActiveServiceProcess, startAll, stopAll]);
  const primaryServiceActionLabel = hasActiveServiceProcess ? "停止全部服务" : "启动全部服务";
  const primaryServiceActionShortcut = hasActiveServiceProcess ? "Mod+Shift+X" : "Mod+Shift+S";
  const primaryServiceActionDisabled = hasActiveServiceProcess
    ? actionBusy !== null && !canInterruptStartup
    : actionBusy !== null;
  const primaryServiceActionBusy = hasActiveServiceProcess
    ? actionBusy === "all:stop"
    : actionBusy === "all:start";
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
    setFloatingEdge(null);
    void window.maibotDesktop?.window.setFloatingMode(true).then((state) => {
      setFloatingMode(state.isFloating === true);
      setFloatingEdge(state.floatingEdge ?? null);
    });
  }, []);

  const restoreMainWindow = useCallback(() => {
    setFloatingEdge(null);
    void window.maibotDesktop?.window.setFloatingMode(false).then((state) => {
      setFloatingMode(state.isFloating === true);
      setFloatingEdge(state.floatingEdge ?? null);
    });
  }, []);

  const confirmHomeEntryGuide = useCallback(() => {
    writeStorageFlag(HOME_ENTRY_GUIDE_KEY);
    setHomeEntryGuideSeen(true);
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
    setActiveTab(value);
  }, [setPluginMode, showTerminalTab]);

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
    setPluginManageWebviewPath(pluginConfigWebuiPath(pluginId));
    setRequestedConfigPluginId(pluginSurfaceMode === "native" ? pluginId : null);
    setActiveTab("plugins");
  }, [pluginSurfaceMode, setPluginMode]);

  const openPluginDetail = useCallback((pluginId: string) => {
    void pluginId;
    setPluginMode("market");
    setPluginMarketWebviewPath(pluginWebuiPathForMode("market"));
    setRequestedDetailPluginId(null);
    setActiveTab("plugins");
  }, [setPluginMode]);

  const openTerminalSession = useCallback((sessionId: string) => {
    setActiveTab("terminal");
    setTerminalFocusSessionId(null);
    window.setTimeout(() => setTerminalFocusSessionId(sessionId), 0);
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
  }, [activeTab, maibotService?.status, showTerminalTab, syncRetroTabIndicator, useRetroChrome]);

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
  useShortcut("Mod+L", openMaiBotRoot);
  useShortcut("Mod+Shift+S", startAll);
  useShortcut("Mod+Shift+X", stopAll);
  useShortcut("Mod+Shift+L", theme.toggle);

  const webviewToolbarActive =
    activeTab === "maibot" ||
    activeTab === "localchat" ||
    (activeTab === "plugins" && pluginEffectiveSurfaceMode === "webui");

  if (floatingMode) {
    return (
      <TooltipProvider delayDuration={250}>
        <FloatingShell
          codexPet={floatingCodexPet}
          edge={floatingEdge}
          maibotService={maibotService}
          onRestore={restoreMainWindow}
          onWindowState={syncWindowState}
          useNativeGlass={useRetroChrome}
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
                      <span
                        className="inline-flex h-full items-center leading-none"
                        style={{
                          color: maibotService?.status === "running" && activeTab !== "maibot" ? "var(--primary)" : undefined,
                        }}
                      >
                        MaiBot
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
                    data-home-guide-target="localchat"
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
                </TabsList>
                <div
                  className={cn(
                    webviewToolbarActive
                      ? "ml-auto flex min-w-0 flex-1 items-center justify-end"
                      : "hidden",
                    useRetroChrome ? "h-full px-2 py-1" : "h-full",
                  )}
                  ref={setWebviewToolbarHost}
                />
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-1",
                    !webviewToolbarActive && "ml-auto",
                    useRetroChrome && "py-1",
                  )}
                >
                {activeTab === "plugins" ? (
                  <>
                    {pluginMode === "manage" ? (
                      <div
                        className={cn(
                          "mr-1 flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border bg-muted/60 p-0.5",
                          useRetroChrome && "h-8 rounded-sm border-[var(--retro-line,var(--border))]",
                        )}
                      >
                        <Button
                          className="h-full rounded-sm px-2 text-[11px]"
                          onClick={() => setPluginSurfaceMode("webui")}
                          size="sm"
                          variant={pluginSurfaceMode === "webui" ? "default" : "ghost"}
                        >
                          WebUI
                        </Button>
                        <Button
                          className="h-full rounded-sm px-2 text-[11px]"
                          onClick={() => setPluginSurfaceMode("native")}
                          size="sm"
                          variant={pluginSurfaceMode === "native" ? "default" : "ghost"}
                        >
                          原生
                        </Button>
                      </div>
                    ) : null}
                    <div
                      className={cn(
                        "mr-1 flex h-8 shrink-0 items-end gap-1 bg-transparent px-1",
                        useRetroChrome && "h-9 px-1.5",
                      )}
                    >
                      <Button
                        className={cn(
                          "relative h-8 rounded-none bg-transparent px-2.5 pb-1.5 pt-1 text-[12px] font-semibold text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground",
                          "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:content-['']",
                          pluginMode === "manage" && "text-primary hover:text-primary after:bg-primary",
                          useRetroChrome && [
                            "h-9 px-3 text-sm text-[var(--retro-ink-soft,var(--muted-foreground))]",
                            "after:h-[3px] after:rounded-none",
                            pluginMode === "manage" && "text-[var(--retro-rust,var(--primary))] after:bg-[var(--retro-rust,var(--primary))]",
                          ],
                        )}
                        onClick={() => setPluginMode("manage")}
                        size="sm"
                        variant="ghost"
                      >
                        插件管理
                      </Button>
                      <Button
                        className={cn(
                          "relative h-8 rounded-none bg-transparent px-2.5 pb-1.5 pt-1 text-[12px] font-semibold text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground",
                          "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:content-['']",
                          pluginMode === "market" && "text-primary hover:text-primary after:bg-primary",
                          useRetroChrome && [
                            "h-9 px-3 text-sm text-[var(--retro-ink-soft,var(--muted-foreground))]",
                            "after:h-[3px] after:rounded-none",
                            pluginMode === "market" && "text-[var(--retro-rust,var(--primary))] after:bg-[var(--retro-rust,var(--primary))]",
                          ],
                        )}
                        onClick={() => setPluginMode("market")}
                        size="sm"
                        variant="ghost"
                      >
                        插件市场
                      </Button>
                    </div>
                    {showTopPluginBuilderEntry ? (
                      <Button
                        className={cn(
                          "mr-1 h-8 gap-1.5 px-2.5 text-[11px]",
                          useRetroChrome && "h-9 rounded-sm border-[var(--retro-line,var(--border))]",
                        )}
                        disabled={isStartingOpenCode}
                        onClick={startOpenCode}
                        size="sm"
                        title="在终端中启动 OpenCode 插件编写器"
                        variant="default"
                      >
                        {isStartingOpenCode ? <Loader2 className="size-3.5 animate-spin" /> : <TerminalSquare className="size-3.5" />}
                        启动编写器
                      </Button>
                    ) : null}
                  </>
                ) : null}
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
                        aria-label={primaryServiceActionLabel}
                        className={cn("retro-top-action w-14 border-primary bg-primary px-0 text-primary-foreground hover:bg-primary/90", retroTopActionIconClassName)}
                        disabled={primaryServiceActionDisabled}
                        onClick={runPrimaryServiceAction}
                        size="sm"
                        variant="secondary"
                      >
                        {primaryServiceActionBusy ? (
                          <Loader2 className="animate-spin" />
                        ) : hasActiveServiceProcess ? (
                          <Square />
                        ) : (
                          <Play />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span className="flex items-center gap-1">
                        {primaryServiceActionLabel} <Kbd keys={primaryServiceActionShortcut} size="xs" tone="inverse" />
                      </span>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <div className="flex shrink-0 items-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label={primaryServiceActionLabel}
                          className={cn("h-7 w-8 px-0 text-[11px]", !hasActiveServiceProcess && "rounded-r-none")}
                          disabled={primaryServiceActionDisabled}
                          onClick={runPrimaryServiceAction}
                          size="sm"
                          variant="default"
                        >
                          {primaryServiceActionBusy ? (
                            <Loader2 className="animate-spin" />
                          ) : hasActiveServiceProcess ? (
                            <Square />
                          ) : (
                            <Play />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="flex items-center gap-1">
                          {primaryServiceActionLabel} <Kbd keys={primaryServiceActionShortcut} size="xs" tone="inverse" />
                        </span>
                      </TooltipContent>
                    </Tooltip>
                    {!hasActiveServiceProcess ? (
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
                              disabled={!qqBackendService || !messagePlatformConfigured}
                              onSelect={() => startService("napcat")}
                            >
                              <Play className="size-3.5" />
                              启动 {qqBackendName}
                            </DropdownMenuPrimitive.Item>
                          </DropdownMenuPrimitive.Content>
                        </DropdownMenuPrimitive.Portal>
                      </DropdownMenuPrimitive.Root>
                    ) : null}
                  </div>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="打开 MaiBot 根目录"
                      disabled={!snapshot?.paths.maibotRoot}
                      size="icon-sm"
                      variant="ghost"
                      onClick={openMaiBotRoot}
                      className={cn(useRetroChrome ? cn("retro-top-action border-border bg-card", retroTopActionIconClassName) : "size-7")}
                    >
                      <FolderOpen />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="flex items-center gap-1">
                      打开 MaiBot 根目录 <Kbd keys="Mod+L" size="xs" tone="inverse" />
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
                  onOpenPluginDetail={openPluginDetail}
                  onOpenTab={selectTab}
                  onSnapshot={setSnapshot}
                  onRestartService={restartService}
                  onStartService={startService}
                  onStopService={stopService}
                  serviceActionBusy={actionBusy}
                  snapshot={snapshot}
                  webuiChatIdentity={webuiChatIdentity}
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
                  onWebuiIdentity={rememberWebuiIdentity}
                  title="MaiBot WebUI"
                  toolbarPlacement="external"
                  toolbarTarget={webviewToolbarHost}
                  reloadTrigger={maibotWebviewReloadTrigger}
                  url={maibotService?.url ?? MAIBOT_DEFAULT_WEBUI_URL}
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
              {useNativeLocalChat || !maibotWebviewReady ? (
                <LocalChatPanel
                  active={activeTab === "localchat"}
                  maibotService={maibotService}
                  retro={useRetroChrome}
                  toolbarPlacement="external"
                  toolbarTarget={webviewToolbarHost}
                />
              ) : (
                <WebviewPanel
                  active={activeTab === "localchat"}
                  emptyText="MaiBot Core 启动后会在这里载入 WebUI 聊聊页面。"
                  onWebuiIdentity={rememberWebuiIdentity}
                  postAuthTargetUrl={maibotChatWebviewTarget.postAuthTargetUrl}
                  title="MaiBot WebUI 聊聊"
                  toolbarPlacement="external"
                  toolbarTarget={webviewToolbarHost}
                  reloadTrigger={maibotWebviewReloadTrigger}
                  url={maibotChatWebviewTarget.entryUrl}
                />
              )}
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
              forceMount
              value="plugins"
              className="min-h-0 flex-1 overflow-hidden outline-none data-[state=inactive]:hidden"
            >
              {pluginEffectiveSurfaceMode === "webui" && !maibotWebviewReady ? (
                <MaiBotWebuiStatusPanel
                  busy={actionBusy?.startsWith("maibot:") ?? false}
                  context="plugins"
                  onStart={startService}
                  retro={useRetroChrome}
                  service={maibotService}
                />
              ) : (
                <div className="relative h-full min-h-0">
                  {maibotWebviewReady ? (
                    <div className={cn("absolute inset-0", pluginEffectiveSurfaceMode !== "webui" && "hidden")}>
                    {pluginManageWebviewVisited ? (
                      <div className={cn("absolute inset-0", pluginMode !== "manage" && "hidden")}>
                        <WebviewPanel
                          active={activeTab === "plugins" && pluginMode === "manage"}
                          emptyText="MaiBot Core 启动后会在这里载入 WebUI 插件管理页面。"
                          onWebuiIdentity={rememberWebuiIdentity}
                          postAuthTargetUrl={maibotPluginManageWebviewTarget.postAuthTargetUrl}
                          title={maibotPluginManageWebviewTitle}
                          toolbarPlacement="external"
                          toolbarTarget={webviewToolbarHost}
                          reloadTrigger={maibotWebviewReloadTrigger}
                          url={maibotPluginManageWebviewTarget.entryUrl}
                        />
                      </div>
                    ) : null}
                    {pluginMarketWebviewVisited ? (
                      <div className={cn("absolute inset-0", pluginMode !== "market" && "hidden")}>
                        <WebviewPanel
                          active={activeTab === "plugins" && pluginMode === "market"}
                          emptyText="MaiBot Core 启动后会在这里载入 WebUI 插件市场页面。"
                          onWebuiIdentity={rememberWebuiIdentity}
                          postAuthTargetUrl={maibotPluginMarketWebviewTarget.postAuthTargetUrl}
                          title={maibotPluginMarketWebviewTitle}
                          toolbarPlacement="external"
                          toolbarTarget={webviewToolbarHost}
                          reloadTrigger={maibotWebviewReloadTrigger}
                          url={maibotPluginMarketWebviewTarget.entryUrl}
                        />
                      </div>
                    ) : null}
                    </div>
                  ) : null}
                  {pluginEffectiveSurfaceMode !== "webui" ? (
                    <PluginMarketPanel
                      maibotService={maibotService}
                      maibotVersion={snapshot?.moduleVersions.maibotLocal}
                      mode="manage"
                      onOpenTerminalSession={openTerminalSession}
                      onRequestedDetailHandled={() => setRequestedDetailPluginId(null)}
                      onRequestedConfigHandled={() => setRequestedConfigPluginId(null)}
                      retro={useRetroChrome}
                      requestedConfigPluginId={requestedConfigPluginId}
                      requestedDetailPluginId={requestedDetailPluginId}
                    />
                  ) : null}
                </div>
              )}
            </TabsContent>

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
          <HomeEntryGuide open={showHomeEntryGuide} onConfirm={confirmHomeEntryGuide} />
          <Toaster />
        </div>
      </div>
    </TooltipProvider>
  );
}
