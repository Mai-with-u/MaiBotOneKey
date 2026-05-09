import { Activity, Bot, Gauge, PackageCheck, Radar, Server } from "lucide-react";
import type React from "react";
import type { DesktopSnapshot, ServiceDescriptor, ServiceHealth, ServiceStatus } from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
}: {
  icon: React.ReactNode;
  label: string;
  value: string | undefined;
  latest: Array<{ label: string; value: string | undefined }>;
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
        </div>
      </div>
    </div>
  );
}

export function HomePanel({
  active,
  snapshot,
  onOpenTab,
}: {
  active: boolean;
  snapshot: DesktopSnapshot;
  onOpenTab: (tab: string) => void;
}): React.JSX.Element {
  const services = snapshot.services ?? [];
  const maibot = services.find((service) => service.id === "maibot");
  const napcat = services.find((service) => service.id === "napcat");
  const runningCount = services.filter((service) => service.status === "running").length;
  const readyCount = services.filter((service) => service.health === "ready").length;

  return (
    <div className={cn("h-full overflow-auto bg-background px-5 py-4", active ? "block" : "hidden")}>
      <div className="mx-auto grid max-w-6xl gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">首页</h2>
            <p className="text-sm text-muted-foreground">MaiBot OneKey 当前运行概览</p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => onOpenTab("maibot")} size="sm" variant="secondary">
              <Radar />
              MaiBot
            </Button>
            <Button onClick={() => onOpenTab("napcat")} size="sm" variant="secondary">
              <Bot />
              NapCat
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Activity className="size-4 text-primary" />
              服务运行
            </div>
            <p className="mt-3 text-2xl font-semibold tabular-nums">
              {runningCount}/{services.length}
            </p>
            <p className="text-xs text-muted-foreground">托管服务正在运行</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Gauge className="size-4 text-primary" />
              端口可用
            </div>
            <p className="mt-3 text-2xl font-semibold tabular-nums">
              {readyCount}/{services.length}
            </p>
            <p className="text-xs text-muted-foreground">健康检查已通过</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <PackageCheck className="size-4 text-primary" />
              一键包版本
            </div>
            <p className="mt-3 font-mono text-2xl font-semibold">v{snapshot.appVersion}</p>
            <p className="text-xs text-muted-foreground">MaiBot OneKey</p>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <ServiceSummary icon={<Radar className="size-5" />} service={maibot} />
          <ServiceSummary icon={<Bot className="size-5" />} service={napcat} />
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
          />
          <VersionTile
            icon={<PackageCheck className="size-5" />}
            label="WebUI 已安装版本"
            value={snapshot.moduleVersions.dashboardOverride}
            latest={[{ label: "最新版", value: snapshot.moduleVersions.dashboardLatestPypi }]}
          />
        </div>
      </div>
    </div>
  );
}
