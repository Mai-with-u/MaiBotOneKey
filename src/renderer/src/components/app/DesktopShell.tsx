import {
  Bot,
  FolderOpen,
  Loader2,
  Play,
  Power,
  Radar,
  RefreshCw,
  Settings,
  Square,
  TerminalSquare,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopSnapshot, ServiceDescriptor, ServiceId, ServiceStatus } from "@shared/contracts";
import { getDesktopSnapshot, normalizeDesktopSnapshot } from "@/lib/desktop-api";
import { initializePtyLogStore } from "@/lib/pty-log-store";
import { useShortcut } from "@/lib/use-shortcut";
import { useSidebar } from "@/lib/use-sidebar";
import { useTheme } from "@/lib/use-theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsStatusPanel } from "./SettingsStatusPanel";
import { TerminalPanel } from "./TerminalPanel";
import { Titlebar } from "./Titlebar";
import { WebviewPanel } from "./WebviewPanel";
import { InitializationWizard } from "./InitializationWizard";

const statusText: Record<ServiceStatus, string> = {
  stopped: "未启动",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  error: "异常",
};

const statusVariant: Record<ServiceStatus, ComponentProps<typeof Badge>["variant"]> = {
  stopped: "outline",
  starting: "warning",
  running: "success",
  stopping: "warning",
  error: "danger",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ServiceRow({
  service,
  busy,
  onStart,
  onStop,
  onRestart,
}: {
  service: ServiceDescriptor;
  busy: boolean;
  onStart: (serviceId: ServiceId) => void;
  onStop: (serviceId: ServiceId) => void;
  onRestart: (serviceId: ServiceId) => void;
}): React.JSX.Element {
  const isTransitioning = service.status === "starting" || service.status === "stopping" || busy;
  const canStart = service.status === "stopped" || service.status === "error";
  const canStop = service.status === "running" || service.status === "starting" || service.status === "error";

  return (
    <div className="group rounded-lg border border-border/70 bg-elevated/80 px-3 py-2.5 transition-colors hover:border-border hover:bg-elevated">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
          {service.name}
        </span>
        <Badge dot variant={statusVariant[service.status]}>
          {statusText[service.status]}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] leading-relaxed text-muted-foreground">
          {service.detail ?? service.url}
        </p>
        <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          :{service.port}
        </code>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Badge
          dot={service.health !== "unknown"}
          variant={
            service.health === "ready"
              ? "success"
              : service.health === "conflict" || service.health === "unreachable"
                ? "danger"
                : service.health === "checking"
                  ? "warning"
                  : "secondary"
          }
        >
          {service.health === "ready"
            ? "端口就绪"
            : service.health === "conflict"
              ? "端口冲突"
              : service.health === "unreachable"
                ? "不可达"
                : service.health === "checking"
                  ? "检测中"
                  : "未检测"}
        </Badge>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={`启动 ${service.name}`}
            disabled={!canStart || isTransitioning}
            onClick={() => onStart(service.id)}
            size="icon"
            title="启动"
            variant="ghost"
          >
            {busy && canStart ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
          <Button
            aria-label={`停止 ${service.name}`}
            disabled={!canStop || isTransitioning}
            onClick={() => onStop(service.id)}
            size="icon"
            title="停止"
            variant="ghost"
          >
            <Square />
          </Button>
          <Button
            aria-label={`重启 ${service.name}`}
            disabled={isTransitioning}
            onClick={() => onRestart(service.id)}
            size="icon"
            title="重启"
            variant="ghost"
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function DesktopShell(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState("maibot");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const sidebar = useSidebar();
  const theme = useTheme();

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await getDesktopSnapshot();
    setSnapshot(nextSnapshot);
    return nextSnapshot;
  }, []);

  useEffect(() => {
    let mounted = true;

    initializePtyLogStore();

    refreshSnapshot().then((nextSnapshot) => {
      if (mounted) {
        setSnapshot(nextSnapshot);
      }
    });

    const removeSnapshotListener = window.maibotDesktop?.onSnapshot((nextSnapshot) => {
      setSnapshot(normalizeDesktopSnapshot(nextSnapshot));
    });
    const removeServiceListener = window.maibotDesktop?.services.onSnapshot((services) => {
      setSnapshot((current) => (current ? { ...current, services } : current));
    });
    const removeLogListener = window.maibotDesktop?.logs.onEntry((entry) => {
      setSnapshot((current) =>
        current
          ? {
            ...current,
            recentLogs: [...(current.recentLogs ?? []), entry].slice(-1000),
            }
          : current,
      );
    });

    return () => {
      mounted = false;
      removeSnapshotListener?.();
      removeServiceListener?.();
      removeLogListener?.();
    };
  }, [refreshSnapshot]);

  const services = snapshot?.services ?? [];
  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const maibotService = serviceById.get("maibot");
  const napcatService = serviceById.get("napcat");
  const runningServices = services.filter((service) => service.status === "running").length;

  const openLogs = useCallback(() => {
    void window.maibotDesktop?.openLogsDirectory();
  }, []);

  const runServiceAction = useCallback(
    async (key: string, action: () => Promise<ServiceDescriptor | ServiceDescriptor[]>) => {
      setActionBusy(key);
      setActionError(null);
      try {
        const result = await action();
        const nextServices = Array.isArray(result) ? result : [result];
        setSnapshot((current) => {
          if (!current) {
            return current;
          }

          const currentServices = current.services ?? [];
          const byId = new Map(currentServices.map((service) => [service.id, service]));
          for (const service of nextServices) {
            byId.set(service.id, service);
          }
          return { ...current, services: currentServices.map((service) => byId.get(service.id) ?? service) };
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
    void runServiceAction("all:start", async () => window.maibotDesktop?.services.startAll() ?? []);
  }, [runServiceAction]);
  const stopAll = useCallback(() => {
    void runServiceAction("all:stop", async () => window.maibotDesktop?.services.stopAll() ?? []);
  }, [runServiceAction]);
  const refreshServices = useCallback(() => {
    void runServiceAction("all:refresh", async () => window.maibotDesktop?.services.refresh() ?? []);
  }, [runServiceAction]);
  const startService = useCallback(
    (serviceId: ServiceId) => {
      void runServiceAction(`${serviceId}:start`, async () => {
        if (!window.maibotDesktop) {
          throw new Error("Electron bridge 未连接");
        }
        return window.maibotDesktop.services.start(serviceId);
      });
    },
    [runServiceAction],
  );
  const stopService = useCallback(
    (serviceId: ServiceId) => {
      void runServiceAction(`${serviceId}:stop`, async () => {
        if (!window.maibotDesktop) {
          throw new Error("Electron bridge 未连接");
        }
        return window.maibotDesktop.services.stop(serviceId);
      });
    },
    [runServiceAction],
  );
  const restartService = useCallback(
    (serviceId: ServiceId) => {
      void runServiceAction(`${serviceId}:restart`, async () => {
        if (!window.maibotDesktop) {
          throw new Error("Electron bridge 未连接");
        }
        return window.maibotDesktop.services.restart(serviceId);
      });
    },
    [runServiceAction],
  );

  // Tab switching
  useShortcut("Mod+1", () => setActiveTab("maibot"));
  useShortcut("Mod+2", () => setActiveTab("napcat"));
  useShortcut("Mod+3", () => setActiveTab("terminal"));
  useShortcut("Mod+4", () => setActiveTab("settings"));
  // Logs directory
  useShortcut("Mod+L", openLogs);
  useShortcut("Mod+Shift+S", startAll);
  useShortcut("Mod+Shift+X", stopAll);
  // Sidebar / theme
  useShortcut("Mod+B", sidebar.toggle);
  useShortcut("Mod+Shift+L", theme.toggle);

  return (
    <div className="flex h-screen min-h-0 flex-col bg-transparent text-foreground">
      <Titlebar
        appVersion={snapshot?.appVersion ?? "0.1.0"}
        installRoot={snapshot?.paths.installRoot}
        onToggleSidebar={sidebar.toggle}
        sidebarCollapsed={sidebar.collapsed}
        theme={theme}
      />
      <div className="flex min-h-0 flex-1">
      {sidebar.collapsed ? null : (
      <aside className="flex w-[248px] shrink-0 flex-col border-r border-border bg-sidebar/85 backdrop-blur-sm">
        <div className="flex h-16 items-center gap-3 px-4">
          <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm ring-1 ring-inset ring-white/10">
            <Bot className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[14px] font-semibold leading-tight tracking-tight">
              MaiBot OneKey
            </h1>
            <p className="mt-0.5 truncate text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Desktop Control Surface
            </p>
          </div>
        </div>

        <Separator />

        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            服务
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/80 tabular-nums">
            {runningServices}/{services.length} running
          </span>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          {services.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 bg-elevated/40 px-3 py-6 text-center text-xs text-muted-foreground">
              暂无服务信息
            </div>
          ) : (
            services.map((service) => (
              <ServiceRow
                busy={actionBusy?.startsWith(`${service.id}:`) ?? false}
                key={service.id}
                onRestart={restartService}
                onStart={startService}
                onStop={stopService}
                service={service}
              />
            ))
          )}
          {actionError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-[11px] leading-relaxed text-destructive">
              {actionError}
            </div>
          ) : null}
        </div>

        <Separator />

        <div className="grid gap-2 px-4 py-4">
          <Button
            className="w-full justify-between"
            disabled={actionBusy !== null}
            onClick={startAll}
          >
            <span className="flex items-center gap-2">
              {actionBusy === "all:start" ? <Loader2 className="animate-spin" /> : <Power />}
              启动全部服务
            </span>
            <Kbd keys="Mod+Shift+S" tone="inverse" />
          </Button>
          <Button
            className="w-full justify-between"
            disabled={actionBusy !== null}
            onClick={stopAll}
            variant="outline"
          >
            <span className="flex items-center gap-2">
              {actionBusy === "all:stop" ? <Loader2 className="animate-spin" /> : <Square />}
              停止全部服务
            </span>
            <Kbd keys="Mod+Shift+X" />
          </Button>
          <Button
            className="w-full justify-center"
            disabled={actionBusy !== null}
            onClick={refreshServices}
            variant="ghost"
          >
            {actionBusy === "all:refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新服务状态
          </Button>
        </div>
      </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-panel/70">
        <Tabs className="flex min-h-0 flex-1 flex-col" onValueChange={setActiveTab} value={activeTab}>
          <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-panel/85 px-3 backdrop-blur-sm">
            <TabsList className="h-7 rounded-md border border-border/70 bg-muted/45 p-0.5">
              <TabsTrigger className="h-6 px-2 text-[11px]" value="maibot">
                <Radar />
                MaiBot
                <Kbd className="ml-1" keys="Mod+1" size="xs" tone="muted" />
              </TabsTrigger>
              <TabsTrigger className="h-6 px-2 text-[11px]" value="napcat">
                <Bot />
                NapCat
                <Kbd className="ml-1" keys="Mod+2" size="xs" tone="muted" />
              </TabsTrigger>
              <TabsTrigger className="h-6 px-2 text-[11px]" value="terminal">
                <TerminalSquare />
                终端
                <Kbd className="ml-1" keys="Mod+3" size="xs" tone="muted" />
              </TabsTrigger>
              <TabsTrigger className="h-6 px-2 text-[11px]" value="settings">
                <Settings />
                设置
                <Kbd className="ml-1" keys="Mod+4" size="xs" tone="muted" />
              </TabsTrigger>
            </TabsList>

            <div className="hidden h-4 w-px shrink-0 bg-border md:block" />

            <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                工作区
              </span>
              <code
                className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
                title={snapshot?.paths.installRoot}
              >
                {snapshot?.paths.installRoot ?? "读取中…"}
              </code>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Badge className="hidden lg:inline-flex" variant="secondary">
                v{snapshot?.appVersion ?? "0.1.0"}
              </Badge>
              <Button className="h-7 px-2 text-[11px]" onClick={openLogs} size="sm" variant="outline">
                <FolderOpen />
                日志
                <Kbd className="ml-1" keys="Mod+L" size="xs" tone="muted" />
              </Button>
            </div>
          </div>

          <TabsContent className="min-h-0 flex-1" value="maibot">
            <WebviewPanel
              active={activeTab === "maibot"}
              emptyText="MaiBot Core 启动后会在这里载入官方 WebUI。"
              title="MaiBot WebUI"
              url={maibotService?.url ?? "http://127.0.0.1:8001"}
            />
          </TabsContent>

          <TabsContent className="min-h-0 flex-1" value="napcat">
            <WebviewPanel
              active={activeTab === "napcat"}
              emptyText="NapCat 启动后会在这里打开它自己的 WebUI。"
              title="NapCat WebUI"
              url={napcatService?.url ?? "http://127.0.0.1:6099/webui"}
            />
          </TabsContent>

          <TabsContent className="min-h-0 flex-1" value="terminal">
            <TerminalPanel active={activeTab === "terminal"} services={services} />
          </TabsContent>

          <TabsContent className="min-h-0 flex-1 overflow-hidden" value="settings">
            {snapshot ? (
              <SettingsStatusPanel onSnapshot={setSnapshot} snapshot={snapshot} />
            ) : (
              <div className="p-6">
                <Card>
                  <CardHeader>
                    <CardTitle>正在读取状态</CardTitle>
                    <CardDescription>
                      初始化 Electron bridge 后会显示运行目录和服务端口。
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-1.5 w-48 overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>
      </div>
      {snapshot ? <InitializationWizard onSnapshot={setSnapshot} snapshot={snapshot} /> : null}
    </div>
  );
}
