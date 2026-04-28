import {
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  FolderOpen,
  HardDrive,
  Loader2,
  Network,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DesktopSnapshot,
  InitCheckStatus,
  LogEntry,
  ServiceCommandConfig,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceHealth,
  ServiceStatus,
} from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/use-shortcut";

interface SettingsStatusPanelProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
}

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

const healthText: Record<ServiceHealth, string> = {
  unknown: "未检测",
  checking: "检测中",
  ready: "端口就绪",
  unreachable: "不可达",
  conflict: "端口冲突",
};

const initVariant: Record<InitCheckStatus, ComponentProps<typeof Badge>["variant"]> = {
  ok: "success",
  warning: "warning",
  error: "danger",
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(timestamp?: number): string {
  if (!timestamp) {
    return "未记录";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function PathField({
  label,
  value,
  onOpen,
}: {
  label: string;
  value: string;
  onOpen?: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 items-start gap-2">
        <code
          className="block min-w-0 flex-1 break-all rounded-md border border-border/70 bg-muted/70 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/85"
          title={value}
        >
          {value}
        </code>
        {onOpen ? (
          <Button
            aria-label={`打开 ${label}`}
            className="shrink-0"
            onClick={() => onOpen(value)}
            size="icon"
            variant="ghost"
          >
            <FolderOpen />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ServiceDetail({
  service,
  commandConfig,
  commandBusy,
  onOpenPath,
  onResetCommand,
  onSaveCommand,
}: {
  service: ServiceDescriptor;
  commandConfig?: ServiceCommandConfig;
  commandBusy: boolean;
  onOpenPath: (path: string) => void;
  onResetCommand: (serviceId: ServiceDescriptor["id"]) => void;
  onSaveCommand: (config: ServiceCommandUpdate) => void;
}): React.JSX.Element {
  const [cwd, setCwd] = useState(commandConfig?.cwd ?? service.cwd ?? "");
  const [commandLine, setCommandLine] = useState(commandConfig?.commandLine ?? service.command?.[0] ?? "");

  useEffect(() => {
    setCwd(commandConfig?.cwd ?? service.cwd ?? "");
    setCommandLine(commandConfig?.commandLine ?? service.command?.[0] ?? "");
  }, [commandConfig?.commandLine, commandConfig?.cwd, service.command, service.cwd]);

  const configDirty = Boolean(
    commandConfig && (cwd.trim() !== commandConfig.cwd || commandLine.trim() !== commandConfig.commandLine),
  );

  return (
    <div className="rounded-lg border border-border/70 bg-elevated/80 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium leading-tight">{service.name}</span>
            <Badge dot variant={statusVariant[service.status]}>
              {statusText[service.status]}
            </Badge>
            <Badge variant={service.health === "ready" ? "success" : service.health === "conflict" ? "danger" : "secondary"}>
              {healthText[service.health]}
            </Badge>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={service.url}>
            {service.url}
          </p>
        </div>
        <Badge variant={service.managed ? "success" : "outline"}>
          {service.managed ? `PID ${service.pid ?? "-"}` : "未托管"}
        </Badge>
        {service.desired ? <Badge variant="warning">守护中</Badge> : null}
      </div>
      <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground md:grid-cols-2">
        <span>端口: {service.ports.map((port) => `:${port}`).join(" / ")}</span>
        <span>启动: {formatTime(service.startedAt)}</span>
        <span className="truncate" title={service.cwd}>
          cwd: {service.cwd ?? "-"}
        </span>
        <span>停止: {formatTime(service.stoppedAt)}</span>
        <span>重启次数: {service.restartAttempts ?? 0}</span>
      </div>
      {service.command ? (
        <code className="mt-3 block overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-muted/65 px-2 py-1.5 font-mono text-[11px] text-foreground/75">
          {service.command.join(" ")}
        </code>
      ) : null}
      {commandConfig ? (
        <div className="mt-3 grid gap-2 rounded-md border border-border/70 bg-muted/35 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">启动命令</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {commandConfig.customized ? "正在使用自定义命令，下次启动生效" : "当前使用默认命令"}
              </p>
            </div>
            <Badge variant={commandConfig.customized ? "warning" : "secondary"}>
              {commandConfig.customized ? "自定义" : "默认"}
            </Badge>
          </div>
          <Input
            aria-label={`${service.name} 工作目录`}
            monospace
            onChange={(event) => setCwd(event.target.value)}
            placeholder={commandConfig.defaultCwd}
            value={cwd}
          />
          <Input
            aria-label={`${service.name} 启动命令`}
            monospace
            onChange={(event) => setCommandLine(event.target.value)}
            placeholder={commandConfig.defaultCommandLine}
            value={commandLine}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground" title={commandConfig.defaultCommandLine}>
              默认: {commandConfig.defaultCommandLine}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                disabled={commandBusy || (!commandConfig.customized && !configDirty)}
                onClick={() => onResetCommand(service.id)}
                size="sm"
                variant="ghost"
              >
                {commandBusy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                恢复默认
              </Button>
              <Button
                disabled={commandBusy || !configDirty || commandLine.trim().length === 0 || cwd.trim().length === 0}
                onClick={() =>
                  onSaveCommand({
                    serviceId: service.id,
                    cwd: cwd.trim(),
                    commandLine: commandLine.trim(),
                  })
                }
                size="sm"
              >
                {commandBusy ? <Loader2 className="animate-spin" /> : <Save />}
                保存命令
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {service.logPath ? (
          <Button onClick={() => onOpenPath(service.logPath ?? "")} size="sm" variant="outline">
            <FolderOpen />
            打开日志
          </Button>
        ) : null}
        {service.error ? (
          <span className="min-w-0 truncate text-[11px] text-destructive" title={service.error}>
            {service.error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[74px_66px_minmax(0,1fr)] gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] last:border-b-0">
      <span className="text-muted-foreground">{formatTime(entry.timestamp)}</span>
      <span
        className={
          entry.stream === "stderr"
            ? "text-destructive"
            : entry.stream === "system"
              ? "text-primary"
              : "text-foreground/80"
        }
      >
        {entry.source}/{entry.stream}
      </span>
      <span className="min-w-0 truncate text-foreground/80" title={entry.message}>
        {entry.message}
      </span>
    </div>
  );
}

export function SettingsStatusPanel({
  snapshot,
  onSnapshot,
}: SettingsStatusPanelProps): React.JSX.Element {
  const [qqAccount, setQqAccount] = useState(snapshot.initState.qqAccount ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQqAccount(snapshot.initState.qqAccount ?? "");
  }, [snapshot.initState.qqAccount]);

  const attentionChecks = useMemo(
    () => snapshot.initState.checks.filter((check) => check.status !== "ok"),
    [snapshot.initState.checks],
  );
  const recentLogs = useMemo(() => snapshot.recentLogs.slice(-80).reverse(), [snapshot.recentLogs]);

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await window.maibotDesktop?.getSnapshot();
    if (nextSnapshot) {
      onSnapshot(nextSnapshot);
    }
  }, [onSnapshot]);

  const openPath = useCallback((path: string) => {
    void window.maibotDesktop?.openPath(path);
  }, []);

  const repair = useCallback(async () => {
    setBusy("repair");
    setError(null);
    try {
      await window.maibotDesktop?.init.repair();
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const saveQqAccount = useCallback(async () => {
    const trimmed = qqAccount.trim();
    if (trimmed.length === 0) {
      return;
    }
    setBusy("qq");
    setError(null);
    try {
      await window.maibotDesktop?.init.setQqAccount(trimmed);
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [qqAccount, refreshSnapshot]);

  const clearLogs = useCallback(async () => {
    setBusy("logs");
    setError(null);
    try {
      await window.maibotDesktop?.logs.clear();
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const saveCommandConfig = useCallback(
    async (config: ServiceCommandUpdate) => {
      setBusy(`command:${config.serviceId}`);
      setError(null);
      try {
        const serviceCommands = await window.maibotDesktop?.services.saveCommandConfig(config);
        if (serviceCommands) {
          onSnapshot({ ...snapshot, serviceCommands });
        }
        await refreshSnapshot();
      } catch (nextError) {
        setError(messageFromError(nextError));
      } finally {
        setBusy(null);
      }
    },
    [onSnapshot, refreshSnapshot, snapshot],
  );

  const resetCommandConfig = useCallback(
    async (serviceId: ServiceDescriptor["id"]) => {
      setBusy(`command:${serviceId}`);
      setError(null);
      try {
        const serviceCommands = await window.maibotDesktop?.services.resetCommandConfig(serviceId);
        if (serviceCommands) {
          onSnapshot({ ...snapshot, serviceCommands });
        }
        await refreshSnapshot();
      } catch (nextError) {
        setError(messageFromError(nextError));
      } finally {
        setBusy(null);
      }
    },
    [onSnapshot, refreshSnapshot, snapshot],
  );

  const canSaveQq = busy === null && qqAccount.trim().length > 0;
  useShortcut("Mod+Enter", saveQqAccount, { enabled: canSaveQq, allowInEditable: true });
  useShortcut("Mod+Shift+R", repair, { enabled: busy === null });

  return (
    <section className="h-full overflow-auto bg-surface/60 px-6 py-6">
      <div className="mx-auto grid w-full max-w-[1240px] gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-md bg-primary/10 text-primary">
                  <ClipboardCheck className="size-3.5" />
                </span>
                初始化检查
              </CardTitle>
              <CardDescription>
                基础向导会检查运行目录、入口文件、配置、QQ 号和依赖完整性；依赖损坏只报错，不自动修复。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge dot variant={snapshot.initState.isReady ? "success" : "danger"}>
                  {snapshot.initState.isReady ? "环境可启动" : "环境不完整"}
                </Badge>
                <Badge variant={attentionChecks.length > 0 ? "warning" : "secondary"}>
                  {attentionChecks.length} 项待处理
                </Badge>
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                {snapshot.initState.checks.map((check) => (
                  <div
                    className="flex min-w-0 items-start gap-2 rounded-lg border border-border/70 bg-elevated/75 px-3 py-2.5"
                    key={check.id}
                  >
                    {check.status === "ok" ? (
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                    ) : (
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{check.label}</span>
                        <Badge variant={initVariant[check.status]}>
                          {check.status === "ok" ? "正常" : check.status === "warning" ? "确认" : "错误"}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground" title={check.path}>
                        {check.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 rounded-lg border border-border/70 bg-muted/35 p-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                <Input
                  inputMode="numeric"
                  monospace
                  onChange={(event) => setQqAccount(event.target.value)}
                  placeholder="机器人 QQ 号"
                  value={qqAccount}
                />
                <Button disabled={!canSaveQq} onClick={saveQqAccount}>
                  {busy === "qq" ? <Loader2 className="animate-spin" /> : <Save />}
                  保存 QQ
                  <Kbd className="ml-1" keys="Mod+Enter" size="xs" tone="inverse" />
                </Button>
                <Button disabled={busy !== null} onClick={repair} variant="outline">
                  {busy === "repair" ? <Loader2 className="animate-spin" /> : <Wrench />}
                  修复配置
                  <Kbd className="ml-1" keys="Mod+Shift+R" size="xs" tone="muted" />
                </Button>
              </div>

              {error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs leading-relaxed text-destructive">
                  {error}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-md bg-accent/60 text-accent-foreground">
                  <Network className="size-3.5" />
                </span>
                服务状态
              </CardTitle>
              <CardDescription>固定端口模式；端口冲突时报错。托管进程异常退出会有限次自动重启。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {snapshot.services.map((service) => (
                <ServiceDetail
                  commandBusy={busy === `command:${service.id}`}
                  commandConfig={snapshot.serviceCommands.find((config) => config.serviceId === service.id)}
                  key={service.id}
                  onOpenPath={openPath}
                  onResetCommand={resetCommandConfig}
                  onSaveCommand={saveCommandConfig}
                  service={service}
                />
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-md bg-primary/10 text-primary">
                  <ShieldCheck className="size-3.5" />
                </span>
                实例与路径
              </CardTitle>
              <CardDescription>每个安装目录使用独立 userData 与安装目录级实例锁。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <PathField label="安装目录" onOpen={openPath} value={snapshot.paths.installRoot} />
              <PathField label="用户数据目录" onOpen={openPath} value={snapshot.paths.userDataRoot} />
              <PathField label="runtime" onOpen={openPath} value={snapshot.paths.runtimeRoot} />
              <PathField label="modules" onOpen={openPath} value={snapshot.paths.modulesRoot} />
              <Button
                className="mt-1 w-full justify-center"
                onClick={() => window.maibotDesktop?.openLogsDirectory()}
                variant="outline"
              >
                <FolderOpen />
                打开日志目录
                <Kbd className="ml-1" keys="Mod+L" size="xs" tone="muted" />
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-md bg-amber-500/15 text-amber-700">
                  <HardDrive className="size-3.5" />
                </span>
                最近日志
              </CardTitle>
              <CardDescription>服务 stdout、stderr 和桌面壳系统事件会写入日志目录。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="max-h-[360px] overflow-y-auto rounded-lg border border-border/70 bg-elevated/80">
                {recentLogs.length > 0 ? (
                  recentLogs.map((entry) => <LogLine entry={entry} key={entry.id} />)
                ) : (
                  <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                    暂无日志
                  </div>
                )}
              </div>
              <Button disabled={busy !== null} onClick={clearLogs} size="sm" variant="outline">
                {busy === "logs" ? <Loader2 className="animate-spin" /> : <Trash2 />}
                清空面板日志
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
