import {
  Activity,
  ArrowRight,
  Download,
  ExternalLink,
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
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import maiMascotImage from "@/assets/mai2.png";
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
import { WebviewPanel } from "./WebviewPanel";

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
  action,
}: {
  icon: React.ReactNode;
  service: ServiceDescriptor | undefined;
  action?: {
    label: string;
    onClick: () => void;
  };
}): React.JSX.Element {
  return (
    <div className="grid min-h-32 gap-3 rounded-lg border border-border bg-card p-3.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
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
      <div className="grid grid-cols-3 gap-1.5 text-[11px]">
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">端口</p>
          <p className="mt-0.5 font-mono text-xs">{service?.port ?? "-"}</p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">健康</p>
          <p className="mt-0.5 text-xs">{service ? healthText[service.health] : "未知"}</p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">PID</p>
          <p className="mt-0.5 font-mono text-xs">{service?.pid ?? "-"}</p>
        </div>
      </div>
      {action ? (
        <Button className="h-7 justify-self-end px-2.5 text-[11px]" onClick={action.onClick} size="sm" variant="secondary">
          <ExternalLink />
          {action.label}
        </Button>
      ) : null}
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

function ElasticMascot(): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const bodyRef = useRef({
    x: 0,
    y: 0,
    rotate: 0,
    stretch: 0,
    squash: 0,
    vx: 0,
    vy: 0,
    vr: 0,
    vs: 0,
    vq: 0,
  });
  const pointerRef = useRef({ x: 0, y: 0, t: 0 });
  const [pose, setPose] = useState({
    x: 0,
    y: 0,
    rotate: 0,
    stretch: 0,
    squash: 0,
  });

  const kick = useCallback((x: number, y: number, force = 1) => {
    const body = bodyRef.current;
    body.vx += x * force;
    body.vy += y * force;
    body.vr += x * 0.18 * force;
    body.vs += Math.abs(x) * 0.015 * force + Math.abs(y) * 0.01 * force;
    body.vq += y * 0.018 * force;
  }, []);

  useEffect(() => {
    const tick = () => {
      const body = bodyRef.current;
      body.vx += -body.x * 0.09;
      body.vy += -body.y * 0.09;
      body.vr += -body.rotate * 0.08;
      body.vs += -body.stretch * 0.1;
      body.vq += -body.squash * 0.1;

      body.vx *= 0.82;
      body.vy *= 0.82;
      body.vr *= 0.8;
      body.vs *= 0.78;
      body.vq *= 0.78;

      body.x += body.vx;
      body.y += body.vy;
      body.rotate += body.vr;
      body.stretch += body.vs;
      body.squash += body.vq;

      setPose({
        x: body.x,
        y: body.y,
        rotate: body.rotate,
        stretch: body.stretch,
        squash: body.squash,
      });
      frameRef.current = window.requestAnimationFrame(tick);
    };

    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const rect = stage.getBoundingClientRect();
    const now = performance.now();
    const previous = pointerRef.current;
    const hasPrevious = previous.t > 0;
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const dx = hasPrevious ? localX - previous.x : 0;
    const dy = hasPrevious ? localY - previous.y : 0;
    const headBias = 1 - Math.min(1, localY / Math.max(1, rect.height));
    const speed = Math.min(18, Math.hypot(dx, dy));

    pointerRef.current = { x: localX, y: localY, t: now };
    kick(dx * 0.18 * headBias, dy * 0.16 * headBias - speed * 0.03, 1);
  }, [kick]);

  const onPointerEnter = useCallback(() => {
    kick(-5, -4, 1.2);
  }, [kick]);

  const onPointerLeave = useCallback(() => {
    pointerRef.current.t = 0;
    kick(4, 2, 0.8);
  }, [kick]);

  const stretch = Math.max(-0.1, Math.min(0.16, pose.stretch));
  const squash = Math.max(-0.12, Math.min(0.12, pose.squash));
  const rotate = Math.max(-9, Math.min(9, pose.rotate));
  const x = Math.max(-22, Math.min(22, pose.x));
  const y = Math.max(-18, Math.min(18, pose.y));

  return (
    <div
      aria-hidden="true"
      className="relative hidden min-h-32 overflow-hidden rounded-lg border border-transparent md:block"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      ref={stageRef}
    >
      <img
        alt=""
        className="pointer-events-none absolute bottom-[-58px] right-[-82px] w-[min(150px,54vw)] select-none"
        draggable={false}
        src={maiMascotImage}
        style={{
          transform: `translate3d(${x}px, ${y}px, 0) rotate(${rotate}deg) skew(${squash * 12}deg, ${-squash * 7}deg) scale(${1 + stretch}, ${1 - stretch * 0.55})`,
          transformOrigin: "82% 86%",
          transition: "filter 160ms ease",
        }}
      />
    </div>
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
  const [napcatWebuiOpen, setNapcatWebuiOpen] = useState(false);
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
            <ServiceSummary icon={<Radar className="size-4.5" />} service={maibot} />
            <ServiceSummary
              action={{
                label: "打开 WebUI",
                onClick: () => setNapcatWebuiOpen(true),
              }}
              icon={<Server className="size-4.5" />}
              service={napcat}
            />
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
            <ElasticMascot />
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

      <Dialog open={napcatWebuiOpen} onOpenChange={setNapcatWebuiOpen}>
        <DialogContent className="h-[calc(100vh-4rem)] sm:max-w-[1180px]" size="xl">
          <DialogHeader
            description="从首页打开，关闭后不会影响 NapCat 服务运行。"
            icon={<Server className="size-4" />}
            title="NapCat WebUI"
            tone="primary"
          />
          <DialogBody className="overflow-hidden p-0">
            <WebviewPanel
              active={napcatWebuiOpen}
              emptyText="NapCat 启动后会在这里打开它自己的 WebUI。"
              title="NapCat WebUI"
              url={napcat?.url ?? "http://127.0.0.1:6099/webui"}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
