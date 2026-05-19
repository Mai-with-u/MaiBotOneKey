import {
  FolderOpen,
  GripHorizontal,
  Home,
  Loader2,
  MessageSquare,
  Play,
  Puzzle,
  Radar,
  RefreshCw,
  Settings,
  Square,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DesktopSnapshot,
  ServiceDescriptor,
  ServiceId,
  ServiceStatus,
} from "@shared/contracts";
import { getDesktopSnapshot, normalizeDesktopSnapshot } from "@/lib/desktop-api";
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
import { QuickActionsPanel } from "./QuickActionsPanel";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ServiceChip({
  service,
  busy,
  onStart,
  onStop,
  onRestart,
}: {
  service: ServiceDescriptor;
  busy: boolean;
  onStart: (id: ServiceId) => void;
  onStop: (id: ServiceId) => void;
  onRestart: (id: ServiceId) => void;
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
    <div className="flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-full border border-border bg-card pr-1 pl-2.5">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", statusDotColor[service.status])}
      />
      <span className="min-w-0 truncate text-[12px] font-medium">{service.name}</span>
      <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
        {statusText[service.status]}
      </span>
      <div className="ml-1 flex shrink-0 items-center gap-0.5">
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
    </div>
  );
}

function FloatingShell({
  expanded,
  maibotService,
  onExpand,
  onCollapse,
  onRestore,
}: {
  expanded: boolean;
  maibotService: ServiceDescriptor | undefined;
  onExpand: () => void;
  onCollapse: () => void;
  onRestore: () => void;
}): React.JSX.Element {
  if (!expanded) {
    return (
      <div className="grid h-screen place-items-center bg-transparent" data-floating-shell="true">
        <button
          className="relative grid size-20 place-items-center overflow-hidden rounded-full border border-primary/30 bg-card shadow-xl transition-transform hover:scale-105"
          data-app-region="no-drag"
          onClick={onExpand}
          title="打开悬浮菜单"
          type="button"
        >
          <span className="absolute inset-x-3 bottom-1 h-7 rounded-full bg-primary/10 blur-md" />
          <img alt="" className="relative mt-3 w-20 select-none" draggable={false} src={maiMascotImage} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl" data-floating-shell="true">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-2" data-app-region="drag">
        <GripHorizontal className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">MaiBot 悬浮球</span>
        <div className="flex shrink-0 items-center gap-1" data-app-region="no-drag">
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

export function DesktopShell(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState("home");
  const [pluginMode, setPluginMode] = useState<"market" | "manage">("manage");
  const [requestedConfigPluginId, setRequestedConfigPluginId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [floatingMode, setFloatingMode] = useState(false);
  const [floatingExpanded, setFloatingExpanded] = useState(false);
  const theme = useTheme();

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
      }
    });
    const offWindowState = window.maibotDesktop?.window.onState((state) => {
      if (typeof state.isFloating === "boolean") {
        setFloatingMode(state.isFloating);
      }
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
  const visibleServiceChips = services.filter(
    (service) => service.id === "maibot" || messagePlatformReady,
  );
  const serviceById = useMemo(
    () => new Map(services.map((s) => [s.id, s])),
    [services],
  );
  const maibotService = serviceById.get("maibot");
  const showTerminalTab = snapshot?.terminalSettings.useEmbeddedTerminal === true;
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
  const refreshServices = useCallback(() => {
    void runServiceAction(
      "all:refresh",
      async () => window.maibotDesktop?.services.refresh() ?? [],
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
    void window.maibotDesktop?.window.setFloatingMode(true).then((state) => {
      setFloatingMode(state.isFloating === true);
    });
  }, []);

  const setFloatingPanel = useCallback((expanded: boolean) => {
    setFloatingExpanded(expanded);
    void window.maibotDesktop?.window.setFloatingPanelExpanded(expanded);
  }, []);

  const restoreMainWindow = useCallback(() => {
    setFloatingExpanded(false);
    void window.maibotDesktop?.window.setFloatingMode(false).then((state) => {
      setFloatingMode(state.isFloating === true);
    });
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
  }, [showTerminalTab]);

  const openPluginConfig = useCallback((pluginId: string) => {
    setPluginMode("manage");
    setRequestedConfigPluginId(pluginId);
    setActiveTab("plugins");
  }, []);

  useEffect(() => {
    if (activeTab === "terminal" && !showTerminalTab) {
      setActiveTab("home");
    }
  }, [activeTab, showTerminalTab]);

  // Shortcuts
  useShortcut("Mod+1", () => selectTab("home"));
  useShortcut("Mod+2", () => selectTab("maibot"));
  useShortcut("Mod+3", () => selectTab("localchat"));
  useShortcut("Mod+4", () => selectTab("terminal"), { enabled: showTerminalTab });
  useShortcut("Mod+5", () => selectTab("quickactions"));
  useShortcut("Mod+6", () => selectTab("pluginmarket"));
  useShortcut("Mod+7", () => selectTab("pluginmanage"));
  useShortcut("Mod+8", () => selectTab("settings"));
  useShortcut("Mod+L", openLogs);
  useShortcut("Mod+Shift+S", startAll);
  useShortcut("Mod+Shift+X", stopAll);
  useShortcut("Mod+Shift+L", theme.toggle);

  if (floatingMode) {
    return (
      <TooltipProvider delayDuration={250}>
        <FloatingShell
          expanded={floatingExpanded}
          maibotService={maibotService}
          onCollapse={() => setFloatingPanel(false)}
          onExpand={() => setFloatingPanel(true)}
          onRestore={restoreMainWindow}
        />
        <Toaster />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
        <Titlebar
          appVersion={snapshot?.appVersion ?? "0.1.0"}
          theme={theme}
        />

        {/* Service strip */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleServiceChips.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">
                等待服务发现…
              </span>
            ) : (
              visibleServiceChips.map((service) => (
                <ServiceChip
                  key={service.id}
                  service={service}
                  busy={actionBusy?.startsWith(`${service.id}:`) ?? false}
                  onStart={startService}
                  onStop={stopService}
                  onRestart={restartService}
                />
              ))
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
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
                <span className="flex items-center gap-1">
                  设置 <Kbd keys="Mod+8" size="xs" tone="inverse" />
                </span>
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
                  size="icon-sm"
                  variant="ghost"
                  onClick={refreshServices}
                  disabled={actionBusy !== null}
                  aria-label="刷新服务"
                >
                  {actionBusy === "all:refresh" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RefreshCw />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新服务状态</TooltipContent>
            </Tooltip>
          </div>
        </div>

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
            <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-background px-3">
              <TabsList className="h-8">
                <TabsTrigger value="home" className="gap-1.5">
                  <Home />
                  首页
                  <Kbd keys="Mod+1" size="xs" tone="muted" className="ml-1" />
                </TabsTrigger>
                <TabsTrigger value="maibot" className="gap-1.5">
                  <Radar />
                  MaiBot
                  <Kbd keys="Mod+2" size="xs" tone="muted" className="ml-1" />
                </TabsTrigger>
                <TabsTrigger value="localchat" className="gap-1.5">
                  <MessageSquare />
                  随便聊聊
                  <Kbd keys="Mod+3" size="xs" tone="muted" className="ml-1" />
                </TabsTrigger>
                {showTerminalTab ? (
                  <TabsTrigger value="terminal" className="gap-1.5">
                    <TerminalSquare />
                    终端
                    <Kbd keys="Mod+4" size="xs" tone="muted" className="ml-1" />
                  </TabsTrigger>
                ) : null}
                <TabsTrigger value="quickactions" className="gap-1.5">
                  <Wrench />
                  快捷操作
                  <Kbd keys="Mod+5" size="xs" tone="muted" className="ml-1" />
                </TabsTrigger>
                <TabsTrigger value="plugins" className="gap-1.5">
                  <Puzzle />
                  插件
                  <Kbd keys="Mod+6" size="xs" tone="muted" className="ml-1" />
                </TabsTrigger>
              </TabsList>
              <div className="ml-auto flex shrink-0 items-center gap-1">
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
                  services={services}
                  terminalSettings={snapshot?.terminalSettings}
                  maibotRoot={snapshot?.paths.maibotRoot}
                />
              </TabsContent>
            ) : null}

            <TabsContent
              value="quickactions"
              className="min-h-0 flex-1 overflow-hidden outline-none"
            >
              <QuickActionsPanel />
            </TabsContent>

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
              value="settings"
              className="min-h-0 flex-1 overflow-hidden outline-none"
            >
              {snapshot ? (
                <SettingsStatusPanel
                  onOpenPluginConfig={openPluginConfig}
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
    </TooltipProvider>
  );
}
