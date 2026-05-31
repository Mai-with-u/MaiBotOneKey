import {
  AlertTriangle,
  ChevronDown,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Code2,
  Database,
  Download,
  FolderOpen,
  HardDrive,
  ImageIcon,
  Loader2,
  Network,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
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
  AppIconId,
  InitCheckStatus,
  LogEntry,
  MaiBotDataResetResult,
  MaiBotStorageCategory,
  MaiBotStorageCleanupTarget,
  MaiBotStorageStats,
  NetworkProxySettings,
  OpenCodeSettings,
  PluginBuilderMode,
  PythonRuntimeCandidate,
  QqBackend,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CLOSE_PREFERENCE_CHANGE_EVENT,
  getClosePreference,
  isClosePreference,
  setClosePreference,
  type ClosePreference,
} from "@/lib/close-preference";
import {
  RETRO_WINDOW_CORNER_RADIUS_MIN,
  WINDOW_CORNER_RADIUS_MAX,
  WINDOW_CORNER_RADIUS_MIN,
  useAppearance,
  type AccentColor,
  type AppearanceApi,
  type AppearanceMode,
  type FontFamily,
  type InterfaceScale,
} from "@/lib/use-appearance";
import { useShortcut } from "@/lib/use-shortcut";
import { useTheme, type ThemePreference } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import {
  adapterPluginIdForBackend,
  markAdapterConfigPrompted,
  shouldPromptAdapterConfig,
} from "./HomePanel";

interface SettingsStatusPanelProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
  onOpenPluginConfig: (pluginId: string) => void;
  pluginBuilderMode: PluginBuilderMode;
  onPluginBuilderModeChange: (mode: PluginBuilderMode) => void;
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

const closePreferenceText: Record<ClosePreference, string> = {
  ask: "每次询问",
  minimize: "最小化到托盘",
  quit: "关闭应用",
};

const closePreferenceOptions: Array<{ value: ClosePreference; label: string }> = [
  { value: "ask", label: "每次询问" },
  { value: "minimize", label: "最小化到托盘" },
  { value: "quit", label: "关闭应用" },
];

const themeOptions: Array<{ value: ThemePreference; label: string; description: string }> = [
  { value: "system", label: "跟随系统", description: "根据系统浅色/深色模式自动切换。" },
  { value: "light", label: "浅色", description: "保持明亮、低干扰的工作界面。" },
  { value: "dark", label: "深色", description: "使用暗色背景，适合夜间或低光环境。" },
];

const accentOptions: Array<{ value: AccentColor; label: string; color: string }> = [
  { value: "orange", label: "橙色", color: "oklch(0.71 0.175 52)" },
  { value: "green", label: "绿色", color: "oklch(0.62 0.145 150)" },
  { value: "blue", label: "蓝色", color: "oklch(0.62 0.145 250)" },
  { value: "pink", label: "粉色", color: "oklch(0.66 0.17 18)" },
  { value: "neutral", label: "中性", color: "oklch(0.5 0.02 70)" },
];

const fontOptions: Array<{ value: FontFamily; label: string; description: string }> = [
  { value: "system", label: "系统 UI", description: "默认界面字体，兼顾中英文清晰度。" },
  { value: "rounded", label: "圆润", description: "更柔和的显示风格，适合轻松使用。" },
  { value: "serif", label: "衬线", description: "更接近阅读文本的字形风格。" },
];

const scaleOptions: Array<{ value: InterfaceScale; label: string; description: string }> = [
  { value: "compact", label: "紧凑", description: "显示更多内容，控件和文字更小。" },
  { value: "normal", label: "标准", description: "默认的信息密度与字号。" },
  { value: "comfortable", label: "宽松", description: "字号更大，留白更多。" },
];

const appearanceModeOptions: Array<{ value: AppearanceMode; label: string; description: string }> = [
  { value: "future-retro", label: "未来复古", description: "纸面颗粒、硬朗描边和控制台式切角。" },
  { value: "modern", label: "现代", description: "干净卡片、主题色和更通用的桌面应用质感。" },
];

const qqBackendOptions: Array<{ value: QqBackend; label: string; description: string }> = [
  { value: "napcat", label: "NapCat", description: "使用 NapCat 启动 QQ 与 OneBot 连接，WebUI 端口 6099。" },
  { value: "snowluma", label: "SnowLuma", description: "使用 SnowLuma 注入 QQ 进程，WebUI 端口 5099，OneBot 端口 7988。" },
];

const defaultNetworkProxySettings: NetworkProxySettings = {
  enabled: false,
  port: 7890,
};

const defaultOpenCodeSettings: OpenCodeSettings = {
  useBundledPluginInstructions: true,
};

const STARTUP_WIZARD_STORAGE_KEY = "maibot-startup-wizard-seen";

