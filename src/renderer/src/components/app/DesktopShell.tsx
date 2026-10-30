import { startupLogs } from "@/lib/startup-logs";
import { requestMessagePlatformGuide } from "@/lib/message-platform-guide";
import {
  ChevronDown,
  Fish,
  FolderOpen,
  Info,
  MessageSquare,
  Loader2,
  Play,
  Settings,
  Square,
  TerminalSquare,
  Unplug,
  X,
} from "lucide-react";
import { type CSSProperties, type FocusEvent, type PointerEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { toast } from "sonner";
import type {
  DesktopSnapshot,
  ServiceDescriptor,
  ServiceId,
  WindowState,
  WindowResizeEdge,
} from "@shared/contracts";
import { getDesktopSnapshot, validateDesktopSnapshot } from "@/lib/desktop-api";
import { useAppearance, usesRetroStructure } from "@/lib/use-appearance";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DependencyPreparationNotice } from "./DependencyPreparationNotice";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { MessagePlatformPanel } from "./MessagePlatformPanel";
import { MillenniumStatusPanel, type MillenniumServicePhase } from "./MillenniumStatusPanel";
import { MaiBotOverviewCard } from "./MaiBotOverviewCard";
import { InitializationWizard, readStartupWizardSeen } from "./InitializationWizard";
import { SettingsStatusPanel } from "./SettingsStatusPanel";
import { StartupAgreementPage } from "./StartupAgreementPage";
import { TerminalPanel } from "./TerminalPanel";
import { Titlebar } from "./Titlebar";
import { WebviewPanel } from "./WebviewPanel";

function isServiceProcessActive(service: ServiceDescriptor): boolean {
  return service.managed || service.status === "starting" || service.status === "running" || service.status === "stopping";
}

const MAIBOT_DEFAULT_WEBUI_URL = "http://127.0.0.1:8001";
const MAIBOT_CHAT_WEBUI_PATH = "/chat/embed";
const toolbarMenuItemClassName =
  "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
const retroTopActionIconClassName =
  "[&_svg]:fill-none [&_svg]:stroke-[3] [&_svg]:[stroke-linecap:square] [&_svg]:[stroke-linejoin:miter]";
const tabPageTransitionClassName =
  "absolute inset-0 min-h-0 overflow-hidden outline-none transition-transform duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

function tabPageTransitionStyle(
  tab: string,
  activeTab: string,
  tabOrder: string[],
): CSSProperties {
  const tabIndex = tabOrder.indexOf(tab);
  const activeTabIndex = tabOrder.indexOf(activeTab);
  const offset = tabIndex < activeTabIndex ? -100 : tabIndex > activeTabIndex ? 100 : 0;
  const active = tab === activeTab;

  return {
    pointerEvents: active ? "auto" : "none",
    transform: `translate3d(${offset}%, 0, 0)`,
    zIndex: active ? 1 : 0,
  };
}

interface WebviewEntryTarget {
  entryUrl: string;
  targetUrl: string;
}

