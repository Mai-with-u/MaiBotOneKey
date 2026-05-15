import {
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Download,
  FolderOpen,
  GitBranch,
  HardDrive,
  Loader2,
  Network,
  Package,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  DesktopSnapshot,
  InitCheckStatus,
  LogEntry,
  ManagedPythonPackageName,
  ModuleSourceConfig,
  ModuleSourcePreset,
  ModuleTagOption,
  ModuleUpdateResult,
  PythonOverridesState,
  PythonPackageInstallResult,
  PythonPackageVersionList,
  PythonRuntimeCandidate,
  RuntimePathConfig,
  RuntimePathKey,
  RuntimePathUpdate,
  RuntimeResourcePathConfig,
  RuntimeResourcePathKey,
  ServiceCommandConfig,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceHealth,
  ServiceStatus,
  TerminalSettings,
} from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createSecureToken } from "@/lib/secure-token";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

const managedPythonPackages: Array<{ name: ManagedPythonPackageName; label: string }> = [
  { name: "maibot-dashboard", label: "MaiBot Dashboard" },
  { name: "maim-message", label: "Maim Message" },
];

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

function formatDateTime(timestamp?: number): string {
  if (!timestamp) {
    return "未记录";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function ModuleUpdateOutput({ result }: { result: ModuleUpdateResult }): React.JSX.Element {
  const output = result.output.slice(-120).join("\n");
  const hasWarning = Boolean(result.warning || result.remoteError);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.changed ? "success" : "secondary"}>
          {result.changed ? "已更新" : "已是最新"}
        </Badge>
        <Badge variant={result.source === "bundled" ? "secondary" : "outline"}>
          {result.source === "bundled" ? "内置修复" : "来自 Git 远端"}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          {result.before ?? "-"} -&gt; {result.after ?? "-"}
        </span>
        <span className="text-[11px] text-muted-foreground">{formatDateTime(result.updatedAt)}</span>
      </div>
      {hasWarning ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-[12px] leading-relaxed text-destructive">
          <p className="font-semibold">更新未完成，已恢复到更新前状态</p>
          {result.warning ? <p className="mt-1 text-destructive/90">{result.warning}</p> : null}
          {result.remoteError ? (
            <p className="mt-1 break-all font-mono text-[11px] text-destructive/80">
              原始错误：{result.remoteError}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-2 text-[11px] text-muted-foreground md:grid-cols-2">
        <span className="truncate" title={result.branch ?? ""}>
          分支: {result.branch ?? "-"}
        </span>
        <span className="truncate" title={result.upstream ?? ""}>
          远端: {result.upstream ?? "-"}
        </span>
        <span className="truncate md:col-span-2" title={result.cwd}>
          目录: {result.cwd}
        </span>
      </div>
      {output.length > 0 ? (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
          {output}
        </pre>
      ) : null}
      {result.plugins && result.plugins.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold text-muted-foreground">同步的子插件</div>
          {result.plugins.map((plugin) => (
            <div
              key={plugin.moduleId}
              className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{plugin.moduleName}</span>
                <Badge variant={plugin.changed ? "success" : "secondary"}>
                  {plugin.changed ? "已更新" : "已是最新"}
                </Badge>
                <Badge variant={plugin.source === "bundled" ? "danger" : "outline"}>
                  {plugin.source === "bundled" ? "内置修复" : "来自 Git 远端"}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {plugin.before ?? "-"} -&gt; {plugin.after ?? "-"}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                <span className="truncate" title={plugin.cwd}>
                  目录: {plugin.cwd}
                </span>
              </div>
              {plugin.warning ? (
                <p className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                  {plugin.warning}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PythonInstallOutput({ result }: { result: PythonPackageInstallResult }): React.JSX.Element {
  const output = result.output.slice(-80).join("\n");

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">已安装</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          {result.packageName}=={result.version}
        </span>
        <span className="text-[11px] text-muted-foreground">{formatDateTime(result.installedAt)}</span>
      </div>
      <p className="truncate font-mono text-[11px] text-muted-foreground" title={result.targetDir}>
        覆盖目录: {result.targetDir}
      </p>
      {output.length > 0 ? (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
          {output}
        </pre>
      ) : null}
    </div>
  );
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
          className="block min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/85"
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

function RuntimePathEditor({
  config,
  busy,
  candidates = [],
  candidatesLoading = false,
  onOpenPath,
  onRefreshCandidates,
  onReset,
  onSave,
  onSelectPython,
}: {
  config: RuntimePathConfig;
  busy: boolean;
  candidates?: PythonRuntimeCandidate[];
  candidatesLoading?: boolean;
  onOpenPath: (path: string) => void;
  onRefreshCandidates: () => void;
  onReset: (key: RuntimePathKey) => void;
  onSave: (config: RuntimePathUpdate) => void;
  onSelectPython: () => Promise<string | null>;
}): React.JSX.Element {
  const [value, setValue] = useState(config.value);
  const [customEnabled, setCustomEnabled] = useState(config.customized);

  useEffect(() => {
    setValue(config.value);
    setCustomEnabled(config.customized);
  }, [config.customized, config.value]);

  const dirty = value.trim() !== config.value;
  const isPython = config.key === "python";
  const customPythonEnabled = isPython ? customEnabled : true;
  const pythonCandidateListId = useId();

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{config.label}</span>
            <Badge variant={config.kind === "file" ? "secondary" : "outline"}>
              {config.kind === "file" ? "文件" : "目录"}
            </Badge>
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={config.defaultValue}>
            默认: {config.defaultValue}
          </p>
        </div>
        <Badge variant={config.customized ? "warning" : "secondary"}>
          {isPython ? (config.customized ? "自定义 Python" : "基础 Python + 覆盖层") : config.customized ? "自定义" : "默认"}
        </Badge>
      </div>
      {isPython ? (
        <label className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-sm">
          <Checkbox
            checked={customPythonEnabled}
            disabled={busy}
            onCheckedChange={(checked) => {
              if (checked === true) {
                setCustomEnabled(true);
                setValue(config.value || config.defaultValue);
                return;
              }
              setCustomEnabled(false);
              onReset(config.key);
            }}
          />
          使用自定义 Python 路径
        </label>
      ) : null}
      <div className="flex min-w-0 gap-2">
        <Input
          aria-label={`${config.label} 路径`}
          list={isPython && customPythonEnabled ? pythonCandidateListId : undefined}
          disabled={isPython && !customPythonEnabled}
          monospace
          onChange={(event) => setValue(event.target.value)}
          placeholder={config.defaultValue}
          value={value}
        />
        {isPython && customPythonEnabled ? (
          <datalist id={pythonCandidateListId}>
            {candidates.map((candidate) => (
              <option key={candidate.path} label={candidate.source} value={candidate.path} />
            ))}
          </datalist>
        ) : null}
        <Button aria-label={`打开 ${config.label}`} onClick={() => onOpenPath(value)} size="icon" variant="ghost">
          <FolderOpen />
        </Button>
        {isPython ? (
          <Button
            disabled={busy || !customPythonEnabled}
            onClick={async () => {
              const selected = await onSelectPython();
              if (selected) {
                setValue(selected);
              }
            }}
            size="sm"
            variant="outline"
          >
            <FolderOpen />
            浏览
          </Button>
        ) : null}
      </div>
      {isPython && customPythonEnabled ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2">
          <p className="text-[11px] text-muted-foreground">
            {candidatesLoading
              ? "正在扫描系统 Python"
              : candidates.length > 0
                ? `已扫描到 ${candidates.length} 个 Python，可在输入框右侧下拉选择。`
                : "可手动输入 python.exe 路径，或点击扫描读取系统 Python。"}
          </p>
          <Button disabled={busy || candidatesLoading} onClick={onRefreshCandidates} size="sm" variant="ghost">
            {candidatesLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            扫描
          </Button>
        </div>
      ) : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          disabled={busy || (!config.customized && !dirty)}
          onClick={() => onReset(config.key)}
          size="sm"
          variant="ghost"
        >
          {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          恢复默认
        </Button>
        <Button
          disabled={busy || (isPython && !customPythonEnabled) || !dirty || value.trim().length === 0}
          onClick={() => onSave({ key: config.key, value: value.trim() })}
          size="sm"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          保存路径
        </Button>
      </div>
    </div>
  );
}

function RuntimeResourcePathEditor({
  config,
  busy,
  blocked,
  onOpenPath,
  onMigrate,
  onReset,
  onSave,
  onSelect,
}: {
  config: RuntimeResourcePathConfig;
  busy: boolean;
  blocked: boolean;
  onOpenPath: (path: string) => void;
  onMigrate: (key: RuntimeResourcePathKey) => void;
  onReset: (key: RuntimeResourcePathKey) => void;
  onSave: (key: RuntimeResourcePathKey, path: string) => void;
  onSelect: (key: RuntimeResourcePathKey) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(config.value);

  useEffect(() => {
    setValue(config.value);
  }, [config.value]);

  const trimmedValue = value.trim();
  const dirty = trimmedValue !== config.value;

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{config.label}</span>
            <Badge variant={config.customized ? "warning" : "secondary"}>
              {config.customized ? "自定义" : "默认"}
            </Badge>
          </div>
        </div>
        <Button aria-label={`打开 ${config.label}`} onClick={() => onOpenPath(trimmedValue || config.value)} size="icon" variant="ghost">
          <FolderOpen />
        </Button>
      </div>
      <Input
        aria-label={`${config.label} 当前路径`}
        className="mt-3"
        monospace
        onChange={(event) => setValue(event.target.value)}
        value={value}
      />
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button disabled={busy || blocked} onClick={() => onSelect(config.key)} size="sm" variant="ghost">
          {busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          选择已有目录
        </Button>
        <Button
          disabled={busy || blocked || !dirty || trimmedValue.length === 0}
          onClick={() => onSave(config.key, trimmedValue)}
          size="sm"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          保存路径
        </Button>
        <Button disabled={busy || blocked} onClick={() => onMigrate(config.key)} size="sm" variant="secondary">
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          迁移到新目录
        </Button>
        <Button
          disabled={busy || blocked || !config.customized}
          onClick={() => onReset(config.key)}
          size="sm"
          variant="ghost"
        >
          {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          恢复默认
        </Button>
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
    commandConfig && commandLine.trim() !== commandConfig.commandLine,
  );

  return (
    <div className="rounded-lg border border-border bg-card p-3">
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
          {service.managed
            ? `${service.terminalMode === "external" ? "外部" : "内嵌"} PID ${service.pid ?? "-"}`
            : "未托管"}
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
        <code className="mt-3 block overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-foreground/75">
          {service.command.join(" ")}
        </code>
      ) : null}
      {commandConfig ? (
        <div className="mt-3 grid gap-2 rounded-md border border-border bg-muted/40 p-2.5">
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
            disabled
            monospace
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
                disabled={commandBusy || !configDirty || commandLine.trim().length === 0}
                onClick={() =>
                  onSaveCommand({
                    serviceId: service.id,
                    cwd: commandConfig.defaultCwd,
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
    <div className="grid grid-cols-[74px_66px_minmax(0,1fr)] gap-2 border-b border-border px-3 py-2 font-mono text-[11px] last:border-b-0">
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
  const [confirmUpdateOpen, setConfirmUpdateOpen] = useState(false);
  const [moduleUpdateResult, setModuleUpdateResult] = useState<ModuleUpdateResult | null>(null);
  const [moduleSourceConfig, setModuleSourceConfig] = useState<ModuleSourceConfig | null>(null);
  const [moduleSourcePreset, setModuleSourcePreset] = useState<ModuleSourcePreset>("ghproxy");
  const [customMaiBotUrl, setCustomMaiBotUrl] = useState("");
  const [customNapcatAdapterUrl, setCustomNapcatAdapterUrl] = useState("");
  const [maibotTags, setMaibotTags] = useState<ModuleTagOption[]>([]);
  const [selectedMaibotTag, setSelectedMaibotTag] = useState("");
  const [pythonDepsState, setPythonDepsState] = useState<PythonOverridesState | null>(null);
  const [pythonVersionsOpen, setPythonVersionsOpen] = useState(false);
  const [pythonVersions, setPythonVersions] = useState<PythonPackageVersionList | null>(null);
  const [selectedPythonVersion, setSelectedPythonVersion] = useState("");
  const [pythonInstallResult, setPythonInstallResult] = useState<PythonPackageInstallResult | null>(null);
  const [pythonRuntimeCandidates, setPythonRuntimeCandidates] = useState<PythonRuntimeCandidate[]>([]);
  const [pythonRuntimeCandidatesLoading, setPythonRuntimeCandidatesLoading] = useState(false);
  const initState = snapshot.initState ?? { isReady: false, checks: [] };
  const services = snapshot.services ?? [];
  const serviceCommands = snapshot.serviceCommands ?? [];
  const runtimePathConfigs = snapshot.runtimePathConfigs ?? [];
  const runtimeResourcePathConfigs = snapshot.runtimeResourcePathConfigs ?? [];
  const editableRuntimeResourcePathConfigs = runtimeResourcePathConfigs.filter((config) => config.key !== "pythonOverrides");
  const customPythonRuntimeEnabled = runtimePathConfigs.some((config) => config.key === "python" && config.customized);
  const terminalSettings = snapshot.terminalSettings ?? { useEmbeddedTerminal: true };
  const recentLogEntries = snapshot.recentLogs ?? [];
  const maibotService = services.find((service) => service.id === "maibot");
  const maibotUpdateBlocked = Boolean(
    maibotService &&
      (maibotService.managed ||
        maibotService.status === "starting" ||
        maibotService.status === "running" ||
        maibotService.status === "stopping"),
  );
  const resourceMoveBlocked = services.some(
    (service) =>
      service.managed ||
      service.status === "starting" ||
      service.status === "running" ||
      service.status === "stopping",
  );
  useEffect(() => {
    setQqAccount(initState.qqAccount ?? "");
  }, [initState.qqAccount]);

  useEffect(() => {
    let mounted = true;
    window.maibotDesktop?.pythonDeps
      .getState()
      .then((state) => {
        if (mounted) {
          setPythonDepsState(state);
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    window.maibotDesktop?.modules
      .getSourceConfig()
      .then((config) => {
        if (!mounted) {
          return;
        }
        setModuleSourceConfig(config);
        setModuleSourcePreset(config.preset);
        setCustomMaiBotUrl(config.maibotUrl);
        setCustomNapcatAdapterUrl(config.napcatAdapterUrl);
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!snapshot.paths.pythonOverridesRoot) {
      return;
    }

    setPythonDepsState((state) =>
      state ? { ...state, root: snapshot.paths.pythonOverridesRoot } : state,
    );
  }, [snapshot.paths.pythonOverridesRoot]);

  const refreshMaiBotTags = useCallback(async () => {
    try {
      const tags = await window.maibotDesktop?.modules.listMaiBotTags();
      setMaibotTags(tags ?? []);
    } catch {
      setMaibotTags([]);
    }
  }, []);

  const refreshPythonRuntimeCandidates = useCallback(async () => {
    setPythonRuntimeCandidatesLoading(true);
    try {
      const candidates = await window.maibotDesktop?.services.listPythonRuntimeCandidates();
      setPythonRuntimeCandidates(candidates ?? []);
    } catch {
      setPythonRuntimeCandidates([]);
    } finally {
      setPythonRuntimeCandidatesLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMaiBotTags();
  }, [refreshMaiBotTags]);

  useEffect(() => {
    void refreshPythonRuntimeCandidates();
  }, [refreshPythonRuntimeCandidates]);

  const attentionChecks = useMemo(
    () => initState.checks.filter((check) => check.status !== "ok"),
    [initState.checks],
  );
  const recentLogs = useMemo(() => recentLogEntries.slice(-80).reverse(), [recentLogEntries]);

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await window.maibotDesktop?.getSnapshot();
    if (nextSnapshot) {
      onSnapshot(nextSnapshot);
    }
  }, [onSnapshot]);

  const openPath = useCallback((path: string) => {
    void window.maibotDesktop?.openPath(path);
  }, []);

  const openExternal = useCallback((url: string) => {
    void window.maibotDesktop?.openExternal(url);
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
      await window.maibotDesktop?.init.setQqAccount({
        qqAccount: trimmed,
        websocketToken: createSecureToken(),
      });
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

  const updateMaiBot = useCallback(async () => {
    setBusy("module:maibot");
    setError(null);
    try {
      if (!window.maibotDesktop?.modules) {
        throw new Error("桌面桥未就绪，无法更新模块");
      }

      const result = await window.maibotDesktop.modules.updateMaiBot(selectedMaibotTag || undefined);
      setModuleUpdateResult(result);
      setConfirmUpdateOpen(false);
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot, selectedMaibotTag]);

  const saveModuleSourceConfig = useCallback(async () => {
    setBusy("module:source");
    setError(null);
    try {
      if (!window.maibotDesktop?.modules) {
        throw new Error("妗岄潰妗ユ湭灏辩华锛屾棤娉曚繚瀛樻ā鍧楁洿鏂版簮");
      }

      const config = await window.maibotDesktop.modules.saveSourceConfig({
        preset: moduleSourcePreset,
        maibotUrl: customMaiBotUrl,
        napcatAdapterUrl: customNapcatAdapterUrl,
      });
      setModuleSourceConfig(config);
      setModuleSourcePreset(config.preset);
      setCustomMaiBotUrl(config.maibotUrl);
      setCustomNapcatAdapterUrl(config.napcatAdapterUrl);
      setSelectedMaibotTag("");
      toast.success("更新源已保存");
      void refreshMaiBotTags();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [customMaiBotUrl, customNapcatAdapterUrl, moduleSourcePreset, refreshMaiBotTags]);

  const openPythonVersions = useCallback(async (packageName: ManagedPythonPackageName) => {
    setPythonVersionsOpen(true);
    setPythonVersions(null);
    setSelectedPythonVersion("");
    setBusy(`py:list:${packageName}`);
    setError(null);
    try {
      if (!window.maibotDesktop?.pythonDeps) {
        throw new Error("桌面桥未就绪，无法更新 Python 依赖");
      }

      const versions = await window.maibotDesktop.pythonDeps.listVersions(packageName);
      setPythonVersions(versions);
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, []);

  const installPythonVersion = useCallback(async () => {
    if (!pythonVersions || selectedPythonVersion.length === 0) {
      return;
    }

    setBusy(`py:install:${pythonVersions.packageName}`);
    setError(null);
    try {
      if (!window.maibotDesktop?.pythonDeps) {
        throw new Error("桌面桥未就绪，无法更新 Python 依赖");
      }

      const result = await window.maibotDesktop.pythonDeps.installVersion({
        packageName: pythonVersions.packageName,
        version: selectedPythonVersion,
      });
      setPythonInstallResult(result);
      setPythonVersionsOpen(false);
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [pythonVersions, refreshSnapshot, selectedPythonVersion]);

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

  const saveRuntimePathConfig = useCallback(
    async (config: RuntimePathUpdate) => {
      setBusy(`path:${config.key}`);
      setError(null);
      try {
        const runtimePathConfigs = await window.maibotDesktop?.services.saveRuntimePathConfig(config);
        if (runtimePathConfigs) {
          onSnapshot({ ...snapshot, runtimePathConfigs });
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

  const resetRuntimePathConfig = useCallback(
    async (key: RuntimePathKey) => {
      setBusy(`path:${key}`);
      setError(null);
      try {
        const runtimePathConfigs = await window.maibotDesktop?.services.resetRuntimePathConfig(key);
        if (runtimePathConfigs) {
          onSnapshot({ ...snapshot, runtimePathConfigs });
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

  const selectPythonRuntimePath = useCallback(async () => {
    return window.maibotDesktop?.services.selectPythonRuntimePath() ?? null;
  }, []);

  const saveTerminalSettings = useCallback(
    async (settings: TerminalSettings) => {
      setBusy("terminal-settings");
      setError(null);
      try {
        const terminalSettings = await window.maibotDesktop?.services.saveTerminalSettings(settings);
        if (terminalSettings) {
          onSnapshot({ ...snapshot, terminalSettings });
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

  const migrateRuntimeResourcePath = useCallback(async (key: RuntimeResourcePathKey) => {
    setBusy(`resource:migrate:${key}`);
    setError(null);
    try {
      if (!window.maibotDesktop?.resources) {
        throw new Error("桌面桥未就绪，无法迁移资源路径");
      }

      const result = await window.maibotDesktop.resources.migratePath(key);
      if (result) {
        toast.success("资源路径已迁移");
        await refreshSnapshot();
      }
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const selectRuntimeResourcePath = useCallback(async (key: RuntimeResourcePathKey) => {
    setBusy(`resource:select:${key}`);
    setError(null);
    try {
      if (!window.maibotDesktop?.resources) {
        throw new Error("桌面桥未就绪，无法选择资源路径");
      }

      const result = await window.maibotDesktop.resources.selectPath(key);
      if (result) {
        toast.success("资源路径已切换");
        await refreshSnapshot();
      }
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const saveRuntimeResourcePath = useCallback(async (key: RuntimeResourcePathKey, path: string) => {
    setBusy(`resource:save:${key}`);
    setError(null);
    try {
      if (!window.maibotDesktop?.resources) {
        throw new Error("桌面桥未就绪，无法保存资源路径");
      }

      await window.maibotDesktop.resources.savePath(key, path);
      toast.success("资源路径已保存");
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const resetRuntimeResourcePath = useCallback(async (key: RuntimeResourcePathKey) => {
    setBusy(`resource:reset:${key}`);
    setError(null);
    try {
      if (!window.maibotDesktop?.resources) {
        throw new Error("桌面桥未就绪，无法恢复资源路径");
      }

      await window.maibotDesktop.resources.resetPath(key);
      toast.success("资源路径已恢复默认");
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const canSaveQq = busy === null && qqAccount.trim().length > 0;
  useShortcut("Mod+Enter", saveQqAccount, { enabled: canSaveQq, allowInEditable: true });
  useShortcut("Mod+Shift+R", repair, { enabled: busy === null });

  return (
    <>
    <section className="h-full overflow-auto bg-background px-6 py-6">
      <div className="mx-auto w-full max-w-[1180px]">
        <Card className="border-border bg-card ">
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
                    <ClipboardCheck className="size-4" />
                  </span>
                  设置中心
                </CardTitle>
                <CardDescription className="mt-1">
                  使用迷你标签页快速切换配置分区，避免信息拥挤与错位。
                </CardDescription>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Badge dot variant={initState.isReady ? "success" : "danger"}>
                  {initState.isReady ? "环境可启动" : "环境不完整"}
                </Badge>
                <Badge variant={attentionChecks.length > 0 ? "warning" : "secondary"}>
                  {attentionChecks.length} 项待处理
                </Badge>
                <Badge variant="secondary">服务 {services.length} 个</Badge>
              </div>
            </div>
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
                {error}
              </div>
            ) : null}
          </CardHeader>

          <CardContent>
            <Tabs className="space-y-4" defaultValue="checks">
              <TabsList className="h-8 rounded-md border border-border bg-muted/40 p-1">
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="checks">
                  <ClipboardCheck className="size-3" />
                  环境检查
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="account">
                  <UserRound className="size-3" />
                  账号配置
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="services">
                  <Network className="size-3" />
                  服务状态
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="modules">
                  <Download className="size-3" />
                  模块更新
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="paths">
                  <ShieldCheck className="size-3" />
                  实例路径
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="logs">
                  <HardDrive className="size-3" />
                  运行日志
                </TabsTrigger>
              </TabsList>

              <TabsContent className="space-y-4" value="checks">
                <div className="grid gap-2 md:grid-cols-2">
                  {initState.checks.map((check) => (
                    <div
                      className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5"
                      key={check.id}
                    >
                      {check.status === "ok" ? (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                      ) : (
                        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
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
                      {check.actionUrl ? (
                        <Button
                          className="h-7 shrink-0 px-2 text-[11px]"
                          onClick={() => openExternal(check.actionUrl ?? "")}
                          size="sm"
                          title={check.actionLabel ?? "打开下载页面"}
                          variant="outline"
                        >
                          <Download className="size-3" />
                          {check.actionLabel ?? "下载"}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="flex justify-end rounded-lg border border-border bg-muted/40 p-3">
                  <Button disabled={busy !== null} onClick={repair} variant="outline">
                    {busy === "repair" ? <Loader2 className="animate-spin" /> : <Wrench />}
                    准备基础目录
                    <Kbd className="ml-1" keys="Mod+Shift+R" size="xs" tone="muted" />
                  </Button>
                </div>
              </TabsContent>

              <TabsContent className="space-y-4" value="account">
                <p className="text-xs text-muted-foreground">
                  机器人 QQ 号配置将用于 NapCat 登录与联动，请确保填写的是目标机器人账号。
                </p>
                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-[minmax(0,1fr)_auto]">
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
                </div>
              </TabsContent>

              <TabsContent className="space-y-3" value="services">
                <p className="text-xs text-muted-foreground">
                  固定端口模式；端口冲突时报错。托管进程异常退出会有限次自动重启。
                </p>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <TerminalSquare className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">终端模式</p>
                      <p className="text-xs text-muted-foreground">
                        {terminalSettings.useEmbeddedTerminal
                          ? "服务会在应用内终端页运行"
                          : "服务会在外部 Windows 终端窗口运行"}
                      </p>
                    </div>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <Checkbox
                      checked={terminalSettings.useEmbeddedTerminal}
                      disabled={busy !== null}
                      onCheckedChange={(checked) =>
                        void saveTerminalSettings({ useEmbeddedTerminal: checked === true })
                      }
                    />
                    使用内嵌终端
                  </label>
                </div>
                {services.map((service) => (
                  <ServiceDetail
                    commandBusy={busy === `command:${service.id}`}
                    commandConfig={serviceCommands.find((config) => config.serviceId === service.id)}
                    key={service.id}
                    onOpenPath={openPath}
                    onResetCommand={resetCommandConfig}
                    onSaveCommand={saveCommandConfig}
                    service={service}
                  />
                ))}
              </TabsContent>

              <TabsContent className="space-y-3" value="modules">
                <p className="text-xs text-muted-foreground">
                  使用可用 Git 更新可写 MaiBot 模块。更新器不会执行清理命令，不会删除 data、logs、config 等用户数据目录。
                </p>
                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
                          <GitBranch className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">MaiBot Core</p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground" title={snapshot.paths.maibotRoot}>
                            {snapshot.paths.maibotRoot}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {maibotService ? (
                        <Badge dot variant={statusVariant[maibotService.status]}>
                          {statusText[maibotService.status]}
                        </Badge>
                      ) : null}
                      <select
                        className="h-9 max-w-56 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        disabled={busy !== null}
                        onChange={(event) => setSelectedMaibotTag(event.target.value)}
                        value={selectedMaibotTag}
                      >
                        <option value="">默认分支</option>
                        {maibotTags.map((tag) => (
                          <option key={tag.name} value={tag.name}>
                            {tag.name}{tag.isPrerelease ? " (测试)" : ""}
                          </option>
                        ))}
                      </select>
                      <Button disabled={busy !== null} onClick={refreshMaiBotTags} size="icon-sm" variant="outline">
                        <RefreshCw />
                      </Button>
                      <Button
                        disabled={busy !== null || maibotUpdateBlocked}
                        onClick={() => setConfirmUpdateOpen(true)}
                      >
                        {busy === "module:maibot" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        更新 MaiBot
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-3 rounded-md border border-border bg-card/60 p-3 lg:grid-cols-[220px_minmax(0,1fr)_auto] lg:items-end">
                    <label className="grid gap-1.5 text-xs font-medium">
                      更新源
                      <select
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        disabled={busy !== null}
                        value={moduleSourcePreset}
                        onChange={(event) => {
                          const preset = event.target.value as ModuleSourcePreset;
                          setModuleSourcePreset(preset);
                          const option = moduleSourceConfig?.options.find((item) => item.preset === preset);
                          if (option) {
                            setCustomMaiBotUrl(option.maibotUrl);
                          }
                        }}
                      >
                        {moduleSourceConfig?.options.map((option) => (
                          <option key={option.preset} value={option.preset}>
                            {option.label}
                          </option>
                        ))}
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                    <label className="grid gap-1.5 text-xs font-medium">
                      MaiBot 仓库
                      <Input
                        disabled={busy !== null || moduleSourcePreset !== "custom"}
                        onChange={(event) => setCustomMaiBotUrl(event.target.value)}
                        value={customMaiBotUrl}
                      />
                    </label>
                    <Button
                      disabled={busy !== null || !moduleSourceConfig}
                      onClick={saveModuleSourceConfig}
                      size="sm"
                      variant="secondary"
                    >
                      {busy === "module:source" ? <Loader2 className="animate-spin" /> : <Save />}
                      保存更新源
                    </Button>
                  </div>
                  {maibotUpdateBlocked ? (
                    <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-foreground">
                      请先停止 MaiBot Core，再执行模块更新。
                    </div>
                  ) : (
                    <div className="rounded-md border border-border bg-card/70 px-3 py-2 text-xs text-muted-foreground">
                      会强制同步远端代码并覆盖模块内的本地代码改动；用户运行数据仍保留在 MaiBot/data。
                    </div>
                  )}
                </div>
                {moduleUpdateResult ? <ModuleUpdateOutput result={moduleUpdateResult} /> : null}

                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
                          <Package className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">手动更新Python 依赖</p>
                          <p
                            className="truncate font-mono text-[11px] text-muted-foreground"
                            title={pythonDepsState?.root ?? ""}
                          >
                            {pythonDepsState?.root ?? "读取覆盖目录中"}
                          </p>
                        </div>
                      </div>
                    </div>
                    <Badge variant="secondary">清华源</Badge>
                  </div>
                  {customPythonRuntimeEnabled ? (
                    <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-foreground">
                      已启用自定义 Python 路径，MaiBot Core 将直接使用该 Python，不再注入 python覆盖依赖。
                    </div>
                  ) : null}
                  <div className="grid gap-2 md:grid-cols-2">
                    {managedPythonPackages.map((pythonPackage) => (
                      <div
                        className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-card p-2.5"
                        key={pythonPackage.name}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{pythonPackage.label}</p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{pythonPackage.name}</p>
                        </div>
                        <Button
                          disabled={busy !== null || maibotUpdateBlocked || customPythonRuntimeEnabled}
                          onClick={() => void openPythonVersions(pythonPackage.name)}
                          size="sm"
                          variant="outline"
                        >
                          {busy === `py:list:${pythonPackage.name}` ? <Loader2 className="animate-spin" /> : <Download />}
                          选择版本
                        </Button>
                      </div>
                    ))}
                  </div>
                  {maibotUpdateBlocked ? (
                    <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-foreground">
                      请先停止 MaiBot Core，再更新 Python 覆盖依赖。
                    </div>
                  ) : null}
                </div>
                {pythonInstallResult ? <PythonInstallOutput result={pythonInstallResult} /> : null}
              </TabsContent>

              <TabsContent className="space-y-3" value="paths">
                <p className="text-xs text-muted-foreground">
                  用户数据目录保存一键包设置；一套数据只绑定一套覆盖路径，MaiBot、NapCat 与 python可写环境可以分别放在独立目录。
                </p>
                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <HardDrive className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">实例路径</p>
                        <p className="text-xs text-muted-foreground">
                          迁移会复制当前目录内容；选择已有目录只切换指向，不复制数据。
                        </p>
                      </div>
                    </div>
                    <Badge variant="secondary">唯一实例</Badge>
                  </div>
                  <div className="grid gap-2">
                    {editableRuntimeResourcePathConfigs.map((config) => (
                      <RuntimeResourcePathEditor
                        blocked={
                          resourceMoveBlocked ||
                          (busy !== null && !(busy.startsWith("resource:") && busy.endsWith(`:${config.key}`)))
                        }
                        busy={busy?.startsWith(`resource:`) === true && busy.endsWith(`:${config.key}`)}
                        config={config}
                        key={config.key}
                        onMigrate={migrateRuntimeResourcePath}
                        onOpenPath={openPath}
                        onReset={resetRuntimeResourcePath}
                        onSave={saveRuntimeResourcePath}
                        onSelect={selectRuntimeResourcePath}
                      />
                    ))}
                  </div>
                  {resourceMoveBlocked ? (
                    <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-foreground">
                      请先停止所有服务，再调整实例路径。
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-2 pt-2">
                  {runtimePathConfigs.map((config) => (
                    <RuntimePathEditor
                      busy={busy === `path:${config.key}`}
                      candidates={config.key === "python" ? pythonRuntimeCandidates : undefined}
                      candidatesLoading={config.key === "python" ? pythonRuntimeCandidatesLoading : false}
                      config={config}
                      key={config.key}
                      onOpenPath={openPath}
                      onRefreshCandidates={refreshPythonRuntimeCandidates}
                      onReset={resetRuntimePathConfig}
                      onSave={saveRuntimePathConfig}
                      onSelectPython={selectPythonRuntimePath}
                    />
                  ))}
                </div>
                <PathField label="日志目录" onOpen={openPath} value={snapshot.paths.logsRoot} />
                <PathField label="用户数据目录" onOpen={openPath} value={snapshot.paths.userDataRoot} />
                <PathField label="一键包安装目录" onOpen={openPath} value={snapshot.paths.installRoot} />
                <PathField label="python基础环境" onOpen={openPath} value={snapshot.paths.runtimeRoot} />
                <PathField label="内置 modules" onOpen={openPath} value={snapshot.paths.bundledModulesRoot} />
              </TabsContent>

              <TabsContent className="space-y-3" value="logs">
                <p className="text-xs text-muted-foreground">
                  服务 stdout、stderr 和桌面壳系统事件会写入日志目录。
                </p>
                <div className="max-h-[420px] overflow-y-auto rounded-lg border border-border bg-card">
                  {recentLogs.length > 0 ? (
                    recentLogs.map((entry) => <LogLine entry={entry} key={entry.id} />)
                  ) : (
                    <div className="px-3 py-8 text-center text-xs text-muted-foreground">暂无日志</div>
                  )}
                </div>
                <Button disabled={busy !== null} onClick={clearLogs} size="sm" variant="outline">
                  {busy === "logs" ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  清空面板日志
                </Button>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </section>
    <Dialog
      open={pythonVersionsOpen}
      onOpenChange={(next) => {
        if (!next && busy?.startsWith("py:") !== true) setPythonVersionsOpen(false);
      }}
    >
      <DialogContent size="lg">
      <DialogHeader
        description="版本列表来自清华 PyPI 镜像，并按发布时间降序排列；dev 与预发布版本会额外标记。"
        icon={<Package className="size-4" />}
        title={pythonVersions ? `选择 ${pythonVersions.packageName} 版本` : "读取 Python 依赖版本"}
        tone="primary"
      />
      <DialogBody className="space-y-3">
        {pythonVersions ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{pythonVersions.versions.length} 个版本</Badge>
              <span>源: {pythonVersions.sourceUrl}</span>
              <span>获取: {formatDateTime(pythonVersions.fetchedAt)}</span>
              {selectedPythonVersion.length === 0 ? <Badge variant="outline">未选择</Badge> : null}
            </div>
            <ScrollArea className="h-[min(52vh,520px)] rounded-lg border border-border bg-muted/30 p-2">
              <div className="space-y-1">
                {pythonVersions.versions.map((version) => (
                  <label
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-muted"
                    key={version.version}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <input
                        checked={selectedPythonVersion === version.version}
                        className="size-3.5 accent-primary"
                        disabled={busy !== null}
                        name="python-version"
                        onChange={() => setSelectedPythonVersion(version.version)}
                        type="radio"
                      />
                      <span className="truncate font-mono">{version.version}</span>
                      {version.isDev ? <Badge variant="warning">dev</Badge> : null}
                      {!version.isDev && version.isPrerelease ? <Badge variant="warning">预发布</Badge> : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {version.uploadedAtMs ? formatDateTime(version.uploadedAtMs) : "未知时间"}
                    </span>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" />
            正在从清华源读取版本列表
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button disabled={busy?.startsWith("py:install") === true} onClick={() => setPythonVersionsOpen(false)} size="sm" variant="ghost">
          取消
        </Button>
        <Button
          disabled={!pythonVersions || selectedPythonVersion.length === 0 || busy !== null}
          onClick={installPythonVersion}
          size="sm"
        >
          {busy?.startsWith("py:install") === true ? <Loader2 className="animate-spin" /> : <Download />}
          安装选中版本
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog
      open={confirmUpdateOpen}
      onOpenChange={(next) => {
        if (!next && busy !== "module:maibot") setConfirmUpdateOpen(false);
      }}
    >
      <DialogContent size="md">
      <DialogHeader
        description="更新器会使用可用 Git 强制同步 MaiBot 远端代码。它不会执行 git clean，也不会删除 data、logs、config 等用户数据目录。"
        icon={<GitBranch className="size-4" />}
        title="确认更新 MaiBot 模块？"
        tone="warning"
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          这会覆盖 MaiBot 模块里的本地代码改动，并将代码重置到远端分支。用户数据仍保留在可写模块目录下的
          <code className="mx-1 rounded bg-card px-1 py-0.5 font-mono">data</code>
          目录。
        </div>
        {maibotUpdateBlocked ? (
          <div className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
            MaiBot Core 当前未停止，请先停止服务后再更新。
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button disabled={busy === "module:maibot"} onClick={() => setConfirmUpdateOpen(false)} size="sm" variant="ghost">
          取消
        </Button>
        <Button disabled={busy === "module:maibot" || maibotUpdateBlocked} onClick={updateMaiBot} size="sm">
          {busy === "module:maibot" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          确认更新
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