const storageCleanupLabel: Record<MaiBotStorageCleanupTarget, string> = {
  images: "清理图片",
  emoji: "清理表情",
  marketCache: "清理缓存",
  logs: "清理日志",
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
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
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
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
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
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

function StorageCategoryItem({
  category,
  busy,
  cleanupBlocked,
  onCleanup,
  onOpenPath,
}: {
  category: MaiBotStorageCategory;
  busy: boolean;
  cleanupBlocked: boolean;
  onCleanup: (target: MaiBotStorageCleanupTarget) => void;
  onOpenPath: (path: string) => void;
}): React.JSX.Element {
  const cleanupDisabled =
    busy ||
    cleanupBlocked ||
    !category.cleanupTarget ||
    !category.exists ||
    category.sizeBytes <= 0;

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{category.label}</span>
            <Badge variant={category.exists ? "secondary" : "outline"}>
              {category.exists ? formatBytes(category.sizeBytes) : "未生成"}
            </Badge>
            {category.cleanupTarget ? <Badge variant="outline">可清理</Badge> : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{category.description}</p>
        </div>
        <Button aria-label={`打开 ${category.label}`} onClick={() => onOpenPath(category.path)} size="icon" variant="ghost">
          <FolderOpen />
        </Button>
      </div>
      <div className="grid gap-1 font-mono text-[11px] text-muted-foreground sm:grid-cols-3">
        <span>文件 {category.fileCount}</span>
        <span>目录 {Math.max(0, category.directoryCount)}</span>
        <span>更新 {formatDateTime(category.latestModifiedAt)}</span>
      </div>
      {category.cleanupTarget ? (
        <div className="flex justify-end">
          <Button
            disabled={cleanupDisabled}
            onClick={() => category.cleanupTarget && onCleanup(category.cleanupTarget)}
            size="sm"
            variant="outline"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {storageCleanupLabel[category.cleanupTarget]}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AppearanceAccentControl({ appearance }: { appearance: AppearanceApi }): React.JSX.Element {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-card p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">主题色</p>
        <p className="mt-1 text-xs text-muted-foreground">用于按钮、重点数字和选中状态。</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-5">
        {accentOptions.map((option) => (
          <button
            aria-pressed={appearance.accent === option.value}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
              appearance.accent === option.value
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
            key={option.value}
            onClick={() => appearance.setAccent(option.value)}
            type="button"
          >
            <span
              aria-hidden="true"
              className="size-4 shrink-0 rounded-sm border border-foreground/20"
              style={{ background: option.color }}
            />
            <span className="truncate">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AppearanceFontControl({ appearance }: { appearance: AppearanceApi }): React.JSX.Element {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-card p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">字体</p>
        <p className="mt-1 text-xs text-muted-foreground">调整界面文字的整体气质。</p>
      </div>
      <RadioGroup
        className="grid gap-2"
        onValueChange={(value) => appearance.setFont(value as FontFamily)}
        value={appearance.font}
      >
        {fontOptions.map((option) => (
          <label
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 transition-colors",
              appearance.font === option.value
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
            key={option.value}
          >
            <RadioGroupItem className="mt-0.5" value={option.value} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-1 block text-xs leading-relaxed">{option.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

function AppearanceScaleControl({ appearance }: { appearance: AppearanceApi }): React.JSX.Element {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-card p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">界面密度</p>
        <p className="mt-1 text-xs text-muted-foreground">控制字号和控件间距。</p>
      </div>
      <RadioGroup
        className="grid gap-2"
        onValueChange={(value) => appearance.setScale(value as InterfaceScale)}
        value={appearance.scale}
      >
        {scaleOptions.map((option) => (
          <label
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 transition-colors",
              appearance.scale === option.value
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
            key={option.value}
          >
            <RadioGroupItem className="mt-0.5" value={option.value} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-1 block text-xs leading-relaxed">{option.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

function AppearanceRadiusControl({ appearance }: { appearance: AppearanceApi }): React.JSX.Element {
  const windowCornerRadiusMin = appearance.mode === "future-retro"
    ? RETRO_WINDOW_CORNER_RADIUS_MIN
    : WINDOW_CORNER_RADIUS_MIN;

  return (
    <label className="grid gap-2 rounded-md border border-border bg-card p-3">
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium">窗口圆角</span>
          <span className="mt-1 block text-xs text-muted-foreground">影响主窗口和浮窗边角。</span>
        </span>
        <Badge className="shrink-0" variant="secondary">
          {appearance.windowCornerRadius}px
        </Badge>
      </span>
      <input
        className="w-full accent-primary"
        max={WINDOW_CORNER_RADIUS_MAX}
        min={windowCornerRadiusMin}
        onChange={(event) => appearance.setWindowCornerRadius(Number(event.target.value))}
        type="range"
        value={appearance.windowCornerRadius}
      />
      <span className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{windowCornerRadiusMin}px</span>
        <span>{WINDOW_CORNER_RADIUS_MAX}px</span>
      </span>
    </label>
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
  onOpenPluginConfig,
  pluginBuilderMode,
  onPluginBuilderModeChange,
}: SettingsStatusPanelProps): React.JSX.Element {
  const theme = useTheme();
  const appearance = useAppearance();
  const [qqBackend, setQqBackend] = useState<QqBackend>(snapshot.initState.qqBackend ?? "napcat");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSnowLumaResetOpen, setConfirmSnowLumaResetOpen] = useState(false);
  const [confirmQqComponentsUpgradeOpen, setConfirmQqComponentsUpgradeOpen] = useState(false);
  const [confirmLauncherSettingsResetOpen, setConfirmLauncherSettingsResetOpen] = useState(false);
  const [confirmLauncherFullResetOpen, setConfirmLauncherFullResetOpen] = useState(false);
  const [confirmMaiBotDataResetFirstOpen, setConfirmMaiBotDataResetFirstOpen] = useState(false);
  const [confirmMaiBotDataResetSecondOpen, setConfirmMaiBotDataResetSecondOpen] = useState(false);
  const [confirmStorageCleanupTarget, setConfirmStorageCleanupTarget] = useState<MaiBotStorageCleanupTarget | null>(null);
  const [confirmPluginBuilderEnableOpen, setConfirmPluginBuilderEnableOpen] = useState(false);
  const [environmentServicesExpanded, setEnvironmentServicesExpanded] = useState(false);
  const [lastMaiBotDataReset, setLastMaiBotDataReset] = useState<MaiBotDataResetResult | null>(null);
  const [storageStats, setStorageStats] = useState<MaiBotStorageStats | null>(null);
  const [storageStatsLoading, setStorageStatsLoading] = useState(false);
  const [pythonRuntimeCandidates, setPythonRuntimeCandidates] = useState<PythonRuntimeCandidate[]>([]);
  const [pythonRuntimeCandidatesLoading, setPythonRuntimeCandidatesLoading] = useState(false);
  const initState = snapshot.initState ?? {
    isReady: false,
    qqBackend: "napcat",
    messagePlatformConfigured: false,
    checks: [],
  };
  const services = snapshot.services ?? [];
  const maibotService = services.find((service) => service.id === "maibot");
  const serviceCommands = snapshot.serviceCommands ?? [];
  const runtimePathConfigs = snapshot.runtimePathConfigs ?? [];
  const runtimeResourcePathConfigs = snapshot.runtimeResourcePathConfigs ?? [];
  const editableRuntimeResourcePathConfigs = runtimeResourcePathConfigs.filter((config) => config.key !== "pythonOverrides");
  const terminalSettings = snapshot.terminalSettings ?? { useEmbeddedTerminal: true, fontSize: 12 };
  const serviceStartupSettings = snapshot.serviceStartupSettings ?? { useLocalDashboard: false };
  const openCodeSettings = snapshot.openCodeSettings ?? defaultOpenCodeSettings;
  const pluginBuilderEnabled = pluginBuilderMode !== "disabled";
  const appIconSettings = snapshot.appIconSettings ?? { selectedIconId: "sprout" as AppIconId, options: [] };
  const networkProxySettings = snapshot.networkProxySettings ?? defaultNetworkProxySettings;
  const [networkProxyDraft, setNetworkProxyDraft] = useState<NetworkProxySettings>(networkProxySettings);
  const [closePreference, setClosePreferenceState] = useState<ClosePreference>(() => getClosePreference());
  const environmentServicesContentId = useId();
  const recentLogEntries = snapshot.recentLogs ?? [];
  const resourceMoveBlocked = services.some(
    (service) =>
      service.managed ||
      service.status === "starting" ||
      service.status === "running" ||
      service.status === "stopping",
  );
  const maibotDataBlocked = Boolean(
    maibotService?.managed ||
      maibotService?.status === "starting" ||
      maibotService?.status === "running" ||
      maibotService?.status === "stopping",
  );
  const qqBackendSwitchBlocked = services.some(
    (service) =>
      service.status === "starting" ||
      service.status === "running" ||
      service.status === "stopping",
  );
  const networkProxyDirty =
    networkProxyDraft.enabled !== networkProxySettings.enabled ||
    networkProxyDraft.port !== networkProxySettings.port;
  const selectedQqBackendOption =
    qqBackendOptions.find((option) => option.value === qqBackend) ?? qqBackendOptions[0];

  useEffect(() => {
    setNetworkProxyDraft(networkProxySettings);
  }, [networkProxySettings.enabled, networkProxySettings.port]);

  useEffect(() => {
    setQqBackend(initState.qqBackend ?? "napcat");
  }, [initState.qqBackend]);

  useEffect(() => {
    const syncClosePreference = (event?: Event): void => {
      if (event instanceof CustomEvent && isClosePreference(event.detail)) {
        setClosePreferenceState(event.detail);
        return;
      }

      setClosePreferenceState(getClosePreference());
    };

    window.addEventListener(CLOSE_PREFERENCE_CHANGE_EVENT, syncClosePreference);
    window.addEventListener("storage", syncClosePreference);
    return () => {
      window.removeEventListener(CLOSE_PREFERENCE_CHANGE_EVENT, syncClosePreference);
      window.removeEventListener("storage", syncClosePreference);
    };
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

  const refreshStorageStats = useCallback(async () => {
    setStorageStatsLoading(true);
    try {
      const nextStats = await window.maibotDesktop?.data.getMaiBotStorageStats();
      if (nextStats) {
        setStorageStats(nextStats);
      }
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setStorageStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStorageStats();
  }, [refreshStorageStats]);

  const openPath = useCallback((path: string) => {
    void window.maibotDesktop?.openPath(path);
  }, []);

  const openExternal = useCallback((url: string) => {
    void window.maibotDesktop?.openExternal(url);
  }, []);

  const saveClosePreference = useCallback((preference: ClosePreference) => {
    setClosePreference(preference);
    setClosePreferenceState(preference);
    toast.success(`关闭行为已设为：${closePreferenceText[preference]}`);
  }, []);

  const requestPluginBuilderEnabledChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        if (pluginBuilderMode === "disabled") {
          setConfirmPluginBuilderEnableOpen(true);
        }
        return;
      }

      onPluginBuilderModeChange("disabled");
      toast.success("插件编写器入口已关闭");
    },
    [onPluginBuilderModeChange, pluginBuilderMode],
  );

  const confirmPluginBuilderEnable = useCallback(() => {
    onPluginBuilderModeChange("agent");
    setConfirmPluginBuilderEnableOpen(false);
    toast.success("插件编写器入口已打开");
  }, [onPluginBuilderModeChange]);

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

  const saveQqBackend = useCallback(async () => {
    if (qqBackend !== initState.qqBackend && qqBackendSwitchBlocked) {
      setError("MaiBot Core 或 QQ 后端正在运行时不能切换 NapCat / SnowLuma，请先停止全部服务。");
      return;
    }
    setBusy("qq");
    setError(null);
    try {
      if (qqBackend !== initState.qqBackend) {
        const shouldOpenAdapterConfig = shouldPromptAdapterConfig(qqBackend);
        await window.maibotDesktop?.init.setQqBackend(qqBackend);
        if (shouldOpenAdapterConfig) {
          markAdapterConfigPrompted(qqBackend);
          window.setTimeout(() => onOpenPluginConfig(adapterPluginIdForBackend(qqBackend)), 250);
        }
      } else {
        return;
      }
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [initState.qqBackend, onOpenPluginConfig, qqBackend, qqBackendSwitchBlocked, refreshSnapshot]);

  const resetSnowLumaComponent = useCallback(async () => {
    if (qqBackendSwitchBlocked) {
      setError("请先停止 MaiBot Core 和 QQ 后端，再重置 SnowLuma 组件。");
      return;
    }

    setBusy("snowluma:reset");
    setError(null);
    try {
      await window.maibotDesktop?.init.resetSnowLuma();
      setConfirmSnowLumaResetOpen(false);
      toast.success("SnowLuma 组件已重置");
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [qqBackendSwitchBlocked, refreshSnapshot]);

  const upgradeQqComponents = useCallback(async () => {
    if (qqBackendSwitchBlocked) {
      setError("请先停止 MaiBot Core 和 QQ 后端，再升级 NapCat / SnowLuma。");
      return;
    }

    setBusy("qq-components:upgrade");
    setError(null);
    try {
      const result = await window.maibotDesktop?.init.upgradeQqComponents();
      setConfirmQqComponentsUpgradeOpen(false);
      const preservedCount = result?.components.reduce((total, component) => total + component.preservedEntries.length, 0) ?? 0;
      toast.success(`NapCat / SnowLuma 已升级，保留 ${preservedCount} 项配置与数据`);
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [qqBackendSwitchBlocked, refreshSnapshot]);

  const resetLocalStartupState = useCallback(() => {
    try {
      window.localStorage.removeItem(STARTUP_WIZARD_STORAGE_KEY);
    } catch {
      // Ignore storage failures; the main reset has already completed.
    }
    setClosePreference("ask");
    setClosePreferenceState("ask");
  }, []);

  const reloadAfterLauncherReset = useCallback(() => {
    window.setTimeout(() => {
      window.location.reload();
    }, 250);
  }, []);

  const resetLauncherSettings = useCallback(async () => {
    if (resourceMoveBlocked) {
      setError("请先停止全部服务，再清空启动器设置。");
      return;
    }

    setBusy("launcher:reset-settings");
    setError(null);
    try {
      if (!window.maibotDesktop?.launcher) {
        throw new Error("桌面桥未就绪，无法清空启动器设置");
      }
      await window.maibotDesktop.launcher.resetSettings();
      resetLocalStartupState();
      setConfirmLauncherSettingsResetOpen(false);
      toast.success("启动器设置已清空，即将重新进入启动引导");
      reloadAfterLauncherReset();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [reloadAfterLauncherReset, resetLocalStartupState, resourceMoveBlocked]);

  const resetLauncherAll = useCallback(async () => {
    if (resourceMoveBlocked) {
      setError("请先停止全部服务，再还原初始状态。");
      return;
    }

    setBusy("launcher:reset-all");
    setError(null);
    try {
      if (!window.maibotDesktop?.launcher) {
        throw new Error("桌面桥未就绪，无法还原初始状态");
      }
      await window.maibotDesktop.launcher.resetAll();
      resetLocalStartupState();
      setConfirmLauncherFullResetOpen(false);
      toast.success("运行时资源目录已清空，即将回到初始状态");
      reloadAfterLauncherReset();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [reloadAfterLauncherReset, resetLocalStartupState, resourceMoveBlocked]);

  const resetMaiBotData = useCallback(async () => {
    setBusy("maibot:data-reset");
    setError(null);
    try {
      if (!window.maibotDesktop?.data) {
        throw new Error("桌面桥未就绪，无法重置 MaiBot 数据");
      }
      const result = await window.maibotDesktop.data.resetMaiBotData();
      setLastMaiBotDataReset(result);
      setConfirmMaiBotDataResetSecondOpen(false);
      toast.success(`已清空 MaiBot 数据（共 ${result.removedEntries.length} 项）`, {
        description: result.dataDir,
      });
      await refreshStorageStats();
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot, refreshStorageStats]);

  const cleanupMaiBotStorage = useCallback(async () => {
    if (!confirmStorageCleanupTarget) {
      return;
    }
    if (maibotDataBlocked) {
      setError("请先停止 MaiBot Core，再清理本地数据。");
      return;
    }

    setBusy(`storage:cleanup:${confirmStorageCleanupTarget}`);
    setError(null);
    try {
      if (!window.maibotDesktop?.data) {
        throw new Error("桌面桥未就绪，无法清理 MaiBot 数据");
      }
      const result = await window.maibotDesktop.data.cleanupMaiBotStorage(confirmStorageCleanupTarget);
      setConfirmStorageCleanupTarget(null);
      toast.success(`${storageCleanupLabel[result.target]}完成`, {
        description: `移除 ${result.removedEntries.length} 项，释放 ${formatBytes(result.removedBytes)}`,
      });
      await refreshStorageStats();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [confirmStorageCleanupTarget, maibotDataBlocked, refreshStorageStats]);

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

  const saveServiceStartupSettings = useCallback(
    async (settings: typeof serviceStartupSettings) => {
      setBusy("service-startup-settings");
      setError(null);
      try {
        const nextServiceStartupSettings = await window.maibotDesktop?.services.saveStartupSettings(settings);
        if (nextServiceStartupSettings) {
          onSnapshot({ ...snapshot, serviceStartupSettings: nextServiceStartupSettings });
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

  const saveNetworkProxySettings = useCallback(async () => {
    setBusy("network-proxy");
    setError(null);
    try {
      const nextNetworkProxySettings =
        await window.maibotDesktop?.launcher.saveNetworkProxySettings(networkProxyDraft);
      if (nextNetworkProxySettings) {
        onSnapshot({ ...snapshot, networkProxySettings: nextNetworkProxySettings });
        setNetworkProxyDraft(nextNetworkProxySettings);
      }
      toast.success("网络代理设置已保存");
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [networkProxyDraft, onSnapshot, refreshSnapshot, snapshot]);

  const saveOpenCodeSettings = useCallback(
    async (settings: OpenCodeSettings) => {
      setBusy("opencode-settings");
      setError(null);
      try {
        const nextOpenCodeSettings = await window.maibotDesktop?.launcher.saveOpenCodeSettings(settings);
        if (nextOpenCodeSettings) {
          onSnapshot({ ...snapshot, openCodeSettings: nextOpenCodeSettings });
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

  const selectAppIcon = useCallback(
    async (iconId: AppIconId) => {
      if (iconId === appIconSettings.selectedIconId) {
        return;
      }
      setBusy("app-icon");
      setError(null);
      try {
        if (!window.maibotDesktop?.launcher) {
          throw new Error("Electron bridge 未连接");
        }
        const nextAppIconSettings = await window.maibotDesktop.launcher.selectAppIcon(iconId);
        onSnapshot({ ...snapshot, appIconSettings: nextAppIconSettings });
        toast.success("应用图标已切换");
      } catch (nextError) {
        setError(messageFromError(nextError));
      } finally {
        setBusy(null);
      }
    },
    [appIconSettings.selectedIconId, onSnapshot, snapshot],
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

  const canSaveQqBackend =
    busy === null &&
    qqBackend !== initState.qqBackend &&
    (qqBackend === initState.qqBackend || !qqBackendSwitchBlocked);
  useShortcut("Mod+Enter", saveQqBackend, { enabled: canSaveQqBackend, allowInEditable: true });
  useShortcut("Mod+Shift+R", repair, { enabled: busy === null });

  const environmentServicesPanel = (
    <>
      <Button
        aria-controls={environmentServicesContentId}
        aria-expanded={environmentServicesExpanded}
        className="h-auto w-full justify-between gap-3 whitespace-normal rounded-lg border-border bg-muted/40 px-3 py-3 text-left"
        onClick={() => setEnvironmentServicesExpanded((expanded) => !expanded)}
        type="button"
        variant="outline"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <ClipboardCheck className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {environmentServicesExpanded ? "收起环境与服务" : "展开环境与服务"}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {attentionChecks.length > 0 ? `${attentionChecks.length} 项待处理` : "环境检查正常"} · 服务{" "}
              {services.length} 个
            </span>
          </span>
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 transition-transform", environmentServicesExpanded && "rotate-180")}
        />
      </Button>

      {environmentServicesExpanded ? (
        <div className="space-y-4" id={environmentServicesContentId}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">环境检查</p>
              <p className="mt-1 text-xs text-muted-foreground">
                检查运行目录、基础依赖和必要工具是否可用。
              </p>
            </div>
            <Button disabled={busy !== null} onClick={repair} variant="outline">
              {busy === "repair" ? <Loader2 className="animate-spin" /> : <Wrench />}
              准备基础目录
              <Kbd className="ml-1" keys="Mod+Shift+R" size="xs" tone="muted" />
            </Button>
          </div>
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

          <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <Network className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">服务状态</p>
                <p className="text-xs text-muted-foreground">
                  固定端口模式；端口冲突时报错。托管进程异常退出会有限次自动重启。
                </p>
              </div>
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
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <>
    <section
      className={cn(
        "h-full overflow-auto px-6 py-6",
        appearance.mode === "future-retro" ? "bg-transparent" : "bg-background",
      )}
    >
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
            <Tabs className="space-y-4" defaultValue="general">
              <TabsList className="flex h-auto flex-wrap rounded-md border border-border bg-muted/40 p-1">
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="general">
                  <Settings className="size-3" />
                  通用
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="appearance">
                  <Palette className="size-3" />
                  外观
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="account">
                  <UserRound className="size-3" />
                  协议端选择
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="paths">
                  <ShieldCheck className="size-3" />
                  实例路径
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="data">
                  <Database className="size-3" />
                  数据
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2.5 text-[11px]" value="logs">
                  <HardDrive className="size-3" />
                  运行日志
                </TabsTrigger>
              </TabsList>

              <TabsContent className="space-y-4" value="general">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <Settings className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">窗口关闭行为</p>
                      <p className="text-xs text-muted-foreground">关闭主窗口时如何处理。</p>
                    </div>
                  </div>

                  <RadioGroup
                    aria-label="窗口关闭行为"
                    className="grid w-full grid-cols-3 gap-1 rounded-md border border-border bg-background/70 p-1 text-xs sm:w-auto"
                    onValueChange={(value) => {
                      if (isClosePreference(value)) {
                        saveClosePreference(value);
                      }
                    }}
                    value={closePreference}
                  >
                    {closePreferenceOptions.map((option) => (
                      <label
                        className={cn(
                          "flex h-7 min-w-0 cursor-pointer items-center justify-center rounded-sm px-2.5 font-medium transition-colors focus-within:ring-2 focus-within:ring-ring/40",
                          closePreference === option.value
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                        key={option.value}
                      >
                        <RadioGroupItem className="sr-only" value={option.value} />
                        <span className="truncate">{option.label}</span>
                      </label>
                    ))}
                  </RadioGroup>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <TerminalSquare className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">终端设置</p>
                      <p className="text-xs text-muted-foreground">
                        {terminalSettings.useEmbeddedTerminal
                          ? `服务在应用内终端页运行，字号 ${terminalSettings.fontSize}px。`
                          : `服务在外部 Windows 终端窗口运行，内嵌字号 ${terminalSettings.fontSize}px。`}
                      </p>
                    </div>
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                    <label className="flex h-10 shrink-0 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm">
                      <Checkbox
                        checked={terminalSettings.useEmbeddedTerminal}
                        disabled={busy !== null}
                        onCheckedChange={(checked) =>
                          void saveTerminalSettings({ ...terminalSettings, useEmbeddedTerminal: checked === true })
                        }
                      />
                      使用内嵌终端
                    </label>
                    <label className="flex h-10 shrink-0 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm">
                      <span className="text-muted-foreground">字号</span>
                      <Input
                        className="h-8 w-20 font-mono text-sm"
                        inputMode="numeric"
                        max={22}
                        min={10}
                        onChange={(event) =>
                          void saveTerminalSettings({
                            ...terminalSettings,
                            fontSize: Number(event.target.value),
                          })
                        }
                        type="number"
                        value={terminalSettings.fontSize}
                      />
                      px
                    </label>
                  </div>
                </div>

                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Code2 className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">插件编写器</p>
                        <p className="text-xs text-muted-foreground">
                          {pluginBuilderEnabled
                            ? "顶部显示编写器入口，并使用内置 Coding Agent。"
                            : "顶部不显示编写器入口。"}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Badge variant={pluginBuilderEnabled ? "success" : "outline"}>
                        {pluginBuilderEnabled ? "已打开" : "已关闭"}
                      </Badge>
                      <Badge variant={openCodeSettings.useBundledPluginInstructions ? "secondary" : "outline"}>
                        {openCodeSettings.useBundledPluginInstructions ? "内置说明" : "项目默认"}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <label
                      className={cn(
                        "flex min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                        pluginBuilderEnabled
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      )}
                    >
                      <Checkbox
                        checked={pluginBuilderEnabled}
                        disabled={busy !== null}
                        onCheckedChange={(checked) => requestPluginBuilderEnabledChange(checked === true)}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">打开插件编写器</span>
                        <span className="mt-1 block text-xs leading-relaxed">
                          在顶部显示“编写器”入口，进入内置 Coding Agent 工作区。
                        </span>
                      </span>
                    </label>

                    <div className="grid gap-2 rounded-md border border-border bg-card p-3">
                      <label className="flex min-w-0 cursor-pointer items-start gap-3">
                        <Checkbox
                          checked={openCodeSettings.useBundledPluginInstructions}
                          disabled={busy !== null}
                          onCheckedChange={(checked) =>
                            void saveOpenCodeSettings({
                              ...openCodeSettings,
                              useBundledPluginInstructions: checked === true,
                            })
                          }
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">使用内置插件编写说明</span>
                          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                            {openCodeSettings.useBundledPluginInstructions
                              ? "启动 OpenCode 时使用内置 plugin_code.md，并跳过 MaiBot 自带 AGENTS.md。"
                              : "按 OpenCode 默认规则读取项目内 AGENTS.md。"}
                          </span>
                        </span>
                      </label>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p
                          className="min-w-[260px] flex-1 truncate rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground"
                          title={snapshot.paths.opencodePluginInstructionsPath}
                        >
                          {snapshot.paths.opencodePluginInstructionsPath}
                        </p>
                        {busy === "opencode-settings" ? (
                          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Network className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">网络代理</p>
                        <p className="text-xs text-muted-foreground">
                          对接 Clash 等本机代理，地址固定为 127.0.0.1。
                        </p>
                      </div>
                    </div>
                    <Badge variant={networkProxyDraft.enabled ? "success" : "outline"}>
                      {networkProxyDraft.enabled ? "已启用" : "未启用"}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="flex min-h-10 shrink-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
                      <Checkbox
                        checked={networkProxyDraft.enabled}
                        disabled={busy !== null}
                        onCheckedChange={(checked) =>
                          setNetworkProxyDraft((current) => ({ ...current, enabled: checked === true }))
                        }
                      />
                      启用本机代理
                    </label>
                    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                      端口
                      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
                        <span className="font-mono text-xs text-muted-foreground">127.0.0.1:</span>
                        <Input
                          className="h-8 w-24 font-mono text-sm"
                          disabled={busy !== null}
                          inputMode="numeric"
                          max={65535}
                          min={1}
                          onChange={(event) =>
                            setNetworkProxyDraft((current) => ({
                              ...current,
                              port: Number(event.target.value),
                            }))
                          }
                          type="number"
                          value={networkProxyDraft.port}
                        />
                      </div>
                    </label>
                    <p className="min-w-[220px] flex-1 pb-2 text-xs text-muted-foreground">
                      保存后影响启动器网络请求、Git / pip 更新，以及之后启动的托管服务。
                    </p>
                    <Button
                      disabled={
                        busy !== null ||
                        !networkProxyDirty ||
                        !Number.isInteger(networkProxyDraft.port) ||
                        networkProxyDraft.port < 1 ||
                        networkProxyDraft.port > 65535
                      }
                      onClick={() => void saveNetworkProxySettings()}
                      size="sm"
                    >
                      {busy === "network-proxy" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                      保存代理设置
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-destructive/10 text-destructive">
                        <Trash2 className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">重置 MaiBot 数据</p>
                        <p className="text-xs text-muted-foreground">
                          清空 MaiBot Core 的 data 目录，包括数据库、记忆、日志缓存等。该操作不可恢复。
                        </p>
                      </div>
                    </div>
                    <Button
                      disabled={busy !== null || maibotDataBlocked}
                      onClick={() => setConfirmMaiBotDataResetFirstOpen(true)}
                      size="sm"
                      variant="destructive"
                    >
                      <Trash2 className="size-4" />
                      重置数据
                    </Button>
                  </div>
                  {lastMaiBotDataReset ? (
                    <div className="rounded-md border border-warning/40 bg-warning/15 p-3 text-[12px] text-foreground">
                      <div className="flex items-center gap-1.5 font-medium">
                        <AlertTriangle className="size-3.5" />
                        最近一次重置
                      </div>
                      <dl className="mt-1.5 grid gap-0.5 text-muted-foreground">
                        <div className="flex gap-2">
                          <dt className="shrink-0">目录：</dt>
                          <dd className="break-all">{lastMaiBotDataReset.dataDir}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="shrink-0">移除项数：</dt>
                          <dd>{lastMaiBotDataReset.removedEntries.length}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="shrink-0">时间：</dt>
                          <dd>{formatTime(lastMaiBotDataReset.clearedAt)}</dd>
                        </div>
                      </dl>
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-destructive/10 text-destructive">
                      <RotateCcw className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">重置启动器</p>
                      <p className="text-xs text-muted-foreground">
                        清空设置会重走启动引导；完全还原会删除运行时资源目录。
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      disabled={busy !== null || resourceMoveBlocked}
                      onClick={() => setConfirmLauncherSettingsResetOpen(true)}
                      size="sm"
                      variant="outline"
                    >
                      <RotateCcw className="size-4" />
                      清空启动器设置
                    </Button>
                    <Button
                      disabled={busy !== null || resourceMoveBlocked}
                      onClick={() => setConfirmLauncherFullResetOpen(true)}
                      size="sm"
                      variant="destructive"
                    >
                      <Trash2 className="size-4" />
                      完全还原初始状态
                    </Button>
                  </div>
                </div>

                {environmentServicesPanel}

                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Code2 className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">MaiBot WebUI 本地构建</p>
                        <p className="text-xs text-muted-foreground">
                          {serviceStartupSettings.useLocalDashboard
                            ? "MaiBot Core 启动时使用 dashboard/dist。"
                            : "MaiBot Core 启动时使用已安装的 maibot-dashboard 包。"}
                        </p>
                      </div>
                    </div>
                    <Badge variant={serviceStartupSettings.useLocalDashboard ? "success" : "outline"}>
                      {serviceStartupSettings.useLocalDashboard ? "本地构建" : "安装包"}
                    </Badge>
                  </div>
                  <label
                    className={cn(
                      "flex min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                      serviceStartupSettings.useLocalDashboard
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    <Checkbox
                      checked={serviceStartupSettings.useLocalDashboard}
                      disabled={busy !== null}
                      onCheckedChange={(checked) =>
                        void saveServiceStartupSettings({
                          ...serviceStartupSettings,
                          useLocalDashboard: checked === true,
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">启动时使用本地 Dashboard 构建</span>
                      <span className="mt-1 block text-xs leading-relaxed">
                        开启后会向 MaiBot Core 注入 MAIBOT_WEBUI_USE_LOCAL_DASHBOARD=1，下次启动生效。
                      </span>
                    </span>
                    {busy === "service-startup-settings" ? (
                      <Loader2 className="ml-auto size-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : null}
                  </label>
                </div>
              </TabsContent>

              <TabsContent className="space-y-4" value="appearance">
                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <ImageIcon className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">应用图标</p>
                        <p className="text-xs text-muted-foreground">切换主窗口和托盘使用的图标。</p>
                      </div>
                    </div>
                    <Badge variant="secondary">
                      {appIconSettings.options.find((option) => option.id === appIconSettings.selectedIconId)?.label ?? "默认"}
                    </Badge>
                  </div>

                  <RadioGroup
                    className="grid gap-2 md:grid-cols-3"
                    disabled={busy !== null}
                    onValueChange={(value) => {
                      if (busy === null) {
                        void selectAppIcon(value as AppIconId);
                      }
                    }}
                    value={appIconSettings.selectedIconId}
                  >
                    {appIconSettings.options.map((option) => (
                      <label
                        className={cn(
                          "flex min-w-0 cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors",
                          appIconSettings.selectedIconId === option.id
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                          busy !== null && "cursor-not-allowed opacity-70",
                        )}
                        key={option.id}
                      >
                        <span className="grid size-14 shrink-0 place-items-center rounded-md border border-border bg-background">
                          {option.previewUrl ? (
                            <img alt="" className="size-12 rounded-md object-cover" draggable={false} src={option.previewUrl} />
                          ) : (
                            <ImageIcon className="size-5 text-muted-foreground" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{option.label}</span>
                          <span className="mt-1 block text-xs leading-relaxed">{option.description}</span>
                        </span>
                        <RadioGroupItem disabled={busy !== null} value={option.id} />
                      </label>
                    ))}
                  </RadioGroup>
                </div>

                <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <Palette className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">外观风格</p>
                      <p className="text-xs text-muted-foreground">选择整体视觉方向；每种风格有独立的配置项。</p>
                    </div>
                  </div>

                  <RadioGroup
                    className="grid gap-2 md:grid-cols-3"
                    onValueChange={(value) => appearance.setMode(value as AppearanceMode)}
                    value={appearance.mode}
                  >
                    {appearanceModeOptions.map((option) => (
                      <label
                        className={cn(
                          "flex min-w-0 cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors",
                          appearance.mode === option.value
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                        )}
                        key={option.value}
                      >
                        <RadioGroupItem className="mt-0.5" value={option.value} />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{option.label}</span>
                          <span className="mt-1 block text-xs leading-relaxed">{option.description}</span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </div>

                {appearance.mode === "future-retro" ? (
                  <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                          <Palette className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">未来复古配置</p>
                          <p className="text-xs text-muted-foreground">控制纸张纹理、仪表盘边角和界面密度。</p>
                        </div>
                      </div>
                      <label className="flex shrink-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
                        <Checkbox
                          checked={appearance.retroPaperTexture}
                          onCheckedChange={(checked) => appearance.setRetroPaperTexture(checked === true)}
                        />
                        纸张颗粒
                      </label>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <AppearanceRadiusControl appearance={appearance} />
                      <AppearanceScaleControl appearance={appearance} />
                    </div>
                  </div>
                ) : null}

                {appearance.mode === "modern" ? (
                  <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Palette className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">现代配置</p>
                        <p className="text-xs text-muted-foreground">控制主题色、字体、圆角和信息密度。</p>
                      </div>
                    </div>
                    <div className="grid gap-3 rounded-md border border-border bg-card p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">主题模式</p>
                          <p className="mt-1 text-xs text-muted-foreground">选择浅色、深色，或跟随系统外观。</p>
                        </div>
                        <Badge variant="secondary">{theme.resolved === "dark" ? "深色" : "浅色"}</Badge>
                      </div>

                      <RadioGroup
                        className="grid gap-2 md:grid-cols-3"
                        onValueChange={(value) => theme.setPreference(value as ThemePreference)}
                        value={theme.preference}
                      >
                        {themeOptions.map((option) => (
                          <label
                            className={cn(
                              "flex min-w-0 cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors",
                              theme.preference === option.value
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                            )}
                            key={option.value}
                          >
                            <RadioGroupItem className="mt-0.5" value={option.value} />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{option.label}</span>
                              <span className="mt-1 block text-xs leading-relaxed">{option.description}</span>
                            </span>
                          </label>
                        ))}
                      </RadioGroup>
                    </div>
                    <AppearanceAccentControl appearance={appearance} />
                    <div className="grid gap-3 md:grid-cols-2">
                      <AppearanceFontControl appearance={appearance} />
                      <AppearanceScaleControl appearance={appearance} />
                    </div>
                    <AppearanceRadiusControl appearance={appearance} />
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">外观设置</p>
                    <p className="mt-1 text-xs text-muted-foreground">调整会立即生效，并自动保存在本机浏览器存储中。</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button onClick={appearance.reset} size="sm" variant="secondary">
                      <RotateCcw className="size-4" />
                      恢复默认外观
                    </Button>
                  </div>
                </div>
              </TabsContent>

              <TabsContent className="space-y-4" value="account">
                <p className="text-xs text-muted-foreground">
                  选择当前使用的 QQ 后端。MaiBot Core 或 QQ 后端运行中不能切换。
                </p>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">QQ 后端</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {selectedQqBackendOption.description}
                    </p>
                  </div>
                  <RadioGroup
                    aria-label="QQ 后端"
                    className="grid w-full shrink-0 grid-cols-2 gap-1 rounded-md border border-border bg-card p-1 sm:w-[320px]"
                    onValueChange={(value) => setQqBackend(value as QqBackend)}
                    value={qqBackend}
                  >
                    {qqBackendOptions.map((option) => {
                      const selected = qqBackend === option.value;
                      const disabled = qqBackendSwitchBlocked && !selected;

                      return (
                        <label
                          className={cn(
                            "flex h-8 min-w-0 cursor-pointer items-center justify-center rounded-sm px-3 text-xs font-semibold transition-colors",
                            selected
                              ? "bg-primary text-primary-foreground shadow-sm"
                              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                            disabled && "cursor-not-allowed opacity-55 hover:bg-transparent hover:text-muted-foreground",
                          )}
                          key={option.value}
                        >
                          <RadioGroupItem className="sr-only" disabled={disabled} value={option.value} />
                          <span className="truncate">{option.label}</span>
                        </label>
                      );
                    })}
                  </RadioGroup>
                  <Button disabled={!canSaveQqBackend} onClick={saveQqBackend}>
                    {busy === "qq" ? <Loader2 className="animate-spin" /> : <Save />}
                    保存后端
                  </Button>
                </div>
                {qqBackendSwitchBlocked ? (
                  <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
                    MaiBot Core 或 QQ 后端运行中，暂不能切换 NapCat / SnowLuma。请先停止全部服务。
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">升级 NapCat / SnowLuma</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      使用当前一键包内置组件覆盖程序文件，保留配置、数据和日志。
                    </p>
                  </div>
                  <Button
                    disabled={busy !== null || qqBackendSwitchBlocked}
                    onClick={() => setConfirmQqComponentsUpgradeOpen(true)}
                    variant="secondary"
                  >
                    {busy === "qq-components:upgrade" ? <Loader2 className="animate-spin" /> : <Download />}
                    升级组件
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">重置 SnowLuma 组件</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      清空已安装的 SnowLuma 目录和配置，再从一键包内置模板复制一份新的。
                    </p>
                  </div>
                  <Button
                    disabled={busy !== null || qqBackendSwitchBlocked}
                    onClick={() => setConfirmSnowLumaResetOpen(true)}
                    variant="destructive"
                  >
                    {busy === "snowluma:reset" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    重置 SnowLuma
                  </Button>
                </div>
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

              <TabsContent className="space-y-3" value="data">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <Database className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">MaiBot 本地数据</p>
                      <p className="text-xs text-muted-foreground">
                        {storageStats
                          ? `共 ${formatBytes(storageStats.totalSizeBytes)}，扫描于 ${formatDateTime(storageStats.scannedAt)}。`
                          : "统计 data、logs 与常见缓存目录。"}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {storageStats ? (
                      <Button onClick={() => openPath(storageStats.dataDir)} size="sm" variant="outline">
                        <FolderOpen className="size-4" />
                        打开 data
                      </Button>
                    ) : null}
                    <Button disabled={storageStatsLoading} onClick={() => void refreshStorageStats()} size="sm" variant="secondary">
                      {storageStatsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      重新扫描
                    </Button>
                  </div>
                </div>

                {maibotDataBlocked ? (
                  <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
                    MaiBot Core 正在运行或启动中，暂不能清理本地数据。统计和打开目录仍可使用。
                  </div>
                ) : null}

                {storageStatsLoading && !storageStats ? (
                  <div className="rounded-lg border border-border bg-card px-3 py-8 text-center text-xs text-muted-foreground">
                    正在扫描本地数据...
                  </div>
                ) : null}

                {storageStats ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {storageStats.categories.map((category) => (
                      <StorageCategoryItem
                        busy={busy === `storage:cleanup:${category.cleanupTarget ?? ""}`}
                        category={category}
                        cleanupBlocked={maibotDataBlocked || busy !== null}
                        key={category.key}
                        onCleanup={setConfirmStorageCleanupTarget}
                        onOpenPath={openPath}
                      />
                    ))}
                  </div>
                ) : null}

                <div className="grid gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-destructive/10 text-destructive">
                        <Trash2 className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">彻底重置 data 目录</p>
                        <p className="text-xs text-muted-foreground">
                          清空数据库、记忆、WebUI 偏好和所有 data 内容。该操作不可恢复。
                        </p>
                      </div>
                    </div>
                    <Button
                      disabled={busy !== null || maibotDataBlocked}
                      onClick={() => setConfirmMaiBotDataResetFirstOpen(true)}
                      size="sm"
                      variant="destructive"
                    >
                      <Trash2 className="size-4" />
                      重置 data
                    </Button>
                  </div>
                  {lastMaiBotDataReset ? (
                    <div className="rounded-md border border-warning/40 bg-warning/15 p-3 text-[12px] text-foreground">
                      最近一次重置移除 {lastMaiBotDataReset.removedEntries.length} 项，
                      时间 {formatTime(lastMaiBotDataReset.clearedAt)}
                    </div>
                  ) : null}
                </div>
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
      open={confirmPluginBuilderEnableOpen}
      onOpenChange={(next) => {
        if (!next) setConfirmPluginBuilderEnableOpen(false);
      }}
    >
      <DialogContent size="md">
        <DialogHeader
          description="OpenCode 这类 AI Agent CLI 会在 MaiBot 工作目录中运行，并可能读取、创建、修改文件或执行命令。"
          icon={<AlertTriangle className="size-4" />}
          title="确认打开插件编写器？"
          tone="warning"
        />
        <DialogBody className="space-y-3 text-sm">
          <div className="rounded-md border border-warning/40 bg-warning/15 p-3 text-xs leading-relaxed text-warning-foreground">
            只在你信任当前工作区、理解操作影响，并准备好查看 AI Agent 执行内容时打开。建议避免输入敏感密钥、账号密码或私人文件路径。
          </div>
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            该设置只会显示编写器入口；真正启动 OpenCode 后，终端会切到对应会话，你仍需要关注它的命令输出和文件改动。
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setConfirmPluginBuilderEnableOpen(false)} size="sm" variant="ghost">
            取消
          </Button>
          <Button onClick={confirmPluginBuilderEnable} size="sm" variant="default">
            我已了解，打开
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
      <Dialog
        open={confirmStorageCleanupTarget !== null}
        onOpenChange={(next) => {
          if (!next && !busy?.startsWith("storage:cleanup:")) setConfirmStorageCleanupTarget(null);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader
            description="只会删除所选类别中的缓存或日志文件，不会清理数据库和记忆目录。"
            icon={<Trash2 className="size-4" />}
            title={confirmStorageCleanupTarget ? `${storageCleanupLabel[confirmStorageCleanupTarget]}？` : "清理本地数据？"}
            tone="warning"
          />
          <DialogBody>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              建议确认 MaiBot Core 已停止。清理后相关缓存可能会在下次使用时重新生成。
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={busy?.startsWith("storage:cleanup:") === true}
              onClick={() => setConfirmStorageCleanupTarget(null)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={busy?.startsWith("storage:cleanup:") === true || maibotDataBlocked}
              onClick={cleanupMaiBotStorage}
              size="sm"
              variant="destructive"
            >
              {busy?.startsWith("storage:cleanup:") === true ? <Loader2 className="animate-spin" /> : <Trash2 />}
              确认清理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmMaiBotDataResetFirstOpen}
        onOpenChange={(next) => {
          if (!next && busy !== "maibot:data-reset") setConfirmMaiBotDataResetFirstOpen(false);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader
            description="此操作会清空 MaiBot Core 的 data 目录，包括数据库、记忆等运行时数据。"
            icon={<AlertTriangle className="size-4" />}
            title="确认重置 MaiBot 数据？"
            tone="warning"
          />
          <DialogBody>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              重置后无法恢复，建议先手动备份 data 目录。继续将进入二次确认。
            </p>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setConfirmMaiBotDataResetFirstOpen(false)} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              onClick={() => {
                setConfirmMaiBotDataResetFirstOpen(false);
                setConfirmMaiBotDataResetSecondOpen(true);
              }}
              size="sm"
              variant="destructive"
            >
              我已了解，下一步
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmMaiBotDataResetSecondOpen}
        onOpenChange={(next) => {
          if (!next && busy !== "maibot:data-reset") setConfirmMaiBotDataResetSecondOpen(false);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader
            description="所有 MaiBot 运行时数据将被永久删除。此操作不可撤销。"
            icon={<Trash2 className="size-4" />}
            title="再次确认：彻底清空 data 目录"
            tone="danger"
          />
          <DialogBody>
            <p className="text-[13px] leading-relaxed text-foreground">
              真的要继续吗？请确认 MaiBot Core 已停止，且不再需要这些数据。
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={busy === "maibot:data-reset"}
              onClick={() => setConfirmMaiBotDataResetSecondOpen(false)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button
              disabled={busy === "maibot:data-reset"}
              onClick={resetMaiBotData}
              size="sm"
              variant="destructive"
            >
              {busy === "maibot:data-reset" ? <Loader2 className="animate-spin" /> : <Trash2 />}
              确认清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmLauncherSettingsResetOpen}
        onOpenChange={(next) => {
          if (!next && busy !== "launcher:reset-settings") setConfirmLauncherSettingsResetOpen(false);
      }}
    >
      <DialogContent size="md">
      <DialogHeader
        description="这只会清空启动器自己的设置，并让启动引导重新出现；MaiBot、NapCat、SnowLuma 与 Python 覆盖依赖目录会保留。"
        icon={<RotateCcw className="size-4" />}
        title="清空启动器设置？"
        tone="warning"
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          会重置关闭行为、服务命令、运行时工具路径、依赖源、首页更新源、资源路径选择和 QQ 后端选择。完成后界面会刷新并重新进入启动引导。
        </div>
        {resourceMoveBlocked ? (
          <div className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
            当前仍有服务运行，请先停止全部服务。
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button disabled={busy === "launcher:reset-settings"} onClick={() => setConfirmLauncherSettingsResetOpen(false)} size="sm" variant="ghost">
          取消
        </Button>
        <Button
          disabled={busy === "launcher:reset-settings" || resourceMoveBlocked}
          onClick={resetLauncherSettings}
          size="sm"
          variant="destructive"
        >
          {busy === "launcher:reset-settings" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          确认清空
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog
      open={confirmLauncherFullResetOpen}
      onOpenChange={(next) => {
        if (!next && busy !== "launcher:reset-all") setConfirmLauncherFullResetOpen(false);
      }}
    >
      <DialogContent size="md">
      <DialogHeader
        description="这会删除当前运行时资源目录，相当于回到新安装后的初始状态。"
        icon={<Trash2 className="size-4" />}
        title="完全还原初始状态？"
        tone="danger"
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
          MaiBot、NapCat、SnowLuma、Python 覆盖依赖、日志和启动器设置都会被清空。该操作不可撤销。
        </div>
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          运行时资源目录：<code className="rounded bg-card px-1 py-0.5 font-mono">{snapshot.paths.defaultResourceRoot}</code>
        </div>
        {resourceMoveBlocked ? (
          <div className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
            当前仍有服务运行，请先停止全部服务。
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button disabled={busy === "launcher:reset-all"} onClick={() => setConfirmLauncherFullResetOpen(false)} size="sm" variant="ghost">
          取消
        </Button>
        <Button
          disabled={busy === "launcher:reset-all" || resourceMoveBlocked}
          onClick={resetLauncherAll}
          size="sm"
          variant="destructive"
        >
          {busy === "launcher:reset-all" ? <Loader2 className="animate-spin" /> : <Trash2 />}
          确认还原
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog
      open={confirmQqComponentsUpgradeOpen}
      onOpenChange={(next) => {
        if (!next && busy !== "qq-components:upgrade") setConfirmQqComponentsUpgradeOpen(false);
      }}
    >
      <DialogContent size="md">
      <DialogHeader
        description="这会用一键包内置的 NapCat 与 SnowLuma 程序文件覆盖现有组件。"
        icon={<Download className="size-4" />}
        title="确认升级组件？"
        tone="warning"
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          配置、数据和日志会被保留；执行前请确认 MaiBot Core 与 QQ 后端都已停止。
        </div>
        {qqBackendSwitchBlocked ? (
          <div className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
            MaiBot Core 或 QQ 后端仍在运行，请先停止全部服务。
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button disabled={busy === "qq-components:upgrade"} onClick={() => setConfirmQqComponentsUpgradeOpen(false)} size="sm" variant="ghost">
          取消
        </Button>
        <Button
          disabled={busy === "qq-components:upgrade" || qqBackendSwitchBlocked}
          onClick={upgradeQqComponents}
          size="sm"
          variant="secondary"
        >
          {busy === "qq-components:upgrade" ? <Loader2 className="animate-spin" /> : <Download />}
          升级组件
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog
      open={confirmSnowLumaResetOpen}
      onOpenChange={(next) => {
        if (!next && busy !== "snowluma:reset") setConfirmSnowLumaResetOpen(false);
      }}
    >
      <DialogContent size="md">
      <DialogHeader
        description="这会删除当前 SnowLuma 目录，包括配置、数据与日志，并从一键包内置模板重新复制。"
        icon={<RotateCcw className="size-4" />}
        title="确认重置 SnowLuma？"
        tone="warning"
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
          该操作不会保留 SnowLuma 的登录、连接和适配器运行配置。执行前请确认 MaiBot Core 与 QQ 后端都已停止。
        </div>
        {qqBackendSwitchBlocked ? (
          <div className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
            MaiBot Core 或 QQ 后端仍在运行，请先停止全部服务。
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button disabled={busy === "snowluma:reset"} onClick={() => setConfirmSnowLumaResetOpen(false)} size="sm" variant="ghost">
          取消
        </Button>
        <Button
          disabled={busy === "snowluma:reset" || qqBackendSwitchBlocked}
          onClick={resetSnowLumaComponent}
          size="sm"
          variant="destructive"
        >
          {busy === "snowluma:reset" ? <Loader2 className="animate-spin" /> : <Trash2 />}
          清空并重置
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
