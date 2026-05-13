import {
  Activity,
  ArrowRight,
  Download,
  Gauge,
  Loader2,
  PackageCheck,
  Puzzle,
  Radar,
  RefreshCw,
  Server,
  Store,
} from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type {
  DesktopSnapshot,
  ServiceDescriptor,
  ServiceHealth,
  ServiceStatus,
} from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type MaiBotUpdateChannel = "stable" | "test" | "legacy";
type DashboardUpdateChannel = "stable" | "test";

const statusText: Record<ServiceStatus, string> = {
  stopped: "未启动",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  error: "异常",
};

const healthText: Record<ServiceHealth, string> = {
  unknown: "未检测",
  checking: "检测中",
  ready: "可访问",
  unreachable: "不可访问",
  conflict: "端口冲突",
};

const statusVariant: Record<ServiceStatus, React.ComponentProps<typeof Badge>["variant"]> = {
  stopped: "outline",
  starting: "warning",
  running: "success",
  stopping: "warning",
  error: "danger",
};

function valueOrFallback(value: string | undefined): string {
  return value && value.trim().length > 0 ? value : "未读取";
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DetailRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string | undefined;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono font-semibold" title={value}>
        {valueOrFallback(value)}
      </span>
    </div>
  );
}

function ChoiceSwitch<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; version: string | undefined }>;
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "grid gap-2 rounded-lg border border-border bg-muted/30 p-1",
        options.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3",
      )}
    >
      {options.map((option) => {
        const selected = value === option.value;
        const disabled = !option.version;
        return (
          <button
            className={cn(
              "grid min-h-14 min-w-0 gap-1 rounded-md px-3 py-2 text-left text-xs transition-colors",
              selected ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground hover:bg-muted",
              disabled && "cursor-not-allowed opacity-45 hover:bg-transparent",
            )}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            <span className="font-medium">{option.label}</span>
            <span className={cn("truncate font-mono text-[11px]", selected ? "text-primary-foreground/80" : "text-muted-foreground")}>
              {valueOrFallback(option.version)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ServiceSummary({
  icon,
  service,
}: {
  icon: React.ReactNode;
  service: ServiceDescriptor | undefined;
}): React.JSX.Element {
  return (
    <div className="grid min-h-36 gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            {icon}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{service?.name ?? "未知服务"}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {service?.url ?? "未配置地址"}
            </p>
          </div>
        </div>
        {service ? (
          <Badge dot variant={statusVariant[service.status]}>
            {statusText[service.status]}
          </Badge>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
          <p className="text-muted-foreground">端口</p>
          <p className="mt-1 font-mono text-sm">{service?.port ?? "-"}</p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
          <p className="text-muted-foreground">健康</p>
          <p className="mt-1 text-sm">{service ? healthText[service.health] : "未知"}</p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
          <p className="text-muted-foreground">PID</p>
          <p className="mt-1 font-mono text-sm">{service?.pid ?? "-"}</p>
        </div>
      </div>
    </div>
  );
}

function VersionTile({
  icon,
  label,
  value,
  latest,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | undefined;
  latest: Array<{ label: string; value: string | undefined }>;
  action: {
    label: string;
    icon: React.ReactNode;
    busy?: boolean;
    onClick: () => void;
  };
}): React.JSX.Element {
  return (
    <div className="flex min-h-24 min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">
        {icon}
      </span>
      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 truncate font-mono text-base font-semibold" title={value}>
            {valueOrFallback(value)}
          </p>
        </div>
        <div className="grid min-w-0 gap-1 sm:min-w-44">
          {latest.map((item) => (
            <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]" key={item.label}>
              <span className="shrink-0 text-muted-foreground">{item.label}</span>
              <span className="min-w-0 truncate font-mono text-xs font-medium text-muted-foreground/80" title={item.value}>
                {valueOrFallback(item.value)}
              </span>
            </div>
          ))}
          <Button
            className="mt-1 h-7 justify-self-end px-2.5 text-[11px]"
            disabled={action.busy}
            onClick={action.onClick}
            size="sm"
            variant="secondary"
          >
            {action.busy ? <Loader2 className="animate-spin" /> : action.icon}
            {action.label}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShortcutTile({
  icon,
  title,
  description,
  actionLabel,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className="group flex min-h-28 min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/35"
      onClick={onClick}
      type="button"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 rounded-md bg-secondary px-2.5 py-1.5 text-[11px] font-medium text-secondary-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        {actionLabel}
        <ArrowRight className="size-3.5" />
      </span>
    </button>
  );
}

export function HomePanel({
  active,
  snapshot,
  onSnapshot,
  onOpenTab,
}: {
  active: boolean;
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
  onOpenTab: (tab: string) => void;
}): React.JSX.Element {
  const [updateDialog, setUpdateDialog] = useState<"maibot" | "dashboard" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maibotChannel, setMaibotChannel] = useState<MaiBotUpdateChannel>("stable");
  const [dashboardChannel, setDashboardChannel] = useState<DashboardUpdateChannel>("stable");
  const services = snapshot.services ?? [];
  const maibot = services.find((service) => service.id === "maibot");
  const napcat = services.find((service) => service.id === "napcat");
  const runningCount = services.filter((service) => service.status === "running").length;
  const readyCount = services.filter((service) => service.health === "ready").length;
  const maibotUpdateBlocked =
    maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping";

  const maibotTargets: Record<MaiBotUpdateChannel, string | undefined> = {
    stable: snapshot.moduleVersions.maibotLatestStableTag,
    test: snapshot.moduleVersions.maibotLatestPrereleaseTag,
    legacy: snapshot.moduleVersions.maibotLatestLegacyTag,
  };
  const dashboardTargets: Record<DashboardUpdateChannel, string | undefined> = {
    stable: snapshot.moduleVersions.dashboardLatestStablePypi ?? snapshot.moduleVersions.dashboardLatestPypi,
    test: snapshot.moduleVersions.dashboardLatestPrereleasePypi,
  };

  const refreshSnapshot = useCallback(async () => {
    if (!window.maibotDesktop) {
      return;
    }
    onSnapshot(await window.maibotDesktop.getSnapshot());
  }, [onSnapshot]);

  const openMaiBotUpdate = useCallback(() => {
    setError(null);
    setMaibotChannel(
      snapshot.moduleVersions.maibotLatestStableTag
        ? "stable"
        : snapshot.moduleVersions.maibotLatestPrereleaseTag
          ? "test"
          : "legacy",
    );
    setUpdateDialog("maibot");
  }, [snapshot.moduleVersions.maibotLatestPrereleaseTag, snapshot.moduleVersions.maibotLatestStableTag]);

  const openDashboardUpdate = useCallback(() => {
    setError(null);
    setDashboardChannel((snapshot.moduleVersions.dashboardLatestStablePypi ?? snapshot.moduleVersions.dashboardLatestPypi) ? "stable" : "test");
    setUpdateDialog("dashboard");
  }, [snapshot.moduleVersions.dashboardLatestPypi, snapshot.moduleVersions.dashboardLatestStablePypi]);

  const openPluginStore = useCallback(() => {
    onOpenTab("pluginmarket");
  }, [onOpenTab]);

  const openPluginManager = useCallback(() => {
    onOpenTab("pluginmanage");
  }, [onOpenTab]);

  const updateMaiBot = useCallback(async () => {
    const target = maibotTargets[maibotChannel];
    if (!window.maibotDesktop?.modules || !target) {
      setError("没有可用的目标版本");
      return;
    }

    setBusy("maibot:update");
    setError(null);
    try {
      await window.maibotDesktop.modules.updateMaiBot(target);
      toast.success("MaiBot 更新完成");
      setUpdateDialog(null);
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [maibotChannel, maibotTargets, refreshSnapshot]);

  const updateDashboard = useCallback(async () => {
    const target = dashboardTargets[dashboardChannel];
    if (!window.maibotDesktop?.pythonDeps || !target) {
      setError("没有可用的目标版本");
      return;
    }

    setBusy("dashboard:update");
    setError(null);
    try {
      await window.maibotDesktop.pythonDeps.installVersion({
        packageName: "maibot-dashboard",
        version: target,
      });
      toast.success("WebUI 更新完成");
      await refreshSnapshot();
      setUpdateDialog(null);
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [dashboardChannel, dashboardTargets, refreshSnapshot]);

  return (
    <>
      <div className={cn("h-full overflow-auto bg-background px-5 py-4", active ? "block" : "hidden")}>
        <div className="mx-auto grid max-w-6xl gap-4">
          <div className="min-w-0">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">首页</h2>
              <p className="text-sm text-muted-foreground">MaiBot OneKey 当前运行概览</p>
            </div>
          </div>

          <div className="grid gap-2 rounded-lg border border-border bg-card px-3 py-2.5 md:grid-cols-3">
            <div className="flex min-w-0 items-center gap-2">
              <Activity className="size-4 shrink-0 text-primary" />
              <span className="shrink-0 text-xs text-muted-foreground">服务运行</span>
              <span className="ml-auto font-mono text-sm font-semibold tabular-nums">
                {runningCount}/{services.length}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2 md:border-l md:border-border md:pl-3">
              <Gauge className="size-4 shrink-0 text-primary" />
              <span className="shrink-0 text-xs text-muted-foreground">端口可用</span>
              <span className="ml-auto font-mono text-sm font-semibold tabular-nums">
                {readyCount}/{services.length}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2 md:border-l md:border-border md:pl-3">
              <PackageCheck className="size-4 shrink-0 text-primary" />
              <span className="shrink-0 text-xs text-muted-foreground">一键包版本</span>
              <span className="ml-auto truncate font-mono text-sm font-semibold" title={snapshot.appVersion}>
                v{snapshot.appVersion}
              </span>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <ServiceSummary icon={<Radar className="size-5" />} service={maibot} />
            <ServiceSummary icon={<Server className="size-5" />} service={napcat} />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <VersionTile
              icon={<Server className="size-5" />}
              label="MaiBot 本地版本"
              value={snapshot.moduleVersions.maibotLocal}
              latest={[
                { label: "最新正式版", value: snapshot.moduleVersions.maibotLatestStableTag },
                { label: "最新测试版", value: snapshot.moduleVersions.maibotLatestPrereleaseTag },
              ]}
              action={{
                label: "更新",
                icon: <RefreshCw />,
                busy: busy === "maibot:update",
                onClick: openMaiBotUpdate,
              }}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <ShortcutTile
              icon={<Store className="size-5" />}
              title="插件商店"
              description="浏览 MaiBot 插件市场，安装兼容当前版本的插件。"
              actionLabel="打开"
              onClick={openPluginStore}
            />
            <ShortcutTile
              icon={<Puzzle className="size-5" />}
              title="插件管理"
              description="查看已安装插件，执行更新、卸载与运行配置。"
              actionLabel="管理"
              onClick={openPluginManager}
            />
          </div>
        </div>
      </div>

      <Dialog
        open={updateDialog === "maibot"}
        onOpenChange={(next) => {
          if (!next && busy !== "maibot:update") setUpdateDialog(null);
        }}
      >
        <DialogContent size="lg">
          <DialogHeader
            description="选择要同步的 MaiBot 版本。更新前需要停止 MaiBot Core，用户数据目录会保留。"
            icon={<Server className="size-4" />}
            title="更新 MaiBot"
            tone="primary"
          />
          <DialogBody className="space-y-4">
            {error && updateDialog === "maibot" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <DetailRow label="本地版本" value={snapshot.moduleVersions.maibotLocal} />
              <div className="my-1 border-t border-border/70" />
              <DetailRow label="最新正式版" value={snapshot.moduleVersions.maibotLatestStableTag} />
              <DetailRow label="最新测试版" value={snapshot.moduleVersions.maibotLatestPrereleaseTag} />
              <DetailRow label="最新旧版" value={snapshot.moduleVersions.maibotLatestLegacyTag} />
            </div>
            {maibotUpdateBlocked ? (
              <div className="rounded-lg border border-warning/40 bg-warning/15 px-3 py-2 text-xs">
                请先停止 MaiBot Core，再执行更新。
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <p className="text-xs font-medium">目标版本</p>
              <ChoiceSwitch
                value={maibotChannel}
                onChange={setMaibotChannel}
                options={[
                  { value: "stable", label: "最新正式版", version: maibotTargets.stable },
                  { value: "test", label: "最新测试版", version: maibotTargets.test },
                  { value: "legacy", label: "最新旧版", version: maibotTargets.legacy },
                ]}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy === "maibot:update"} onClick={() => setUpdateDialog(null)} size="sm" variant="ghost">
              取消
            </Button>
            <Button disabled={busy !== null || maibotUpdateBlocked || !maibotTargets[maibotChannel]} onClick={() => void updateMaiBot()} size="sm">
              {busy === "maibot:update" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              开始更新
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={updateDialog === "dashboard"}
        onOpenChange={(next) => {
          if (!next && busy !== "dashboard:update") setUpdateDialog(null);
        }}
      >
        <DialogContent size="lg">
          <DialogHeader
            description="选择 WebUI 版本并安装到 Python 覆盖层；MaiBot Core 启动时会优先加载这里的版本。"
            icon={<PackageCheck className="size-4" />}
            title="更新 WebUI"
            tone="primary"
          />
          <DialogBody className="space-y-4">
            {error && updateDialog === "dashboard" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <DetailRow label="已安装版本" value={snapshot.moduleVersions.dashboardOverride} />
              <div className="my-1 border-t border-border/70" />
              <DetailRow label="最新正式版" value={dashboardTargets.stable} />
              <DetailRow label="最新测试版" value={dashboardTargets.test} />
            </div>
            {maibotUpdateBlocked ? (
              <div className="rounded-lg border border-warning/40 bg-warning/15 px-3 py-2 text-xs">
                请先停止 MaiBot Core，再更新 WebUI 覆盖依赖。
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <p className="text-xs font-medium">目标版本</p>
              <ChoiceSwitch
                value={dashboardChannel}
                onChange={setDashboardChannel}
                options={[
                  { value: "stable", label: "最新正式版", version: dashboardTargets.stable },
                  { value: "test", label: "最新测试版", version: dashboardTargets.test },
                ]}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy === "dashboard:update"} onClick={() => setUpdateDialog(null)} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              disabled={busy !== null || maibotUpdateBlocked || !dashboardTargets[dashboardChannel]}
              onClick={() => void updateDashboard()}
              size="sm"
            >
              {busy === "dashboard:update" ? <Loader2 className="animate-spin" /> : <Download />}
              安装选中版本
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
