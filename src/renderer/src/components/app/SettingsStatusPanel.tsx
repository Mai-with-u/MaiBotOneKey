import { getDesktopSnapshot } from "@/lib/desktop-api";
import { MaiBotConfigImportPanel } from "./MaiBotConfigImportPanel";
import { ResourcePathEditor } from "./ResourcePathEditor";
import { useResourcePathWorkflow } from "./ResourcePathWorkflow";
import {
  AlertTriangle,
  ChevronDown,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Code2,
  Download,
  FolderOpen,
  GripVertical,
  HardDrive,
  ImageIcon,
  Loader2,
  Network,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Smartphone,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsSection } from "@/components/ui/surface";
import type {
  DesktopSnapshot,
  AppIconId,
  InitCheckStatus,
  LogEntry,
  MaiBotDataResetResult,
  LauncherUiSettings,
  NetworkProxySettings,
  ServiceCommandConfig,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceHealth,
  ServiceStatus,
  ManagedSourceEntry,
  SourceSettings,
  SourceSettingsGroup,
  TerminalSettings,
} from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import maiMascotImage from "@/assets/mai2.png";
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
  usesRetroStructure,
  type AccentColor,
  type AppearanceApi,
  type AppearanceMode,
  type FontFamily,
  type InterfaceScale,
} from "@/lib/use-appearance";
import { useTheme, type ThemePreference } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import { settingsLogMessage, settingsLogs } from "@/lib/settings-logs";

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

const sourceGroupMeta: Record<SourceSettingsGroup, { title: string; description: string; urlLabel: string }> = {
  python: {
    title: "Python 包源",
    description: "用于 MaiBot、Dashboard 和依赖的版本查询及安装；列表顺序也是失败后的重试顺序。",
    urlLabel: "Simple 索引地址",
  },
};

function cloneSourceSettings(settings: SourceSettings): SourceSettings {
  return {
    python: settings.python.map((entry) => ({ ...entry })),
  };
}

function createSourceEntry(group: SourceSettingsGroup): ManagedSourceEntry {
  const timestamp = Date.now().toString(36);
  return {
    id: `${group}-${timestamp}`,
    label: "自定义源",
    url: "",
  };
}

function normalizeSourceEntryId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

function SourceGroupEditor({
  disabled,
  entries,
  group,
  onChange,
}: {
  disabled: boolean;
  entries: ManagedSourceEntry[];
  group: SourceSettingsGroup;
  onChange: (entries: ManagedSourceEntry[]) => void;
}): React.JSX.Element {
  const meta = sourceGroupMeta[group];
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const updateEntry = (index: number, patch: Partial<ManagedSourceEntry>): void => {
    onChange(entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry));
  };
  const reorderEntry = (fromIndex: number, toIndex: number): void => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= entries.length || toIndex >= entries.length) {
      return;
    }
    const nextEntries = [...entries];
    const [entry] = nextEntries.splice(fromIndex, 1);
    nextEntries.splice(toIndex, 0, entry);
    onChange(nextEntries);
  };

  return (
      <div className="settings-option-list grid gap-0">
        {entries.map((entry, index) => (
          <div
            className={cn(
              "settings-choice grid gap-2 bg-background p-2 transition-colors md:items-end",
              group === "python"
                ? "md:grid-cols-[auto_minmax(120px,0.8fr)_minmax(220px,1.4fr)_minmax(120px,0.7fr)_minmax(130px,0.7fr)_auto]"
                : "md:grid-cols-[auto_minmax(140px,0.8fr)_minmax(260px,1.5fr)_minmax(130px,0.7fr)_auto]",
              draggingIndex === index && "settings-choice-selected bg-primary/5",
            )}
            key={`${entry.id}-${index}`}
            onDragOver={(event) => {
              if (disabled || draggingIndex === null || draggingIndex === index) {
                return;
              }
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!disabled && draggingIndex !== null) {
                reorderEntry(draggingIndex, index);
              }
              setDraggingIndex(null);
            }}
          >
            <button
              aria-label={`拖动排序 ${entry.label || entry.id || index + 1}`}
              className="flex h-8 w-7 cursor-grab items-center justify-center self-end rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled || entries.length <= 1}
              draggable={!disabled && entries.length > 1}
              onDragEnd={() => setDraggingIndex(null)}
              onDragStart={(event) => {
                setDraggingIndex(index);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
              }}
              title="拖动排序"
              type="button"
            >
              <GripVertical className="size-4" />
            </button>
            <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
              源名称
              <Input
                className="h-8 text-sm text-foreground"
                disabled={disabled}
                onChange={(event) => updateEntry(index, { label: event.target.value })}
                placeholder="源名称"
                value={entry.label}
              />
            </label>
            <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
              {meta.urlLabel}
              <Input
                className="h-8 font-mono text-xs text-foreground"
                disabled={disabled}
                onChange={(event) => updateEntry(index, { url: event.target.value })}
                placeholder="https://..."
                value={entry.url}
              />
            </label>
            <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
              ID
              <Input
                className="h-8 font-mono text-xs text-foreground"
                disabled={disabled}
                onChange={(event) => updateEntry(index, { id: normalizeSourceEntryId(event.target.value) })}
                placeholder="source-id"
                value={entry.id}
              />
            </label>
            {group === "python" ? (
              <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
                trusted-host
                <Input
                  className="h-8 font-mono text-xs text-foreground"
                  disabled={disabled}
                  onChange={(event) => updateEntry(index, { trustedHost: event.target.value })}
                  placeholder="可选"
                  value={entry.trustedHost ?? ""}
                />
              </label>
            ) : null}
            <Button
              className="size-8 self-end"
              disabled={disabled || entries.length <= 1}
              onClick={() => onChange(entries.filter((_, entryIndex) => entryIndex !== index))}
              size="icon"
              variant="ghost"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
  );
}

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

const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
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
  { value: "normal", label: "适中", description: "字号稍小，显示更多内容。" },
  { value: "comfortable", label: "标准", description: "默认界面密度，字号更大，留白更多。" },
];