function pluginConfigWebuiPath(pluginId: string): string {
  const params = new URLSearchParams({ plugin: pluginId });
  const path = pluginId === "maibot-team.snowluma-adapter" ? "/adapter-management" : "/plugin-config";
  return `${path}?${params.toString()}`;
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

    if (isAuthEntry) {
      entryUrl.searchParams.set(
        "redirect",
        `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`,
      );
    }

    return {
      entryUrl: isAuthEntry ? entryUrl.toString() : targetUrl.toString(),
      targetUrl: targetUrl.toString(),
    };
  } catch {
    return { entryUrl: url, targetUrl: url };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syncWindowShadow(state: WindowState): void {
  document.documentElement.dataset.windowShadow =
    state.isMaximized || state.isFullScreen || state.isMiniMode ? "false" : "true";
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

function MaiBotOfflineIllustration({ waiting }: { waiting: boolean }): React.JSX.Element {
  const screenGradientId = `maibot-offline-screen-${useId().replace(/:/gu, "")}`;

  return (
    <svg
      aria-hidden
      className="mx-auto h-auto w-[min(385px,52vw)] text-[var(--retro-ink,var(--foreground))]"
      fill="none"
      viewBox="0 0 320 220"
    >
      <defs>
        <linearGradient id={screenGradientId} x1="76" x2="244" y1="46" y2="128" gradientUnits="userSpaceOnUse">
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
        fill={`url(#${screenGradientId})`}
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

function PluginOfflineIllustration({ waiting }: { waiting: boolean }): React.JSX.Element {
  return (
    <div
      aria-hidden
      className="mx-auto grid aspect-[320/220] w-[min(385px,52vw)] place-items-center text-[var(--retro-ink,var(--foreground))]"
    >
      <Unplug
        className={cn("size-40", waiting && "animate-pulse")}
        strokeWidth={1.4}
      />
    </div>
  );
}

function MaiBotWebuiStatusPanel({
  service,
  busy,
  onStart,
  retro,
  millennium = false,
  onStop,
  onOpenTerminal,
  onOpenFolder,
  onOpenSettings,
  context = "webui",
}: {
  service: ServiceDescriptor | undefined;
  busy: boolean;
  onStart: (id: ServiceId) => void;
  retro: boolean;
  millennium?: boolean;
  onStop?: (id: ServiceId) => void;
  onOpenTerminal?: () => void;
  onOpenFolder?: () => void;
  onOpenSettings?: () => void;
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

  if (millennium && !pluginContext) {
    const phase: MillenniumServicePhase = !service
      ? "missing"
      : status === "stopped"
        ? busy ? "booting" : "standby"
        : status === "starting"
          ? "booting"
          : status === "running"
            ? showWebUiUnavailable ? "unreachable" : "linking"
            : status === "stopping"
              ? "stopping"
              : "error";
    return (
      <MillenniumStatusPanel
        busy={busy}
        onOpenFolder={onOpenFolder}
        onOpenSettings={onOpenSettings}
        onOpenTerminal={onOpenTerminal}
        onStart={service ? () => onStart(service.id) : undefined}
        onStop={service && onStop ? () => onStop(service.id) : undefined}
        phase={phase}
        title={title}
      />
    );
  }

  return (
    <section className="relative grid h-full min-h-0 place-items-center overflow-hidden bg-transparent p-6 text-[var(--retro-ink,var(--foreground))]">
      <div className="relative z-10 flex w-full max-w-[530px] flex-col items-center text-center">
        {retro
          ? pluginContext
            ? <PluginOfflineIllustration waiting={waiting} />
            : <MaiBotOfflineIllustration waiting={waiting} />
          : null}

        <h3 className={cn(retro ? "mt-4" : "mt-0", "text-[34px] font-black leading-tight tracking-[0.02em] text-[var(--retro-ink,var(--foreground))]")}>
          {title}
        </h3>

        <div className="my-7 flex w-full items-center gap-3 text-[var(--retro-ink-soft,var(--muted-foreground))]">
          <span className="size-2.5 rounded-full bg-current opacity-70" />
          <span className="h-px flex-1 bg-current opacity-45" />
          <span className="size-2.5 rounded-full bg-current opacity-70" />
        </div>

        <div className="status-hint-box w-[min(500px,100%)] border-2 border-[var(--retro-line,var(--border))] bg-[var(--retro-recessed,transparent)] px-4 py-3 text-left">
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
  const [activeTab, setActiveTab] = useState("maibot");
  const [preparing, setPreparing] = useState(() => !readStartupWizardSeen());
  const [maiBotPageState, setMaiBotPageState] = useState<"loading" | "ready" | "error">("loading");
  const openMessagePlatformFromWebui = useCallback(() => setActiveTab("message-platform"), []);
  const [webviewToolbarHost, setWebviewToolbarHost] = useState<HTMLDivElement | null>(null);
  const [maibotCoreHost, setMaibotCoreHost] = useState<HTMLDivElement | null>(null);
  const [maibotUpdateHost, setMaibotUpdateHost] = useState<HTMLDivElement | null>(null);
  const [maibotWebviewPath, setMaibotWebviewPath] = useState<string | null>("/");
  const [maibotWebviewNavigationRequest, setMaibotWebviewNavigationRequest] = useState(0);
  const reloadStartupWebui = useCallback(() => {
    setMaiBotPageState("loading");
    setMaibotWebviewNavigationRequest((current) => current + 1);
  }, []);
  const [terminalFocusSessionId, setTerminalFocusSessionId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const retroTabsRef = useRef<HTMLDivElement | null>(null);
  const appearance = useAppearance();
  const useRetroChrome = usesRetroStructure(appearance.mode);

  const refreshSnapshot = useCallback(async () => {
    const next = await getDesktopSnapshot();
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    let mounted = true;
    refreshSnapshot().then((next) => {
      if (mounted) setSnapshot(next);
    }).catch((error) => { if (mounted) setActionError(errorMessage(error)); });

    const offSnapshot = window.maibotDesktop?.onSnapshot((next) => {
      try {
        setSnapshot(validateDesktopSnapshot(next));
      } catch (error) {
        setActionError(errorMessage(error));
      }
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
        syncWindowShadow(state);
      }
    });
    const offWindowState = window.maibotDesktop?.window.onState((state) => {
      syncWindowShadow(state);
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
  const dependencyMigrationLogs = useMemo(
    () => startupLogs(snapshot?.recentLogs ?? []),
    [snapshot?.recentLogs],
  );
  // Process startup precedes HTTP readiness. Keep the status page until the
  // service is reachable; WebviewPanel then waits for the frontend to render.
  const maibotWebviewAvailable =
    maibotService?.status === "running" && maibotService.health === "ready";
  const maibotWebviewTarget = useMemo(
    () => maibotWebviewPath
      ? createMaibotWebviewTarget(maibotService?.url ?? MAIBOT_DEFAULT_WEBUI_URL, maibotWebviewPath)
      : { entryUrl: maibotService?.url ?? MAIBOT_DEFAULT_WEBUI_URL, targetUrl: undefined },
    [maibotService?.url, maibotWebviewPath],
  );
  const qqBackendService = serviceById.get("napcat");
  const qqBackendName =
    qqBackendService?.name ?? (snapshot?.initState.qqBackend === "snowluma" ? "SnowLuma" : "NapCat");
  const messagePlatformConfigured = Boolean(
    snapshot?.initState.messagePlatformConfigured,
  );
  const showTerminalTab = snapshot?.terminalSettings.useEmbeddedTerminal === true;
  const tabPageOrder = useMemo(
    () => [
      "maibot",
      ...(showTerminalTab ? ["terminal"] : []),
      "message-platform",
      "settings",
    ],
    [showTerminalTab],
  );
  const primaryServiceActionTransitioning =
    actionBusy !== null || Boolean(snapshot?.runtimeOperation) ||
    services.some((service) => service.status === "starting" || service.status === "stopping");
  const hasActiveServiceProcess = services.some(isServiceProcessActive);
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

  useEffect(() => window.maibotDesktop?.onQqAccountSetupRequired((backend) => {
    setActionError(null);
    setActiveTab("message-platform");
    requestMessagePlatformGuide(backend);
  }), []);

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
    if (primaryServiceActionTransitioning) {
      return;
    }
    if (hasActiveServiceProcess) {
      stopAll();
      return;
    }
    startAll();
  }, [hasActiveServiceProcess, primaryServiceActionTransitioning, startAll, stopAll]);
  const primaryServiceActionLabel = snapshot?.runtimeOperation ? `正在${snapshot.runtimeOperation}` : primaryServiceActionTransitioning
    ? actionBusy?.includes(":stop") || actionBusy === "all:stop" || services.some((service) => service.status === "stopping")
      ? "正在停止服务"
      : "正在启动服务"
    : hasActiveServiceProcess ? "停止全部服务" : "启动全部服务";
  const primaryServiceActionDisabled = primaryServiceActionTransitioning;
  const startService = useCallback(
    (id: ServiceId) => {
      void runServiceAction(`${id}:start`, async () => {
        if (!window.maibotDesktop) throw new Error("Electron bridge 未连接");
        return window.maibotDesktop.services.start(id);
      });
    },
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
  const selectTab = useCallback((value: string) => {
    if (value === "maibot") {
      // Returning to the tab must preserve the guest's current document and route.
      setActiveTab("maibot");
      return;
    }
    if (value === "localchat") {
      setMaibotWebviewPath(MAIBOT_CHAT_WEBUI_PATH);
      setMaibotWebviewNavigationRequest((request) => request + 1);
      setActiveTab("maibot");
      return;
    }
    if (value === "terminal" && !showTerminalTab) {
      setActiveTab("maibot");
      return;
    }
    if (value === "pluginmarket") {
      setMaibotWebviewPath("/plugins");
      setActiveTab("maibot");
      return;
    }
    if (value === "pluginmanage") {
      setMaibotWebviewPath("/plugin-config");
      setActiveTab("maibot");
      return;
    }
    setActiveTab(value);
  }, [showTerminalTab]);

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
    setMaibotWebviewPath(pluginConfigWebuiPath(pluginId));
    setMaibotWebviewNavigationRequest((request) => request + 1);
    setActiveTab("maibot");
  }, []);

  const openTerminalSession = useCallback((sessionId: string) => {
    if (!showTerminalTab) {
      toast.error("请先在设置中启用内嵌终端");
      return;
    }
    setActiveTab("terminal");
    setTerminalFocusSessionId(null);
    window.setTimeout(() => setTerminalFocusSessionId(sessionId), 0);
  }, [showTerminalTab]);

  useEffect(() => {
    if (activeTab === "terminal" && !showTerminalTab) {
      setActiveTab("maibot");
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

  const webviewToolbarActive = activeTab === "maibot";

  const toolbarActions = (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1",
        !webviewToolbarActive && "ml-auto",
        useRetroChrome && "py-1",
      )}
    >
    <div className="flex items-center" ref={setMaibotUpdateHost} />
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
            {primaryServiceActionTransitioning ? (
              <Loader2 className="animate-spin" />
            ) : hasActiveServiceProcess ? (
              <Square />
            ) : (
              <Play />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {primaryServiceActionLabel}
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
              {primaryServiceActionTransitioning ? (
                <Loader2 className="animate-spin" />
              ) : hasActiveServiceProcess ? (
                <Square />
              ) : (
                <Play />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {primaryServiceActionLabel}
          </TooltipContent>
        </Tooltip>
        {!hasActiveServiceProcess && !primaryServiceActionTransitioning ? (
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
        打开 MaiBot 根目录
      </TooltipContent>
    </Tooltip>
  </div>
  );

  const navigationTabs = (
    <TabsList
      className={cn(useRetroChrome ? "retro-tabs retro-folder-tabs h-full" : "h-8 bg-card")}
      onFocusCapture={handleRetroTabsFocus}
      onPointerDown={handleRetroTabsPointerDown}
      onPointerLeave={handleRetroTabsPointerLeave}
      onPointerOver={handleRetroTabsPointerOver}
      ref={retroTabsRef}
    >

      <TabsTrigger
        data-retro-active={useRetroChrome && activeTab === "maibot" ? "true" : undefined}
        data-retro-tab-item={useRetroChrome ? "true" : undefined}
        data-retro-tab-value={useRetroChrome ? "maibot" : undefined}
        value="maibot"
        onClick={() => {
          if (activeTab === "maibot") {
            selectTab("maibot");
          }
        }}
        className={cn("gap-1.5", useRetroChrome && "px-5")}
        style={{
          color: maibotService?.status === "running" && activeTab !== "maibot" ? "var(--primary)" : undefined,
        }}
      >
        {!useRetroChrome ? <Fish /> : null}
        MaiBot
      </TabsTrigger>
      {showTerminalTab ? (
        <TabsTrigger
          data-retro-active={useRetroChrome && activeTab === "terminal" ? "true" : undefined}
          data-retro-tab-item={useRetroChrome ? "true" : undefined}
          data-retro-tab-value={useRetroChrome ? "terminal" : undefined}
          value="terminal"
          className={cn("gap-1.5", useRetroChrome && "px-5")}
        >
          {!useRetroChrome ? <TerminalSquare /> : null}
          终端
        </TabsTrigger>
      ) : null}
      <TabsTrigger
        data-retro-active={useRetroChrome && activeTab === "message-platform" ? "true" : undefined}
        data-retro-tab-item={useRetroChrome ? "true" : undefined}
        data-retro-tab-value={useRetroChrome ? "message-platform" : undefined}
        value="message-platform"
        className={cn("gap-1.5", useRetroChrome && "px-5")}
      >
        {!useRetroChrome ? <MessageSquare /> : null}
        消息平台
      </TabsTrigger>
    </TabsList>
  );

  const maibotWebuiStatusPanel = (
    <MaiBotWebuiStatusPanel
      busy={actionBusy?.startsWith("maibot:") ?? false}
      millennium={appearance.mode === "millennium"}
      onOpenFolder={openMaiBotRoot}
      onOpenSettings={() => selectTab("settings")}
      onOpenTerminal={showTerminalTab ? () => selectTab("terminal") : undefined}
      onStart={startService}
      onStop={stopService}
      retro={useRetroChrome}
      service={maibotService}
    />
  );

  const agreementPending = Boolean(snapshot && !snapshot.startupAgreement.isDismissed);
  // Until the first snapshot arrives, neither agreement nor preparation is known.
  const onboarding = !snapshot || preparing || agreementPending;
  const preloadMaiBot = preparing && !agreementPending && maibotService?.status === "running" && maibotService.health === "ready";

  return (
    <TooltipProvider delayDuration={250}>
      <WindowResizeHandles />
      <div
        className={cn(
          "relative flex h-full min-h-0 flex-col overflow-hidden text-foreground",
          "bg-background",
          useRetroChrome && "retro-shell",
        )}
      >
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <Tabs
            value={activeTab}
            onValueChange={selectTab}
            className="flex min-h-0 flex-1 flex-col"
          >
          <Titlebar
            serviceStatus={maibotService?.status}
            coreHostRef={setMaibotCoreHost}
            brand={onboarding ? <MaiBotOverviewCard localVersion={snapshot?.moduleVersions.maibotLocal} launcherVersion={snapshot?.appVersion ?? "0.7.0"} retro={useRetroChrome} /> : undefined}
            appVersion={snapshot?.appVersion ?? "0.1.0"}
            retro={useRetroChrome}
            navigation={onboarding ? undefined : navigationTabs}
            toolbar={!onboarding && (
              <div className="ml-3 flex min-w-0 flex-1 items-center">
                <div className={cn("min-w-0 flex-1", webviewToolbarActive ? "flex h-full items-center" : "hidden")} ref={setWebviewToolbarHost} />
              </div>
            )}
            actions={!onboarding && (
              <>
                {toolbarActions}
              </>
            )}
          />

          {!onboarding && actionError ? (
            <div className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-[12px] text-destructive" role="alert">
              <span className="min-w-0 flex-1 break-words">{actionError}</span>
              <Button aria-label="关闭错误提示" className="size-6" onClick={() => setActionError(null)} size="icon-sm" variant="ghost">
                <X />
              </Button>
            </div>
          ) : null}

          {snapshot && agreementPending ? (
            <StartupAgreementPage onSnapshot={setSnapshot} snapshot={snapshot} />
          ) : null}
          {snapshot ? (
            <InitializationWizard
              onOpenTab={selectTab}
              onSnapshot={setSnapshot}
              onPreparingChange={setPreparing}
              webuiState={maiBotPageState}
              onReloadWebui={reloadStartupWebui}
              snapshot={snapshot}
            />
          ) : (
            <main className="grid min-h-0 flex-1 place-items-center p-5" aria-busy={!actionError} aria-label="正在读取启动状态">
              {actionError ? <div role="alert" className="grid max-w-md justify-items-center gap-3 text-sm">
                <p className="break-words text-destructive">{actionError}</p>
                <Button size="sm" onClick={() => {
                setActionError(null);
                void refreshSnapshot().catch((error) => setActionError(errorMessage(error)));
                }}>重试</Button>
              </div> : <span role="status" className="sr-only">正在读取启动状态</span>}
            </main>
          )}
          {/* Main */}
          {!onboarding || preloadMaiBot ? <main
            className="flex min-h-0 flex-1 flex-col"
            inert={onboarding}
            style={onboarding ? { position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" } : { viewTransitionName: "startup-screen" }}
          >
            <div className="relative min-h-0 flex-1 overflow-hidden">
            <TabsContent
              forceMount
              inert={activeTab !== "message-platform"}
              value="message-platform"
              className={tabPageTransitionClassName}
              style={tabPageTransitionStyle("message-platform", activeTab, tabPageOrder)}
            >
              {snapshot && !onboarding ? (
                <MessagePlatformPanel
                  coreToolbarTarget={maibotCoreHost}
                  updateToolbarTarget={maibotUpdateHost}
                  active={activeTab === "message-platform"}
                  onOpenPluginConfig={openPluginConfig}
                  onOpenTerminalSession={openTerminalSession}
                  onSnapshot={setSnapshot}
                  onStartService={startService}
                  onStopService={stopService}
                  serviceActionBusy={actionBusy}
                  snapshot={snapshot}
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在读取消息平台状态
                  </span>
                </div>
              )}
            </TabsContent>

            <TabsContent
              forceMount
              inert={activeTab !== "maibot"}
              value="maibot"
              className={tabPageTransitionClassName}
              style={tabPageTransitionStyle("maibot", activeTab, tabPageOrder)}
            >
              {maibotWebviewAvailable ? (
                <WebviewPanel
                  onLoadStateChange={setMaiBotPageState}
                  animateLoad={!preparing}
                  active={activeTab === "maibot"}
                  onMessagePlatformRequest={openMessagePlatformFromWebui}
                  readMaiBotAppearance
                  loadingFallback={maibotWebuiStatusPanel}
                  title="MaiBot WebUI"
                  toolbarPlacement="external"
                  toolbarTarget={webviewToolbarHost}
                  reloadTrigger={maibotWebviewNavigationRequest}
                  url={maibotWebviewTarget.entryUrl}
                  navigationTargetUrl={maibotWebviewTarget.targetUrl}
                />
              ) : (
                maibotWebuiStatusPanel
              )}
            </TabsContent>

            {showTerminalTab ? (
              <TabsContent
                forceMount
                inert={activeTab !== "terminal"}
                value="terminal"
                className={tabPageTransitionClassName}
                style={tabPageTransitionStyle("terminal", activeTab, tabPageOrder)}
              >
                <TerminalPanel
                  active={activeTab === "terminal"}
                  onStartService={startService}
                  onStopService={stopService}
                  serviceActionBusy={actionBusy}
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
              inert={activeTab !== "settings"}
              value="settings"
              className={cn(tabPageTransitionClassName, "settings-scroll-scope")}
              style={tabPageTransitionStyle("settings", activeTab, tabPageOrder)}
            >
              {snapshot ? (
                <SettingsStatusPanel
                  onSnapshot={setSnapshot}
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
            </div>
        </main> : null}
          </Tabs>



          {!onboarding ? <DependencyPreparationNotice logs={dependencyMigrationLogs} service={maibotService} /> : null}
          <Toaster />
        </div>
      </div>
    </TooltipProvider>
  );
}