const appearanceModeOptions: Array<{ value: AppearanceMode; label: string }> = [
  { value: "future-retro", label: "未来复古" },
  { value: "millennium", label: "千禧" },
  { value: "modern", label: "现代" },
];

const defaultNetworkProxySettings: NetworkProxySettings = {
  enabled: false,
  port: 7890,
};

const defaultLauncherUiSettings: LauncherUiSettings = {
  floatingMascotMode: "maibot",
  topStartActionMode: "ask",
};
const CODEX_PET_PREVIEW_COLUMNS = 8;
const CODEX_PET_PREVIEW_ROWS = 9;
const CODEX_PET_PREVIEW_WIDTH = 38;
const CODEX_PET_PREVIEW_HEIGHT = 42;

const STARTUP_WIZARD_STORAGE_KEY = "maibot-startup-wizard-seen";
const DEVELOPER_MODE_STORAGE_KEY = "maibot-developer-mode-enabled";

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CodexPetPreview({ url, label }: { url: string; label: string }): React.JSX.Element {
  return (
    <span
      aria-label={label}
      className="codex-pet-sprite block shrink-0 overflow-hidden"
      role="img"
      style={{
        "--codex-pet-frame-width": `${CODEX_PET_PREVIEW_WIDTH}px`,
        width: CODEX_PET_PREVIEW_WIDTH,
        height: CODEX_PET_PREVIEW_HEIGHT,
      } as CSSProperties}
    >
      <img
        alt=""
        className="codex-pet-sprite-frame block h-full max-w-none select-none"
        draggable={false}
        src={url}
        style={{
          width: CODEX_PET_PREVIEW_WIDTH * CODEX_PET_PREVIEW_COLUMNS,
          height: CODEX_PET_PREVIEW_HEIGHT * CODEX_PET_PREVIEW_ROWS,
        }}
      />
    </span>
  );
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

function AppearanceAccentControl({ appearance }: { appearance: AppearanceApi }): React.JSX.Element {
  return (
    <SettingsSection className="grid gap-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">主题色</p>
        <p className="mt-1 text-xs text-muted-foreground">用于按钮、重点数字和选中状态。</p>
      </div>
      <div className="settings-option-list settings-option-cols-5 grid gap-0 sm:grid-cols-5">
        {accentOptions.map((option) => (
          <button
            aria-pressed={appearance.accent === option.value}
            className={cn(
              "settings-choice flex min-w-0 items-center gap-2 px-2.5 py-2 text-left text-sm transition-colors",
              appearance.accent === option.value
                ? "settings-choice-selected bg-primary/10 text-foreground"
                : "bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
    </SettingsSection>
  );
}

function AppearanceFontControl({ appearance }: { appearance: AppearanceApi }): React.JSX.Element {
  return (
    <SettingsSection className="grid gap-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">字体</p>
        <p className="mt-1 text-xs text-muted-foreground">调整界面文字的整体气质。</p>
      </div>
      <RadioGroup
        className="settings-option-list grid gap-0"
        onValueChange={(value) => appearance.setFont(value as FontFamily)}
        value={appearance.font}
      >
        {fontOptions.map((option) => (
          <label
            className={cn(
              "settings-choice flex cursor-pointer items-start gap-2 px-2.5 py-2 transition-colors",
              appearance.font === option.value
                ? "settings-choice-selected bg-primary/10 text-foreground"
                : "bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
    </SettingsSection>
  );
}

function AppearanceScaleControl({ appearance }: { appearance: AppearanceApi }): React.JSX.Element {
  return (
    <SettingsSection className="grid gap-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">界面密度</p>
        <p className="mt-1 text-xs text-muted-foreground">控制字号和控件间距。</p>
      </div>
      <RadioGroup
        className="settings-option-list grid gap-0"
        onValueChange={(value) => appearance.setScale(value as InterfaceScale)}
        value={appearance.scale}
      >
        {scaleOptions.map((option) => (
          <label
            className={cn(
              "settings-choice flex cursor-pointer items-start gap-2 px-2.5 py-2 transition-colors",
              appearance.scale === option.value
                ? "settings-choice-selected bg-primary/10 text-foreground"
                : "bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
    </SettingsSection>
  );
}

function AppearanceRadiusControl({ appearance }: { appearance: AppearanceApi }): React.JSX.Element {
  const windowCornerRadiusMin = usesRetroStructure(appearance.mode)
    ? RETRO_WINDOW_CORNER_RADIUS_MIN
    : WINDOW_CORNER_RADIUS_MIN;

  return (
    <SettingsSection asChild>
    <label className="grid gap-2">
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
    </SettingsSection>
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
  const [commandLine, setCommandLine] = useState(commandConfig?.commandLine ?? service.command?.[0] ?? "");

  useEffect(() => {
    setCommandLine(commandConfig?.commandLine ?? service.command?.[0] ?? "");
  }, [commandConfig?.commandLine, commandConfig?.cwd, service.command, service.cwd]);

  const configDirty = Boolean(
    commandConfig && commandLine.trim() !== commandConfig.commandLine,
  );

  return (
    <div className="border-t border-border pt-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge dot variant={statusVariant[service.status]}>
              {statusText[service.status]}
            </Badge>
            <Badge variant={service.health === "ready" ? "success" : service.health === "conflict" ? "danger" : "secondary"}>
              {healthText[service.health]}
            </Badge>
          </div>
          <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-muted-foreground" title={service.url}>
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
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-4">
        {[
          ["监听端口", service.ports.join(" / ") || "未记录"],
          ["最近启动", formatTime(service.startedAt)],
          ["最近停止", formatTime(service.stoppedAt)],
          ["重启次数", String(service.restartAttempts ?? 0)],
        ].map(([label, value]) => (
          <div className="flex min-w-0 items-baseline gap-2" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words font-mono text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {service.command && !commandConfig ? (
        <code className="mt-3 block overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-foreground/75">
          {service.command.join(" ")}
        </code>
      ) : null}
      {commandConfig ? (
        <div className="mt-3 grid gap-2 border-t border-border pt-3">
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
            aria-label={`${service.name} 启动命令`} className="h-8"
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
  const message = settingsLogMessage(entry.message);
  return (
    <div className="grid min-w-0 grid-cols-[74px_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border px-3 py-2 font-mono text-[11px] last:border-b-0 sm:grid-cols-[74px_max-content_minmax(0,1fr)]">
      <span className="whitespace-nowrap text-muted-foreground">{formatTime(entry.timestamp)}</span>
      <span
        className={
          entry.stream === "stderr"
            ? "text-destructive"
            : entry.stream === "system"
              ? "text-primary"
              : "text-foreground/80"
        }
      >
        <span className="whitespace-nowrap">{entry.source}/{entry.stream}</span>
      </span>
      <span className="col-span-2 min-w-0 whitespace-pre-wrap break-words text-foreground/80 [overflow-wrap:anywhere] sm:col-span-1" title={message}>
        {message}
      </span>
    </div>
  );
}

export function SettingsStatusPanel({
  snapshot,
  onSnapshot,
}: SettingsStatusPanelProps): React.JSX.Element {
  const theme = useTheme();
  const appearance = useAppearance();
  const [busy, setBusy] = useState<string | null>(null);
  const [miniMode, setMiniMode] = useState(false);
  useEffect(() => {
    const bridge = window.maibotDesktop?.window;
    if (!bridge) return;
    let mounted = true;
    const sync = (state: { isMiniMode?: boolean }) => {
      if (mounted && typeof state.isMiniMode === "boolean") setMiniMode(state.isMiniMode);
    };
    void bridge.getState().then(sync).catch(() => undefined);
    const off = bridge.onState(sync);
    return () => { mounted = false; off(); };
  }, []);

  const toggleMiniMode = async () => {
    const bridge = window.maibotDesktop?.window;
    if (!bridge) return;
    setBusy("mini-mode");
    setError(null);
    try {
      const state = await bridge.setMiniMode(!miniMode);
      setMiniMode(state.isMiniMode === true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [activeSettingsTab, setActiveSettingsTab] = useState("general");
  const [developerModeEnabled, setDeveloperModeEnabled] = useState(
    () => localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY) === "true",
  );
  const [confirmLauncherSettingsResetOpen, setConfirmLauncherSettingsResetOpen] = useState(false);
  const [confirmLauncherFullResetOpen, setConfirmLauncherFullResetOpen] = useState(false);
  const [confirmMaiBotDataResetFirstOpen, setConfirmMaiBotDataResetFirstOpen] = useState(false);
  const [confirmMaiBotDataResetSecondOpen, setConfirmMaiBotDataResetSecondOpen] = useState(false);
  const [environmentServicesExpanded, setEnvironmentServicesExpanded] = useState(false);
  const [lastMaiBotDataReset, setLastMaiBotDataReset] = useState<MaiBotDataResetResult | null>(null);
  const initState = snapshot.initState ?? {
    isReady: false,
    qqBackend: "napcat",
    messagePlatformConfigured: false,
    checks: [],
  };
  const services = snapshot.services ?? [];
  const maibotService = services.find((service) => service.id === "maibot");
  const serviceCommands = snapshot.serviceCommands ?? [];
  const runtimeResourcePathConfigs = snapshot.runtimeResourcePathConfigs ?? [];
  const editableRuntimeResourcePathConfigs = runtimeResourcePathConfigs;
  const terminalSettings = snapshot.terminalSettings ?? { useEmbeddedTerminal: true, fontSize: 12 };
  const serviceStartupSettings = snapshot.serviceStartupSettings ?? { useLocalDashboard: false };
  const launcherUiSettings = { ...defaultLauncherUiSettings, ...snapshot.launcherUiSettings };
  const appIconSettings = snapshot.appIconSettings ?? { selectedIconId: "sprout" as AppIconId, options: [] };
  const codexPetOptions = snapshot.codexPetSettings?.options ?? [];
  const selectedCodexPet =
    codexPetOptions.find((option) => option.id === launcherUiSettings.floatingCodexPetId) ?? codexPetOptions[0];
  const networkProxySettings = snapshot.networkProxySettings ?? defaultNetworkProxySettings;
  const [networkProxyDraft, setNetworkProxyDraft] = useState<NetworkProxySettings>(networkProxySettings);
  const [sourceSettings, setSourceSettings] = useState<SourceSettings | null>(null);
  const [sourceSettingsDraft, setSourceSettingsDraft] = useState<SourceSettings | null>(null);
  const [closePreference, setClosePreferenceState] = useState<ClosePreference>(() => getClosePreference());
  const environmentServicesContentId = useId();
  const recentLogEntries = snapshot.recentLogs ?? [];
  const resourceMoveBlocked = Boolean(snapshot.runtimeOperation) || services.some(
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
  const networkProxyDirty =
    networkProxyDraft.enabled !== networkProxySettings.enabled ||
    networkProxyDraft.port !== networkProxySettings.port;
  const sourceSettingsDirty = Boolean(
    sourceSettings &&
    sourceSettingsDraft &&
    JSON.stringify(sourceSettingsDraft) !== JSON.stringify(sourceSettings),
  );
  useEffect(() => {
    setNetworkProxyDraft(networkProxySettings);
  }, [networkProxySettings.enabled, networkProxySettings.port]);

  const loadSourceSettings = useCallback(async () => {
    const settings = await window.maibotDesktop?.launcher.getSourceSettings();
    if (settings) {
      setSourceSettings(settings);
      setSourceSettingsDraft(cloneSourceSettings(settings));
    }
  }, []);

  useEffect(() => {
    void loadSourceSettings().catch((nextError: unknown) => setError(messageFromError(nextError)));
  }, [loadSourceSettings]);

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

  const attentionChecks = useMemo(
    () => initState.checks.filter((check) => check.status !== "ok"),
    [initState.checks],
  );
  const recentLogs = useMemo(() => settingsLogs(recentLogEntries), [recentLogEntries]);

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await getDesktopSnapshot();
    onSnapshot(nextSnapshot);
  }, [onSnapshot]);

  const openPath = useCallback((path: string) => {
    void window.maibotDesktop?.openPath(path);
  }, []);

  const updateDeveloperMode = useCallback((enabled: boolean) => {
    localStorage.setItem(DEVELOPER_MODE_STORAGE_KEY, String(enabled));
    setDeveloperModeEnabled(enabled);
    if (!enabled) {
      setActiveSettingsTab("general");
    }
  }, []);

  const openExternal = useCallback((url: string) => {
    void window.maibotDesktop?.openExternal(url);
  }, []);

  const saveClosePreference = useCallback((preference: ClosePreference) => {
    setClosePreference(preference);
    setClosePreferenceState(preference);
    toast.success(`关闭行为已设为：${closePreferenceText[preference]}`);
  }, []);

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
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

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

  const saveSourceSettings = useCallback(async () => {
    if (!sourceSettingsDraft) {
      return;
    }
    setBusy("source-settings");
    setError(null);
    try {
      const result = await window.maibotDesktop?.launcher.saveSourceSettings(sourceSettingsDraft);
      if (result) {
        setSourceSettings(result);
        setSourceSettingsDraft(cloneSourceSettings(result));
        toast.success("Python 包源已保存");
      }
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [sourceSettingsDraft]);

  const resetSourceSettingsDraft = useCallback(() => {
    if (sourceSettings) {
      setSourceSettingsDraft(cloneSourceSettings(sourceSettings));
    }
  }, [sourceSettings]);

  const restoreDefaultSourceSettings = useCallback(async () => {
    setBusy("source-settings");
    setError(null);
    try {
      const result = await window.maibotDesktop?.launcher.resetSourceSettings();
      if (result) {
        setSourceSettings(result);
        setSourceSettingsDraft(cloneSourceSettings(result));
        toast.success("Python 包源已恢复默认");
      }
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, []);

  const updateSourceGroup = useCallback((group: SourceSettingsGroup, entries: ManagedSourceEntry[]) => {
    setSourceSettingsDraft((current) => current ? { ...current, [group]: entries } : current);
  }, []);

  const saveLauncherUiSettings = useCallback(
    async (settings: LauncherUiSettings) => {
      setBusy("launcher-ui-settings");
      setError(null);
      try {
        const nextLauncherUiSettings = await window.maibotDesktop?.launcher.saveUiSettings(settings);
        if (nextLauncherUiSettings) {
          onSnapshot({ ...snapshot, launcherUiSettings: nextLauncherUiSettings });
          toast.success("界面设置已保存");
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

  const resourceWorkflow = useResourcePathWorkflow(refreshSnapshot);

  const environmentServicesPanel = (
    <>
      <Button
        aria-controls={environmentServicesContentId}
        aria-expanded={environmentServicesExpanded}
        className="!h-auto w-full justify-between gap-3 whitespace-normal rounded-lg border-border bg-muted/40 px-3 !py-4 text-left"
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
              {environmentServicesExpanded ? "收起环境检查" : "展开环境检查"}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {attentionChecks.length > 0 ? `${attentionChecks.length} 项待处理` : "环境检查正常"}
            </span>
          </span>
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 transition-transform", environmentServicesExpanded && "rotate-180")}
        />
      </Button>

      {environmentServicesExpanded ? (
        <div className="space-y-4" id={environmentServicesContentId}>
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

        </div>
      ) : null}
    </>
  );

  return (
    <>
    <section
      className={cn(
        "h-full px-6 py-3",
        activeSettingsTab === "logs" ? "flex min-h-0 flex-col overflow-hidden" : "overflow-auto",
        usesRetroStructure(appearance.mode) ? "bg-transparent" : "bg-background",
      )}
    >
      <div className={cn("mx-auto w-full max-w-[1180px]", activeSettingsTab === "logs" && "flex min-h-0 flex-1 flex-col")}>
        <Card className={cn("border-0 bg-transparent", activeSettingsTab === "logs" && "flex min-h-0 flex-1 flex-col")}>
          <CardContent className={cn("p-0", activeSettingsTab === "logs" ? "flex min-h-0 flex-1 flex-col gap-4" : "space-y-4")}>
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
                {error}
              </div>
            ) : null}

            <Tabs
              className={activeSettingsTab === "logs" ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"}
              onValueChange={setActiveSettingsTab}
              value={activeSettingsTab}
            >
              <TabsList className="settings-negative-tabs flex h-auto shrink-0 flex-wrap">
                <TabsTrigger className="gap-1.5 px-3 text-[11px]" value="general">
                  <Settings className="size-3" />
                  通用
                </TabsTrigger>
                <TabsTrigger className="gap-1.5 px-3 text-[11px]" value="appearance">
                  <Palette className="size-3" />
                  外观
                </TabsTrigger>
                <TabsTrigger className="gap-1.5 px-3 text-[11px]" value="paths">
                  <ShieldCheck className="size-3" />
                  实例管理
                </TabsTrigger>
                {developerModeEnabled ? (
                  <TabsTrigger className="gap-1.5 px-3 text-[11px]" value="debug">
                    <Wrench className="size-3" />
                    调试
                  </TabsTrigger>
                ) : null}
                <TabsTrigger className="gap-1.5 px-3 text-[11px]" value="logs">
                  <HardDrive className="size-3" />
                  运行日志
                </TabsTrigger>
              </TabsList>

              <TabsContent className="settings-content" value="general">
                <div className="settings-pair-grid">
                <SettingsSection className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <Settings className="size-4" />
                    </span>
                    <p className="min-w-0 text-sm font-medium">窗口关闭</p>
                  </div>

                  <SegmentedControl
                    aria-label="窗口关闭行为"
                    className="w-full sm:w-auto"
                    value={closePreference}
                    onValueChange={saveClosePreference}
                    options={closePreferenceOptions}
                  />
                </SettingsSection>

                <SettingsSection className="flex flex-wrap items-center justify-between gap-3">
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
                </SettingsSection>
                </div>

                <SettingsSection className="grid gap-3" data-tone="danger">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-destructive/10 text-destructive">
                        <Trash2 className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">重置数据</p>
                        <p className="text-xs text-muted-foreground">
                          可重置启动器设置、MaiBot 数据或所有数据。重置所有数据会删除运行时资源目录，数据删除不可恢复。
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button disabled={busy !== null || resourceMoveBlocked} onClick={() => setConfirmLauncherSettingsResetOpen(true)} size="sm" variant="outline">
                        <RotateCcw className="size-4" />
                        重置启动器设置
                      </Button>
                      <Button disabled={busy !== null || maibotDataBlocked} onClick={() => setConfirmMaiBotDataResetFirstOpen(true)} size="sm" variant="destructive">
                        <Trash2 className="size-4" />
                        重置 MaiBot 数据
                      </Button>
                      <Button disabled={busy !== null || resourceMoveBlocked} onClick={() => setConfirmLauncherFullResetOpen(true)} size="sm" variant="destructive">
                        <Trash2 className="size-4" />
                        重置所有数据
                      </Button>
                    </div>
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
                </SettingsSection>

                {environmentServicesPanel}

                <SettingsSection className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <Wrench className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">开发者模式</p>
                      <p className="text-xs text-muted-foreground">
                        启用后显示调试页，用于本地开发和更新链路排查。
                      </p>
                    </div>
                  </div>
                  <Switch
                      aria-label="启用开发者模式"
                      checked={developerModeEnabled}
                      onCheckedChange={updateDeveloperMode}
                   />
                </SettingsSection>


                <SettingsSection className="flex items-center gap-3 overflow-x-auto">
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Network className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">网络代理</p>
                      </div>
                    </div>
                    <Badge className="shrink-0" variant={networkProxyDraft.enabled ? "success" : "outline"}>
                      {networkProxyDraft.enabled ? "已启用" : "未启用"}
                    </Badge>
                    <label className="flex shrink-0 items-center gap-2 text-sm">
                      <Switch
                        aria-label="启用本机代理"
                        checked={networkProxyDraft.enabled}
                        disabled={busy !== null}
                        onCheckedChange={(checked) =>
                          setNetworkProxyDraft((current) => ({ ...current, enabled: checked }))
                        }
                       />
                      启用本机代理
                    </label>
                    <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">
                      端口
                      <div className="flex items-center gap-2">
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
                    <Button
                      className="ml-auto shrink-0"
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
                </SettingsSection>

                <SettingsSection className="grid gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Network className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Python 包源</p>
                        <p className="text-xs text-muted-foreground">
                          用于 MaiBot、Dashboard 和依赖的版本查询及安装；拖动调整顺序，失败时依次重试。
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Badge variant={sourceSettingsDirty ? "warning" : "outline"}>
                        {sourceSettingsDirty ? "未保存" : "已同步"}
                      </Badge>
                      <Button
                        aria-label="新增源"
                        disabled={busy !== null || !sourceSettingsDraft}
                        onClick={() => sourceSettingsDraft && updateSourceGroup("python", [...sourceSettingsDraft.python, createSourceEntry("python")])}
                        size="sm"
                        variant="outline"
                      >
                        <Plus className="add-action-icon" />
                        新增源
                      </Button>
                      <Button disabled={busy !== null || !sourceSettingsDirty} onClick={resetSourceSettingsDraft} size="sm" variant="ghost">
                        <RotateCcw className="size-4" />
                        撤销
                      </Button>
                      <Button disabled={busy !== null || !sourceSettingsDraft} onClick={() => void restoreDefaultSourceSettings()} size="sm" variant="outline">
                        {busy === "source-settings" ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                        恢复默认
                      </Button>
                      <Button disabled={busy !== null || !sourceSettingsDirty} onClick={() => void saveSourceSettings()} size="sm">
                        {busy === "source-settings" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        保存源列表
                      </Button>
                    </div>
                  </div>

                  {sourceSettingsDraft ? (
                    <SourceGroupEditor
                      disabled={busy !== null}
                      entries={sourceSettingsDraft.python}
                      group="python"
                      onChange={(entries) => updateSourceGroup("python", entries)}
                    />
                  ) : (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      正在读取源列表
                    </div>
                  )}
                </SettingsSection>
              </TabsContent>

              <TabsContent className="settings-content" value="appearance">
                <SettingsSection className="grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <ImageIcon className="size-4" />
                      </span>
                      <p className="min-w-0 text-sm font-medium">应用图标</p>
                    </div>
                    <Badge variant="secondary">
                      {appIconSettings.options.find((option) => option.id === appIconSettings.selectedIconId)?.label ?? "默认"}
                    </Badge>
                  </div>

                  <RadioGroup
                    className="settings-option-list settings-option-cols-3 grid gap-0 md:grid-cols-3"
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
                          "settings-choice flex min-w-0 cursor-pointer items-center gap-3 p-3 transition-colors",
                          appIconSettings.selectedIconId === option.id
                            ? "settings-choice-selected bg-primary/10 text-foreground"
                            : "bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
                </SettingsSection>

                <SettingsSection className="grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <ImageIcon className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">悬浮球形象</p>
                        <p className="text-xs text-muted-foreground">
                          {launcherUiSettings.floatingMascotMode === "codex-pet" && selectedCodexPet
                            ? `悬浮球收起时展示 Codex 桌宠：${selectedCodexPet.displayName}`
                            : "悬浮球收起时展示启动器默认麦麦头像。"}
                        </p>
                      </div>
                    </div>
                    <Badge variant={launcherUiSettings.floatingMascotMode === "codex-pet" ? "success" : "secondary"}>
                      {launcherUiSettings.floatingMascotMode === "codex-pet" ? "Codex 桌宠" : "默认头像"}
                    </Badge>
                  </div>

                  <RadioGroup
                    className="settings-option-list grid gap-0 md:grid-cols-2"
                    disabled={busy !== null}
                    onValueChange={(value) =>
                      void saveLauncherUiSettings({
                        ...launcherUiSettings,
                        floatingMascotMode: value === "codex-pet" ? "codex-pet" : "maibot",
                        floatingCodexPetId: selectedCodexPet?.id,
                      })
                    }
                    value={launcherUiSettings.floatingMascotMode}
                  >
                    <label
                      className={cn(
                        "settings-choice flex min-w-0 cursor-pointer items-center gap-3 p-3 transition-colors",
                        launcherUiSettings.floatingMascotMode === "maibot"
                          ? "settings-choice-selected bg-primary/10 text-foreground"
                          : "bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        busy !== null && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <span className="grid size-12 shrink-0 place-items-center rounded-md border border-border bg-background">
                        <img alt="" className="size-10 object-contain" draggable={false} src={maiMascotImage} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">默认麦麦头像</span>
                        <span className="mt-1 block text-xs leading-relaxed">沿用当前悬浮球外观。</span>
                      </span>
                      <RadioGroupItem disabled={busy !== null} value="maibot" />
                    </label>
                    <label
                      className={cn(
                        "settings-choice flex min-w-0 cursor-pointer items-center gap-3 p-3 transition-colors",
                        launcherUiSettings.floatingMascotMode === "codex-pet"
                          ? "settings-choice-selected bg-primary/10 text-foreground"
                          : "bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        (busy !== null || codexPetOptions.length === 0) && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <span className="grid size-12 shrink-0 place-items-center rounded-md border border-border bg-background">
                        {selectedCodexPet ? (
                          <CodexPetPreview label={selectedCodexPet.displayName} url={selectedCodexPet.spritesheetUrl} />
                        ) : (
                          <ImageIcon className="size-5 text-muted-foreground" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">Codex 桌宠</span>
                        <span className="mt-1 block text-xs leading-relaxed">
                          {selectedCodexPet ? selectedCodexPet.displayName : "未在 Codex pets 目录发现可用桌宠。"}
                        </span>
                      </span>
                      <RadioGroupItem disabled={busy !== null || codexPetOptions.length === 0} value="codex-pet" />
                    </label>
                  </RadioGroup>

                  {codexPetOptions.length > 0 ? (
                    <RadioGroup
                      className="settings-option-list grid gap-0 md:grid-cols-2"
                      disabled={busy !== null || launcherUiSettings.floatingMascotMode !== "codex-pet"}
                      onValueChange={(value) =>
                        void saveLauncherUiSettings({
                          ...launcherUiSettings,
                          floatingMascotMode: "codex-pet",
                          floatingCodexPetId: value,
                        })
                      }
                      value={selectedCodexPet?.id}
                    >
                      {codexPetOptions.map((option) => (
                        <label
                          className={cn(
                            "settings-choice flex min-w-0 cursor-pointer items-center gap-3 p-3 transition-colors",
                            selectedCodexPet?.id === option.id && launcherUiSettings.floatingMascotMode === "codex-pet"
                              ? "settings-choice-selected bg-primary/10 text-foreground"
                              : "bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                            (busy !== null || launcherUiSettings.floatingMascotMode !== "codex-pet") && "cursor-not-allowed opacity-70",
                          )}
                          key={option.id}
                        >
                          <span className="grid size-12 shrink-0 place-items-center rounded-md border border-border bg-background">
                            <CodexPetPreview label={option.displayName} url={option.spritesheetUrl} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{option.displayName}</span>
                            <span className="mt-1 line-clamp-2 block text-xs leading-relaxed">
                              {option.description ?? option.id}
                            </span>
                          </span>
                          <RadioGroupItem disabled={busy !== null || launcherUiSettings.floatingMascotMode !== "codex-pet"} value={option.id} />
                        </label>
                      ))}
                    </RadioGroup>
                  ) : null}
                </SettingsSection>

                <div className="settings-pair-grid">
                <SettingsSection className="grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Palette className="size-4" />
                      </span>
                      <p className="min-w-0 text-sm font-medium">外观风格</p>
                    </div>
                    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
                      跟随 MaiBot
                      <Switch
                        checked={appearance.followMaiBot}
                        onCheckedChange={appearance.setFollowMaiBot}
                       />
                    </label>
                  </div>

                  {!appearance.followMaiBot ? (
                    <RadioGroup
                      className="settings-option-list settings-option-cols-3 grid gap-0 md:grid-cols-3"
                      onValueChange={(value) => appearance.setMode(value as AppearanceMode)}
                      value={appearance.mode}
                    >
                      {appearanceModeOptions.map((option) => (
                        <label
                          className={cn(
                            "settings-choice flex min-w-0 cursor-pointer items-start gap-2 p-3 transition-colors",
                            appearance.mode === option.value
                              ? "settings-choice-selected bg-primary/10 text-foreground"
                              : "bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                          key={option.value}
                        >
                          <RadioGroupItem className="mt-0.5" value={option.value} />
                          <span className="min-w-0 text-sm font-medium">{option.label}</span>
                        </label>
                      ))}
                    </RadioGroup>
                  ) : null}
                </SettingsSection>

                <SettingsSection className="grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Palette className="size-4" />
                      </span>
                      <p className="min-w-0 text-sm font-medium">配色</p>
                    </div>
                    <Badge variant="secondary">{theme.resolved === "dark" ? "深色" : "浅色"}</Badge>
                  </div>

                  <RadioGroup
                    className="settings-option-list settings-option-cols-3 grid gap-0 md:grid-cols-3"
                    onValueChange={(value) => theme.setPreference(value as ThemePreference)}
                    value={theme.preference}
                  >
                    {themeOptions.map((option) => (
                      <label
                        className={cn(
                          "settings-choice flex min-w-0 cursor-pointer items-start gap-2 p-3 transition-colors",
                          theme.preference === option.value
                            ? "settings-choice-selected bg-primary/10 text-foreground"
                            : "bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        )}
                        key={option.value}
                      >
                        <RadioGroupItem className="mt-0.5" value={option.value} />
                        <span className="min-w-0 text-sm font-medium">{option.label}</span>
                      </label>
                    ))}
                  </RadioGroup>
                </SettingsSection>
                </div>

                {appearance.mode === "future-retro" ? (
                  <SettingsSection className="grid gap-3">
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
                      <label
                        className={cn(
                          "settings-choice flex shrink-0 cursor-pointer items-center gap-2 bg-card px-3 py-2 text-sm transition-colors",
                          appearance.retroPaperTexture
                            ? "settings-choice-selected bg-primary/10 text-foreground"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        )}
                      >
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
                  </SettingsSection>
                ) : null}

                {appearance.mode === "millennium" ? (
                  <SettingsSection className="grid gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Palette className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">千禧配置</p>
                        <p className="text-xs text-muted-foreground">控制窗口边角和界面密度。</p>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <AppearanceRadiusControl appearance={appearance} />
                      <AppearanceScaleControl appearance={appearance} />
                    </div>
                  </SettingsSection>
                ) : null}

                {appearance.mode === "modern" ? (
                  <SettingsSection className="grid gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Palette className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">现代配置</p>
                        <p className="text-xs text-muted-foreground">控制主题色、字体、圆角和信息密度。</p>
                      </div>
                    </div>
                    <AppearanceAccentControl appearance={appearance} />
                    <div className="grid gap-3 md:grid-cols-2">
                      <AppearanceFontControl appearance={appearance} />
                      <AppearanceScaleControl appearance={appearance} />
                    </div>
                    <AppearanceRadiusControl appearance={appearance} />
                  </SettingsSection>
                ) : null}

                <SettingsSection className="flex flex-wrap items-center justify-between gap-3">
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
                </SettingsSection>
              </TabsContent>

              <TabsContent className="settings-content" value="paths">
                <SettingsSection className="grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <HardDrive className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">实例管理</p>
                        <p className="text-xs text-muted-foreground">
                          使用已有目录只切换指向；复制迁移要求空目标目录，成功后保留原目录。
                        </p>
                      </div>
                    </div>
                    <Badge variant="secondary">唯一实例</Badge>
                  </div>
                  <div className="grid gap-2">
                    {editableRuntimeResourcePathConfigs.map((config) => (
                      <SettingsSection className="grid gap-3" key={config.key}>
                      <ResourcePathEditor
                        blocked={resourceMoveBlocked || busy !== null || resourceWorkflow.busyKey !== null}
                        busy={resourceWorkflow.busyKey === config.key}
                        config={config}
                        onOpenPath={openPath}
                        onBrowse={resourceWorkflow.browse}
                        onPrepare={resourceWorkflow.prepare}
                      />
                        {services.filter((service) => service.id === "maibot"
                          ? config.key === "maibot"
                          : config.key === (initState.qqBackend ?? "napcat")).map((service) => (
                          <ServiceDetail
                            commandBusy={busy === `command:${service.id}`}
                            commandConfig={serviceCommands.find((command) => command.serviceId === service.id)}
                            key={service.id}
                            onOpenPath={openPath}
                            onResetCommand={resetCommandConfig}
                            onSaveCommand={saveCommandConfig}
                            service={service}
                          />
                        ))}
                        {config.key === "maibot" ? <MaiBotConfigImportPanel disabled={maibotDataBlocked || Boolean(snapshot.runtimeOperation) || busy !== null || resourceWorkflow.busyKey !== null} /> : null}
                      </SettingsSection>
                    ))}
                  </div>
                  {resourceMoveBlocked ? (
                    <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-foreground">
                      {snapshot.runtimeOperation ? `正在${snapshot.runtimeOperation}，请完成或取消后再操作。` : "请先停止所有服务，再操作组件目录。"}
                    </div>
                  ) : null}
                </SettingsSection>
                <div className="settings-pair-grid">
                  <PathField label="用户数据目录" onOpen={openPath} value={snapshot.paths.userDataRoot} />
                  <PathField label="一键包安装目录" onOpen={openPath} value={snapshot.paths.installRoot} />
                  <PathField label="python基础环境" onOpen={openPath} value={snapshot.paths.runtimeRoot} />
                </div>
              </TabsContent>

              {developerModeEnabled ? (
              <TabsContent className="settings-content" value="debug">
                <SettingsSection className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Smartphone className="size-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">迷你模式</p>
                      <p className="text-xs text-muted-foreground">切换为手机比例的竖屏窗口（约 420 × 840），退出时恢复原窗口。</p>
                    </div>
                  </div>
                  <Button aria-pressed={miniMode} disabled={busy !== null || !window.maibotDesktop} onClick={() => void toggleMiniMode()} size="sm" variant={miniMode ? "default" : "secondary"}>
                    {busy === "mini-mode" ? <Loader2 className="animate-spin" /> : <Smartphone />}
                    {miniMode ? "退出迷你模式" : "进入迷你模式"}
                  </Button>
                </SettingsSection>
                <p className="text-xs text-muted-foreground">
                  调试配置用于本地开发和排查启动链路；修改后会影响之后启动的服务。
                </p>

                <SettingsSection className="grid gap-3">
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
                      "settings-choice flex min-w-0 cursor-pointer items-start gap-3 p-3 transition-colors",
                      serviceStartupSettings.useLocalDashboard
                        ? "settings-choice-selected bg-primary/10 text-foreground"
                        : "bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
                </SettingsSection>

              </TabsContent>
              ) : null}

              <TabsContent className="settings-content min-h-0 grid-rows-[minmax(0,1fr)_auto] !gap-3 data-[state=active]:flex-1" value="logs">
                <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-card">
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
        title="重置启动器设置？"
        tone="warning"
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          会重置关闭行为、服务命令、运行时工具路径、依赖源、更新源、资源路径选择和 QQ 后端选择。完成后界面会刷新并重新进入启动引导。
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
        title="重置所有数据？"
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
    {resourceWorkflow.dialogs}
    </>
  );
}
