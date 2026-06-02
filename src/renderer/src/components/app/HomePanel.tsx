import {
  ArrowRight,
  ChevronDown,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  GripVertical,
  HeartPulse,
  ListTree,
  Loader2,
  Maximize2,
  PackageCheck,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Server,
  Settings,
  Send,
  Sparkles,
  Square,
  WandSparkles,
  Wrench,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import emojiDropImage from "@/assets/home-drops/emoji2.png";
import maiDropImage from "@/assets/home-drops/mai.png";
import mai2DropImage from "@/assets/home-drops/mai2.png";
import maiMascotImage from "@/assets/mai2.png";
import futureRetroMascotImage from "@/assets/mai-fr.png";
import type {
  DesktopSnapshot,
  LauncherUpdateInfo,
  LocalChatEvent,
  LocalChatMessageEvent,
  MaiBotStatisticSummary,
  ModuleBranchOption,
  ModuleSourceConfig,
  ModuleSourcePreset,
  ModuleTagOption,
  ModuleUpdateTarget,
  QqBackend,
  ServiceDescriptor,
  ServiceId,
  ServiceStatus,
  SystemPerformanceSnapshot,
} from "@shared/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  HOME_CONTENT_CARD_OPTIONS,
  HOME_CONTENT_LAYOUT_CHANGE_EVENT,
  DEFAULT_PLUGIN_SURPRISE_COUNT,
  DEFAULT_SYSTEM_PERFORMANCE_METRICS,
  createHomeContentEntry,
  homeContentCardLabel,
  readHomeContentLayout,
  resetHomeContentLayout,
  saveHomeContentLayout,
  type HomeContentArea,
  type HomeContentCardType,
  type HomeContentEntry,
  type HomeContentWidth,
  type PluginSurpriseCardSettings,
  type SystemPerformanceCardSettings,
  type SystemPerformanceMetricKey,
} from "@/lib/home-content-layout";
import { localChatErrorMessage } from "@/lib/local-chat-error";
import {
  fetchMarketPlugins,
  pluginDescription,
  pluginName,
  pluginVersion,
  type MarketPlugin,
} from "@/lib/maibot-plugin-api";
import {
  QQ_WEBUI_PORT_CHANGE_EVENT,
  isValidPortText,
  readQqWebuiPort,
} from "@/lib/qq-webui-port";
import { useAppearance } from "@/lib/use-appearance";
import { cn } from "@/lib/utils";
import { WebviewPanel } from "./WebviewPanel";
import { QuickActionsPanel } from "./QuickActionsPanel";
import { MarkdownRenderer } from "./MarkdownRenderer";

type MaiBotUpdateChannel = "stable" | "other";
type CompactChatState = "idle" | "connecting" | "connected" | "error";

const LOCAL_CHAT_USER_NAME_STORAGE_KEY = "maibot.localChat.userName";
const ADAPTER_CONFIG_PROMPTED_STORAGE_PREFIX = "maibot.adapterConfigPrompted";
const MESSAGE_PLATFORM_GUIDE_REQUEST_KEY = "maibot.messagePlatformGuide.requested";
const MAIBOT_OFFICIAL_DOCS_URL = "https://docs.mai-mai.org/";
const MASCOT_INTRO_TRIGGER_CLICKS = 10;

let mascotIntroShownThisSession = false;

export function adapterPluginIdForBackend(backend: QqBackend): string {
  return backend === "snowluma" ? "maibot-team.snowluma-adapter" : "maibot-team.napcat-adapter";
}

export function markAdapterConfigPrompted(backend: QqBackend): void {
  try {
    localStorage.setItem(`${ADAPTER_CONFIG_PROMPTED_STORAGE_PREFIX}.${backend}`, "1");
  } catch {
    // Local storage may be unavailable in isolated previews.
  }
}

export function shouldPromptAdapterConfig(backend: QqBackend): boolean {
  try {
    return localStorage.getItem(`${ADAPTER_CONFIG_PROMPTED_STORAGE_PREFIX}.${backend}`) !== "1";
  } catch {
    return true;
  }
}

function qqWebuiUrl(serviceUrl: string | undefined, backend: QqBackend, portText: string): string {
  const fallback = backend === "snowluma" ? "http://127.0.0.1:5099" : "http://127.0.0.1:6099/webui";
  const url = new URL(serviceUrl ?? fallback);
  if (isValidPortText(portText)) {
    url.hostname = "127.0.0.1";
    url.port = String(Number(portText));
  }
  if (backend !== "snowluma" && (url.pathname === "/" || url.pathname.length === 0)) {
    url.pathname = "/webui";
  }
  return url.toString();
}

const statusText: Record<ServiceStatus, string> = {
  stopped: "未启动",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  error: "异常",
};

const statusColor: Record<ServiceStatus, string> = {
  stopped: "var(--retro-ink, var(--muted-foreground))",
  starting: "var(--warning)",
  running: "var(--retro-rust, var(--success))",
  stopping: "var(--warning)",
  error: "var(--destructive)",
};

function valueOrFallback(value: string | undefined): string {
  return value && value.trim().length > 0 ? value : "未读取";
}

function versionAsTag(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^v/iu.test(trimmed) ? trimmed : `v${trimmed}`;
}

function formatFileSize(bytes: number | undefined): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return undefined;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatMemorySize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 GB";
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "0 分钟";
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function ServiceStatusText({
  status,
  className,
}: {
  status: ServiceStatus;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium leading-none", className)}
      style={{ color: statusColor[status] }}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {statusText[status]}
    </span>
  );
}

function formatStatNumber(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : undefined;
}

function parseVersionParts(version: string | undefined): number[] {
  const normalized = version?.trim().replace(/^v/iu, "").split(/[+-]/u, 1)[0] ?? "";
  return normalized
    .split(/[._-]/u)
    .map((part) => Number(part.match(/^\d+/u)?.[0] ?? 0));
}

function compareVersionText(left: string | undefined, right: string | undefined): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return (left ?? "").localeCompare(right ?? "", "en-US", { numeric: true, sensitivity: "base" });
}

function messageFromError(error: unknown): string {
  return localChatErrorMessage(error);
}

function localChatText(event: LocalChatMessageEvent): string {
  if (event.content.trim()) {
    return event.content.trim();
  }
  return event.images?.length ? `[图片 ${event.images.length}]` : "";
}

function mergeLocalChatMessage(
  messages: LocalChatMessageEvent[],
  message: LocalChatMessageEvent,
): LocalChatMessageEvent[] {
  if (messages.some((item) => item.id === message.id)) {
    return messages.map((item) => item.id === message.id ? { ...item, ...message } : item);
  }
  return [...messages, message].slice(-6);
}

function DetailRow({
  label,
  value,
  className,
  retro = false,
}: {
  label: string;
  value: string | undefined;
  className?: string;
  retro?: boolean;
}): React.JSX.Element {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate",
          retro ? "retro-value text-right" : "font-mono font-semibold",
        )}
        title={value}
      >
        {valueOrFallback(value)}
      </span>
    </div>
  );
}

function ChoiceSwitch<T extends string>({
  value,
  options,
  onChange,
  retro = false,
}: {
  value: T;
  options: Array<{ value: T; label: string; version: string | undefined }>;
  onChange: (value: T) => void;
  retro?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        retro ? "retro-control grid gap-2 p-1" : "grid gap-2 rounded-lg border border-border bg-muted/30 p-1",
        options.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3",
      )}
    >
      {options.map((option) => {
        const selected = value === option.value;
        const disabled = !option.version;
        return (
          <button
            className={cn(
              "grid min-h-14 min-w-0 gap-1 px-3 py-2 text-left text-xs transition-colors",
              retro ? "rounded-sm border border-transparent" : "rounded-md",
              selected ? cn("bg-primary text-primary-foreground", !retro && "shadow-sm") : "text-foreground hover:bg-muted",
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

function LocalChatQuickCard({
  active,
  maibotService,
  onOpenFull,
  retro,
}: {
  active: boolean;
  maibotService: ServiceDescriptor | undefined;
  onOpenFull: () => void;
  retro: boolean;
}): React.JSX.Element {
  const [state, setState] = useState<CompactChatState>("idle");
  const [messages, setMessages] = useState<LocalChatMessageEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const connected = state === "connected";

  const connect = useCallback(async () => {
    if (!window.maibotDesktop?.localChat) {
      setState("error");
      setError("桌面桥未就绪");
      return;
    }
    if (maibotService?.status !== "running") {
      setState("idle");
      setError(null);
      return;
    }

    setState("connecting");
    setError(null);
    try {
      const nextState = await window.maibotDesktop.localChat.connect();
      setState(nextState);
      const history = await window.maibotDesktop.localChat.listMessages();
      setMessages(history.filter((message) => message.kind !== "planner").slice(-12));
      if (nextState !== "connected") {
        setError("MaiBot Core 正在启动或 WebUI 聊天服务还在加载，请稍等片刻后重试。");
      }
    } catch (nextError) {
      setState("error");
      setError(messageFromError(nextError));
    }
  }, [maibotService?.status]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const unsubscribe = window.maibotDesktop?.localChat.onEvent((event: LocalChatEvent) => {
      if ("type" in event) {
        setState(event.state);
        if (event.state === "connected") {
          setError(null);
        }
        return;
      }
      if (event.kind !== "planner") {
        setMessages((current) => mergeLocalChatMessage(current, event));
      }
    });

    void connect();
    return () => {
      unsubscribe?.();
    };
  }, [active, connect]);

  const sendQuickMessage = useCallback(async () => {
    const content = draft.trim();
    if (!content || !connected || sending || !window.maibotDesktop?.localChat) {
      return;
    }

    setDraft("");
    setSending(true);
    setError(null);
    try {
      const userName = localStorage.getItem(LOCAL_CHAT_USER_NAME_STORAGE_KEY) ?? "本地用户";
      const sent = await window.maibotDesktop.localChat.send({ content, userName });
      setMessages((current) => mergeLocalChatMessage(current, sent));
    } catch (nextError) {
      setDraft(content);
      setState("error");
      setError(messageFromError(nextError));
    } finally {
      setSending(false);
    }
  }, [connected, draft, sending]);

  const visibleMessages = messages
    .map((message) => ({ ...message, text: localChatText(message) }))
    .filter((message) => message.text.length > 0)
    .slice(-12);

  return (
    <section className={cn(retro ? "retro-panel p-3.5 pl-5" : "rounded-lg border border-border bg-card p-3.5")}>
      <div className={cn("mb-3 flex items-center gap-2", retro ? "justify-between" : "justify-end")}>
        {retro ? <p className="retro-title text-2xl text-foreground">聊聊</p> : null}
        <div className="flex shrink-0 items-center gap-2">
          <Button className="size-7" onClick={onOpenFull} size="icon" title="展开随便聊聊" variant="secondary">
            <Maximize2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "mb-3 grid max-h-32 gap-2 overflow-y-auto p-3 [scrollbar-width:thin]",
          retro ? "retro-control min-h-24" : "min-h-20 rounded-md border border-border bg-muted/30",
        )}
      >
        {visibleMessages.length > 0 ? (
          visibleMessages.map((message) => (
            <div
              className={cn("flex min-w-0", message.role === "user" ? "justify-end" : "justify-start")}
              key={message.id}
            >
              <p
                className={cn(
                  "max-w-[82%] truncate px-2.5 py-1.5 text-xs",
                  retro ? "rounded-sm border" : "rounded-md",
                  message.role === "user"
                    ? cn("bg-primary text-primary-foreground", retro && "border-primary")
                    : message.role === "error"
                      ? cn("bg-destructive/10 text-destructive", retro && "border-destructive/30")
                      : cn("bg-card text-foreground", retro && "border-border"),
                )}
                title={message.text}
              >
                {message.text}
              </p>
            </div>
          ))
        ) : (
          <div className="grid place-items-center text-xs text-muted-foreground">
            {error ?? "无信号"}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          disabled={!connected || sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendQuickMessage();
            }
          }}
          placeholder={connected ? "输入一句话..." : "启动 MaiBot Core 后可聊天"}
          value={draft}
        />
        <Button
          aria-label="发送"
          className="shrink-0"
          disabled={!connected || !draft.trim() || sending}
          onClick={() => void sendQuickMessage()}
          size={retro ? "icon" : "icon-sm"}
          title="发送"
        >
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
    </section>
  );
}

function ServiceCardControls({
  service,
  busy,
  onStart,
  onStop,
  onRestart,
  retro,
}: {
  service: ServiceDescriptor;
  busy: boolean;
  onStart: (id: ServiceId) => void;
  onStop: (id: ServiceId) => void;
  onRestart: (id: ServiceId) => void;
  retro: boolean;
}): React.JSX.Element {
  const isTransitioning = service.status === "starting" || service.status === "stopping" || busy;
  const isStarting = service.status === "starting";
  const canStart = service.status === "stopped" || service.status === "error";
  const canStop = service.status === "running" || service.status === "starting" || service.status === "error";
  const stopDisabled = !canStop || (busy && !isStarting) || service.status === "stopping";

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        aria-label={`启动 ${service.name}`}
        className={cn(retro ? "size-8" : "size-7")}
        disabled={!canStart || isTransitioning}
        onClick={() => onStart(service.id)}
        size="icon"
        title="启动"
        variant={retro ? "secondary" : "ghost"}
      >
        {busy && canStart ? <Loader2 className="animate-spin" /> : <Play />}
      </Button>
      <Button
        aria-label={`停止 ${service.name}`}
        className={cn(retro ? "size-8" : "size-7")}
        disabled={stopDisabled}
        onClick={() => onStop(service.id)}
        size="icon"
        title="停止"
        variant={retro ? "secondary" : "ghost"}
      >
        <Square />
      </Button>
      <Button
        aria-label={`重启 ${service.name}`}
        className={cn(retro ? "size-8" : "size-7")}
        disabled={isTransitioning}
        onClick={() => onRestart(service.id)}
        size="icon"
        title="重启"
        variant={retro ? "secondary" : "ghost"}
      >
        <RefreshCw />
      </Button>
    </div>
  );
}

function ServiceSummary({
  icon,
  service,
  serviceControls,
  webuiAction,
  adapterAction,
  retro,
}: {
  icon: React.ReactNode;
  service: ServiceDescriptor | undefined;
  serviceControls?: {
    busy: boolean;
    onStart: (id: ServiceId) => void;
    onStop: (id: ServiceId) => void;
    onRestart: (id: ServiceId) => void;
  };
  webuiAction?: {
    title: string;
    label: string;
    onClick: () => void;
  };
  adapterAction?: {
    title: string;
    description?: string;
    label: string;
    onClick: () => void;
  };
  retro: boolean;
}): React.JSX.Element {
  return (
    <div className={cn("grid w-full min-w-0 gap-3", retro ? "retro-panel p-3.5 pl-5" : "rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {icon ? (
            <span className={cn("grid shrink-0 place-items-center text-primary", retro ? "retro-control size-9" : "size-8 rounded-md bg-primary/10")}>
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <p className={cn("truncate", retro ? "retro-title text-2xl" : "text-sm font-semibold")}>{service?.name ?? "未知服务"}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {service && serviceControls ? (
            <ServiceCardControls
              busy={serviceControls.busy}
              onRestart={serviceControls.onRestart}
              onStart={serviceControls.onStart}
              onStop={serviceControls.onStop}
              retro={retro}
              service={service}
            />
          ) : null}
          {service ? <ServiceStatusText status={service.status} /> : null}
        </div>
      </div>
      {(webuiAction || adapterAction) ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
          {webuiAction ? (
            <div className={cn(retro ? "retro-control flex flex-wrap items-center justify-between gap-3 px-3 py-2" : "flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2")}>
              <p className={cn("min-w-0 truncate font-bold", retro ? "text-base" : "text-xs")}>{webuiAction.title}</p>
              <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
                <Button
                  className="h-8 shrink-0 justify-self-start px-3 text-xs"
                  onClick={webuiAction.onClick}
                  size="sm"
                  variant="secondary"
                >
                  <ExternalLink className="size-4" />
                  {webuiAction.label}
                </Button>
              </div>
            </div>
          ) : null}
          {adapterAction ? (
            <div className={cn(retro ? "retro-control grid gap-3 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" : "grid gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center")}>
              <div className="min-w-0">
                <p className={cn("truncate font-bold", retro ? "text-base" : "text-xs")}>{adapterAction.title}</p>
                {adapterAction.description ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                    {adapterAction.description}
                  </p>
                ) : null}
              </div>
              <Button className="h-8 shrink-0 px-3 text-xs" onClick={adapterAction.onClick} size="sm" variant="secondary">
                <Settings />
                {adapterAction.label}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MessagePlatformConnectCard({
  onClick,
  retro,
}: {
  onClick: () => void;
  retro: boolean;
}): React.JSX.Element {
  return (
    <button
      data-home-guide-target="message-platform"
      className={cn(
        "grid w-full min-w-0 gap-3 text-left transition-colors hover:border-primary",
        retro
          ? "retro-panel !border-primary p-3.5 pl-5 [&::after]:!border-b-primary [&::before]:!bg-primary"
          : "rounded-lg border border-dashed border-primary/70 bg-card p-3.5 hover:bg-primary/5",
      )}
      onClick={onClick}
      type="button"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <p className={cn("truncate", retro ? "retro-title text-2xl" : "text-sm font-semibold")}>
              消息平台
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              新增 QQ-NapCat 或 QQ-SnowLuma，自动写入连接配置并启动后端。
            </p>
          </div>
        </div>
      </div>
      <div className={cn(retro ? "retro-control flex items-center justify-between gap-3 p-3" : "flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3")}>
        <span className="text-xs text-muted-foreground">配置 NapCat 或者 SnowLuma 来让麦麦连接到QQ</span>
        <span className={cn("inline-flex h-7 items-center gap-1 bg-primary px-2.5 text-[11px] text-primary-foreground", retro ? "rounded-sm font-semibold" : "rounded-md font-medium")}>
          新增平台
          <ArrowRight className="size-3.5" />
        </span>
      </div>
    </button>
  );
}

function LauncherUpdateCard({
  appVersion,
  latestTag,
  updateBusy,
  onUpdate,
  retro,
}: {
  appVersion: string;
  latestTag?: string;
  updateBusy?: boolean;
  onUpdate: () => void;
  retro: boolean;
}): React.JSX.Element {
  const currentTag = versionAsTag(appVersion);
  const updateAvailable = latestTag ? compareVersionText(latestTag, currentTag) > 0 : false;

  return (
    <section className={cn(retro ? "retro-panel p-3.5 pl-5" : "rounded-lg border border-border bg-card p-3.5")}>
      {retro ? (
        <p className="retro-title mb-3 text-2xl text-foreground">一键包信息</p>
      ) : null}
      <div
        className={cn(
          "grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end",
          retro ? "retro-control p-3 text-xs" : "rounded-md border border-border bg-muted/30 p-3 text-xs",
        )}
      >
        <div className="grid min-w-0 gap-2">
          <DetailRow label="本地版本" value={currentTag} retro={retro} />
          <DetailRow label="最新版本" value={latestTag} retro={retro} />
        </div>
        <Button
          aria-label="更新一键包"
          className={cn("relative justify-self-end", retro ? "size-10 px-0" : "h-7 px-2.5 text-[11px]")}
          disabled={updateBusy}
          onClick={onUpdate}
          size={retro ? "icon" : "sm"}
          variant="secondary"
        >
          {updateAvailable ? (
            <span
              className={cn(
                "absolute bg-warning",
                retro
                  ? "right-[var(--retro-stroke)] top-[var(--retro-stroke)] size-2 rounded-none"
                  : "right-1 top-1 size-2 rounded-full",
              )}
            />
          ) : null}
          {updateBusy ? <Loader2 className="animate-spin" /> : <SolidUpgradeIcon />}
        </Button>
      </div>
    </section>
  );
}

function SolidUpgradeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden className="size-5" fill="none" viewBox="0 0 24 24">
      <path d="M12 21V7" stroke="currentColor" strokeWidth="6" />
      <path d="M4 12 12 4" stroke="currentColor" strokeWidth="6" />
      <path d="M20 12 12 4" stroke="currentColor" strokeWidth="6" />
    </svg>
  );
}

function SolidEditLayoutIcon(): React.JSX.Element {
  return (
    <span aria-hidden className="grid size-18 grid-cols-2 gap-1.5 p-1">
      <span className="bg-current" />
      <span className="bg-current" />
      <span className="bg-current" />
      <span className="bg-current" />
    </span>
  );
}

function SharpSaveIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg aria-hidden className={cn("size-12", className)} fill="currentColor" viewBox="0 0 24 24">
      <path d="M3 2h15l3 3v17H3V2Zm3 3v6h11V5h-2v4H8V5H6Zm2 10v4h8v-4H8Z" />
    </svg>
  );
}

function MaiBotOverviewCard({
  service,
  localVersion,
  latestStable,
  updateBusy,
  onUpdate,
  retro,
}: {
  service: ServiceDescriptor | undefined;
  localVersion: string | undefined;
  latestStable: string | undefined;
  updateBusy?: boolean;
  onUpdate: () => void;
  retro: boolean;
}): React.JSX.Element {
  const hasNewVersion = compareVersionText(latestStable, localVersion) > 0;

  return (
    <div className={cn(retro ? "retro-panel grid min-w-0 gap-4 p-4 pl-6" : "grid min-w-0 gap-4 rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className={cn("min-w-0", !retro && "flex items-center gap-3")}>
          {!retro ? (
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <Radar className="size-4.5" />
            </span>
          ) : null}
          <div className="min-w-0">
            <p className={cn("flex min-w-0 items-center gap-2", retro ? "retro-title text-[3rem] leading-none text-foreground" : "text-sm font-semibold")}>
              <span className="min-w-0 truncate">{service?.name ?? "MaiBot Core"}</span>
              <span
                aria-hidden
                className={cn("shrink-0 translate-y-[8px] rounded-full", retro ? "size-3" : "size-2")}
                style={{ backgroundColor: service?.status === "running" ? "#179f37" : "currentColor" }}
              />
            </p>
          </div>
        </div>
        {/* {service ? <ServiceStatusText status={service.status} /> : null} */}
      </div>

      <div className="-mt-3 grid gap-1" aria-hidden>
        <span className="h-1 bg-[var(--retro-ink)]" />
        <span className="h-1 bg-[var(--retro-gold)]" />
        <span className="h-1 bg-[var(--retro-rust)]" />
      </div>

      <div
        className={cn(
          "grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end",
          retro ? "pt-1" : "rounded-md border border-border bg-muted/30 p-3",
        )}
      >
        <div className="min-w-0">
          <p className={cn("text-xs text-muted-foreground", retro && "font-semibold")}>{retro ? "MAIBOT 版本" : "MaiBot 版本"}</p>
          <p
            className={cn(retro ? "retro-value mt-2 truncate text-3xl leading-none" : "mt-1 truncate font-mono text-base font-semibold")}
            title={localVersion}
          >
            {valueOrFallback(localVersion)}
          </p>
        </div>
        <div className="grid min-w-0 gap-1 sm:min-w-44">
          <Button
            aria-label="更新 MaiBot"
            className={cn(
              "relative mt-1 justify-self-end bg-transparent shadow-none hover:bg-transparent",
              retro ? "size-10 px-0" : "h-7 px-2.5 text-[11px]",
            )}
            disabled={updateBusy}
            onClick={onUpdate}
            size={retro ? "icon" : "sm"}
            variant="secondary"
          >
            {hasNewVersion ? (
              <span
                className={cn(
                  "absolute bg-warning",
                  retro
                    ? "right-[var(--retro-stroke)] top-[var(--retro-stroke)] size-2 rounded-none"
                    : "right-1 top-1 size-2 rounded-full",
                )}
              />
            ) : null}
            {updateBusy ? <Loader2 className="animate-spin" /> : <SolidUpgradeIcon />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function HomeStatsPanel({
  snapshot,
  onOpenQuickActions,
  retro,
}: {
  snapshot: DesktopSnapshot;
  onOpenQuickActions: () => void;
  retro: boolean;
}): React.JSX.Element {
  const [maibotStats, setMaibotStats] = useState<MaiBotStatisticSummary | null>(null);
  const topChats = maibotStats?.chatStats.slice(0, 2) ?? [];

  useEffect(() => {
    let disposed = false;

    const loadStats = async (): Promise<void> => {
      try {
        const stats = await window.maibotDesktop?.statistics.getMaiBot();
        if (!disposed) {
          setMaibotStats(stats ?? null);
        }
      } catch {
        if (!disposed) {
          setMaibotStats(null);
        }
      }
    };

    void loadStats();
    const timer = window.setInterval(() => {
      void loadStats();
    }, 30_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [snapshot.paths.maibotRoot]);

  return (
    <div className={cn("grid self-start", retro ? "gap-4" : "gap-3")}>
      <button
        className={cn(
          "flex w-full items-center justify-between gap-3 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          retro
            ? "retro-panel retro-panel-bare p-4"
            : "rounded-lg border border-border bg-card p-3.5 hover:border-primary/45 hover:bg-accent/45",
        )}
        onClick={() => void window.maibotDesktop?.openExternal(MAIBOT_OFFICIAL_DOCS_URL)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="min-w-0">
            <span className={cn("block", retro ? "retro-title text-xl" : "text-sm font-semibold")}>官方文档</span>
            <span className={cn("block truncate", retro ? "font-mono text-xs text-foreground" : "text-[11px] text-muted-foreground")}>docs.mai-mai.org</span>
          </span>
        </span>
        <ArrowRight className={cn("shrink-0", retro ? "size-5 text-primary" : "size-4 text-muted-foreground")} />
      </button>
      <aside className={cn(retro ? "retro-panel grid gap-4 p-4" : "grid gap-3 rounded-lg border border-border bg-card p-3.5")}>
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>统计信息</p>
          </div>
        </div>

        <div className="grid gap-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-muted-foreground">LLM 用量</p>
            {maibotStats?.periodLabel ? (
              <span className="rounded-sm border border-border bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                {maibotStats.periodLabel}
              </span>
            ) : null}
          </div>
          <DetailRow label="请求数" value={formatStatNumber(maibotStats?.totalRequests)} retro={retro} />
          <DetailRow label="Token" value={formatStatNumber(maibotStats?.totalTokens)} retro={retro} />
          <DetailRow label="总花费" value={maibotStats?.totalCost} retro={retro} />
          <DetailRow label="Token/小时" value={maibotStats?.tokensPerHour} retro={retro} />
        </div>

        <div className={cn("grid gap-2 pt-3 text-xs", retro ? "retro-rule" : "border-t border-border")}>
          <p className="text-[11px] font-semibold text-muted-foreground">消息统计</p>
          <DetailRow label="消息数" value={formatStatNumber(maibotStats?.totalMessages)} retro={retro} />
          <DetailRow label="回复数" value={formatStatNumber(maibotStats?.totalReplies)} retro={retro} />
          <DetailRow label="在线时间" value={maibotStats?.totalOnlineTime} retro={retro} />
          {topChats.map((chat) => (
            <DetailRow
              key={chat.name}
              label={chat.name}
              value={formatStatNumber(chat.messageCount)}
              retro={retro}
            />
          ))}
        </div>
      </aside>
      <section className={cn(retro ? "retro-panel retro-panel-action min-h-[72px] p-0 pl-[88px] pr-4" : "rounded-lg border border-border bg-card p-3.5")}>
        <div className={cn("flex items-center justify-between gap-3", retro && "min-h-[72px]")}>
          <div className="flex min-w-0 items-center gap-3">
            {!retro ? (
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <Wrench className="size-4.5" />
              </span>
            ) : null}
            <div className="min-w-0">
              <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>快捷操作</p>
              <p className="text-[11px] text-muted-foreground">路径、数据库和配置导入。</p>
            </div>
          </div>
          <Button
            aria-label="打开快捷操作"
            className={cn(retro ? "size-10 border-0 bg-transparent text-primary hover:bg-transparent hover:text-primary active:bg-transparent" : "size-8")}
            onClick={onOpenQuickActions}
            size="icon"
            title="打开快捷操作"
            variant={retro ? "ghost" : "secondary"}
          >
            <ArrowRight className={cn(retro ? "size-7" : "size-3.5")} />
          </Button>
        </div>
      </section>
    </div>
  );
}

function OfficialDocsCard({ retro }: { retro: boolean }): React.JSX.Element {
  return (
    <button
      className={cn(
        "flex w-full items-center justify-between gap-3 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        retro
          ? "retro-panel retro-panel-bare p-4"
          : "rounded-lg border border-border bg-card p-3.5 hover:border-primary/45 hover:bg-accent/45",
      )}
      onClick={() => void window.maibotDesktop?.openExternal(MAIBOT_OFFICIAL_DOCS_URL)}
      type="button"
    >
      <span className="min-w-0">
        <span className={cn("block", retro ? "retro-title text-xl" : "text-sm font-semibold")}>官方文档</span>
        <span className={cn("block truncate", retro ? "font-mono text-xs text-foreground" : "text-[11px] text-muted-foreground")}>docs.mai-mai.org</span>
      </span>
      <ArrowRight className={cn("shrink-0", retro ? "size-5 text-primary" : "size-4 text-muted-foreground")} />
    </button>
  );
}

function StatsInfoCard({ snapshot, retro }: { snapshot: DesktopSnapshot; retro: boolean }): React.JSX.Element {
  const [maibotStats, setMaibotStats] = useState<MaiBotStatisticSummary | null>(null);
  const topChats = maibotStats?.chatStats.slice(0, 2) ?? [];

  useEffect(() => {
    let disposed = false;
    const loadStats = async (): Promise<void> => {
      try {
        const stats = await window.maibotDesktop?.statistics.getMaiBot();
        if (!disposed) setMaibotStats(stats ?? null);
      } catch {
        if (!disposed) setMaibotStats(null);
      }
    };

    void loadStats();
    const timer = window.setInterval(() => void loadStats(), 30_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [snapshot.paths.maibotRoot]);

  return (
    <aside className={cn(retro ? "retro-panel grid gap-4 p-4" : "grid gap-3 rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>统计信息</p>
        </div>
      </div>
      <div className="grid gap-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold text-muted-foreground">LLM 用量</p>
          {maibotStats?.periodLabel ? (
            <span className="rounded-sm border border-border bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
              {maibotStats.periodLabel}
            </span>
          ) : null}
        </div>
        <DetailRow label="请求数" value={formatStatNumber(maibotStats?.totalRequests)} retro={retro} />
        <DetailRow label="Token" value={formatStatNumber(maibotStats?.totalTokens)} retro={retro} />
        <DetailRow label="总花费" value={maibotStats?.totalCost} retro={retro} />
        <DetailRow label="Token/小时" value={maibotStats?.tokensPerHour} retro={retro} />
      </div>
      <div className={cn("grid gap-2 pt-3 text-xs", retro ? "retro-rule" : "border-t border-border")}>
        <p className="text-[11px] font-semibold text-muted-foreground">消息统计</p>
        <DetailRow label="消息数" value={formatStatNumber(maibotStats?.totalMessages)} retro={retro} />
        <DetailRow label="回复数" value={formatStatNumber(maibotStats?.totalReplies)} retro={retro} />
        <DetailRow label="在线时间" value={maibotStats?.totalOnlineTime} retro={retro} />
        {topChats.map((chat) => (
          <DetailRow key={chat.name} label={chat.name} value={formatStatNumber(chat.messageCount)} retro={retro} />
        ))}
      </div>
    </aside>
  );
}

function QuickActionsCard({ onOpenQuickActions, retro }: { onOpenQuickActions: () => void; retro: boolean }): React.JSX.Element {
  return (
    <section className={cn(retro ? "retro-panel retro-panel-action min-h-[72px] p-0 pl-[88px] pr-4" : "rounded-lg border border-border bg-card p-3.5")}>
      <div className={cn("flex items-center justify-between gap-3", retro && "min-h-[72px]")}>
        <div className="flex min-w-0 items-center gap-3">
          {!retro ? (
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <Wrench className="size-4.5" />
            </span>
          ) : null}
          <div className="min-w-0">
            <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>快捷操作</p>
            <p className="text-[11px] text-muted-foreground">路径、数据库和配置导入。</p>
          </div>
        </div>
        <Button
          aria-label="打开快捷操作"
          className={cn(retro ? "size-10 border-0 bg-transparent text-primary hover:bg-transparent hover:text-primary active:bg-transparent" : "size-8")}
          onClick={onOpenQuickActions}
          size="icon"
          title="打开快捷操作"
          variant={retro ? "ghost" : "secondary"}
        >
          <ArrowRight className={cn(retro ? "size-7" : "size-3.5")} />
        </Button>
      </div>
    </section>
  );
}

function EnvironmentHealthCard({ snapshot, retro }: { snapshot: DesktopSnapshot; retro: boolean }): React.JSX.Element {
  const checks = snapshot.initState.checks ?? [];
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const errorCount = checks.filter((check) => check.status === "error").length;
  const issueChecks = checks.filter((check) => check.status !== "ok").slice(0, 4);
  const healthy = errorCount === 0 && warningCount === 0 && snapshot.initState.isReady;

  return (
    <section className={cn(retro ? "retro-panel grid gap-3 p-4" : "grid gap-3 rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>环境检查</p>
          <p className="text-[11px] text-muted-foreground">
            {healthy ? "基础运行环境已就绪" : `${errorCount} 个错误 / ${warningCount} 个提醒`}
          </p>
        </div>
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-md",
            healthy ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600",
          )}
        >
          {healthy ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
        </span>
      </div>
      <div className="grid gap-2 text-xs">
        <DetailRow label="检查项" value={`${checks.length}`} retro={retro} />
        <DetailRow label="错误" value={`${errorCount}`} retro={retro} />
        <DetailRow label="提醒" value={`${warningCount}`} retro={retro} />
      </div>
      <div className={cn("grid gap-2 pt-3", retro ? "retro-rule" : "border-t border-border")}>
        {issueChecks.length > 0 ? issueChecks.map((check) => (
          <div className="min-w-0" key={check.id}>
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className={cn("size-1.5 rounded-full", check.status === "error" ? "bg-destructive" : "bg-amber-500")} />
              <span className="truncate">{check.label}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{check.detail}</p>
          </div>
        )) : (
          <p className="text-xs text-muted-foreground">暂无需要处理的环境问题。</p>
        )}
      </div>
    </section>
  );
}

function formatLogTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "--:--";
  }
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function RecentLogsCard({ snapshot, retro }: { snapshot: DesktopSnapshot; retro: boolean }): React.JSX.Element {
  const logs = [...(snapshot.recentLogs ?? [])].slice(-5).reverse();

  return (
    <section className={cn(retro ? "retro-panel grid gap-3 p-4" : "grid gap-3 rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>最近日志</p>
          <p className="text-[11px] text-muted-foreground">桌面与服务最新输出</p>
        </div>
        <ListTree className="size-4 text-primary" />
      </div>
      {logs.length > 0 ? (
        <div className="grid gap-2">
          {logs.map((log) => (
            <div className={cn("min-w-0 border-l-2 pl-2", log.stream === "stderr" ? "border-destructive/70" : "border-primary/60")} key={log.id}>
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="truncate">{log.source} · {log.stream}</span>
                <span className="shrink-0 font-mono">{formatLogTime(log.timestamp)}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed">{log.message}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className={cn("border px-3 py-6 text-center text-xs text-muted-foreground", retro ? "rounded-sm" : "rounded-md")}>
          暂无日志输出
        </div>
      )}
    </section>
  );
}

function PathOverviewCard({ snapshot, retro }: { snapshot: DesktopSnapshot; retro: boolean }): React.JSX.Element {
  const paths = [
    { label: "MaiBot", value: snapshot.paths.maibotRoot },
    { label: "NapCat", value: snapshot.paths.napcatRoot },
    { label: "日志", value: snapshot.paths.logsRoot },
    { label: "用户数据", value: snapshot.paths.userDataRoot },
  ].filter((item) => item.value);

  return (
    <section className={cn(retro ? "retro-panel grid gap-3 p-4" : "grid gap-3 rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>路径概览</p>
          <p className="text-[11px] text-muted-foreground">常用目录快速打开</p>
        </div>
        <FolderOpen className="size-4 text-primary" />
      </div>
      <div className="grid gap-2">
        {paths.map((item) => (
          <button
            className={cn(
              "flex min-w-0 items-center justify-between gap-2 border px-2.5 py-2 text-left text-xs transition-colors hover:border-primary/45 hover:bg-muted/40",
              retro ? "rounded-sm" : "rounded-md",
            )}
            key={item.label}
            onClick={() => void window.maibotDesktop?.openPath(item.value)}
            title={item.value}
            type="button"
          >
            <span className="shrink-0 font-medium">{item.label}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{item.value}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const DAILY_FORTUNES = [
  { title: "适合更新依赖", detail: "今天适合把插件和 WebUI 状态顺手看一眼。", tone: "bg-emerald-500/10 text-emerald-600" },
  { title: "适合整理配置", detail: "路径、账号、端口都清楚的时候，问题会少一半。", tone: "bg-sky-500/10 text-sky-600" },
  { title: "适合先启动再观察", detail: "让服务跑起来，看日志说话。", tone: "bg-violet-500/10 text-violet-600" },
  { title: "适合做个备份", detail: "改配置前留一份副本，心情会稳定很多。", tone: "bg-amber-500/10 text-amber-600" },
  { title: "适合逛逛插件", detail: "也许今天会遇到一个刚好能省事的小插件。", tone: "bg-rose-500/10 text-rose-600" },
];

function dailyFortuneIndex(): number {
  const todayKey = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short" }).format(Date.now());
  let hash = 0;
  for (const char of todayKey) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % DAILY_FORTUNES.length;
}

function DailyFortuneCard({ retro }: { retro: boolean }): React.JSX.Element {
  const fortune = DAILY_FORTUNES[dailyFortuneIndex()];

  return (
    <section className={cn(retro ? "retro-panel grid gap-3 p-4" : "grid gap-3 rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>今日小签</p>
          <p className="text-[11px] text-muted-foreground">每天固定一条轻量提示</p>
        </div>
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-md", fortune.tone)}>
          <WandSparkles className="size-4" />
        </span>
      </div>
      <div className={cn("border px-3 py-3", retro ? "rounded-sm" : "rounded-md bg-muted/25")}>
        <p className="text-sm font-semibold">{fortune.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{fortune.detail}</p>
      </div>
    </section>
  );
}

function ServiceHeartbeatCard({ snapshot, retro }: { snapshot: DesktopSnapshot; retro: boolean }): React.JSX.Element {
  const services = snapshot.services;
  const runningCount = services.filter((service) => service.status === "running").length;

  return (
    <section className={cn(retro ? "retro-panel grid gap-3 p-4" : "grid gap-3 rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>服务心跳</p>
          <p className="text-[11px] text-muted-foreground">{runningCount} / {services.length} 正在运行</p>
        </div>
        <HeartPulse className="size-4 text-primary" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {services.map((service) => (
          <div
            className={cn("flex min-w-0 items-center gap-2 border px-2.5 py-2 text-xs", retro ? "rounded-sm" : "rounded-md")}
            key={service.id}
            title={`${service.name}: ${statusText[service.status]}`}
          >
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                service.status === "running" && "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.6)]",
                service.status === "starting" && "animate-pulse bg-amber-500",
                service.status === "stopping" && "animate-pulse bg-amber-500",
                service.status === "error" && "bg-destructive",
                service.status === "stopped" && "bg-muted-foreground/35",
              )}
            />
            <span className="min-w-0 truncate font-medium">{service.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const SYSTEM_PERFORMANCE_METRIC_OPTIONS: Array<{ key: SystemPerformanceMetricKey; label: string }> = [
  { key: "rings", label: "环形占用" },
  { key: "cpu", label: "CPU" },
  { key: "cores", label: "核心" },
  { key: "memory", label: "内存" },
  { key: "memory-percent", label: "内存占用" },
  { key: "uptime", label: "运行时间" },
  { key: "load", label: "负载" },
  { key: "memory-bar", label: "内存进度条" },
];

function systemPerformanceMetrics(settings: SystemPerformanceCardSettings | undefined): Set<SystemPerformanceMetricKey> {
  const metrics = settings?.visibleMetrics?.length ? settings.visibleMetrics : DEFAULT_SYSTEM_PERFORMANCE_METRICS;
  return new Set(metrics);
}

function SystemPerformanceCard({
  retro,
  settings,
}: {
  retro: boolean;
  settings?: SystemPerformanceCardSettings;
}): React.JSX.Element {
  const [performanceInfo, setPerformanceInfo] = useState<SystemPerformanceSnapshot | null>(null);

  useEffect(() => {
    let disposed = false;
    const loadPerformance = async (): Promise<void> => {
      try {
        const result = await window.maibotDesktop?.getSystemPerformance();
        if (!disposed) setPerformanceInfo(result ?? null);
      } catch {
        if (!disposed) setPerformanceInfo(null);
      }
    };

    void loadPerformance();
    const timer = window.setInterval(() => void loadPerformance(), 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const cpuValue = typeof performanceInfo?.cpuUsagePercent === "number"
    ? `${performanceInfo.cpuUsagePercent.toFixed(0)}%`
    : "采样中";
  const memoryText = performanceInfo
    ? `${formatMemorySize(performanceInfo.memoryTotalBytes - performanceInfo.memoryFreeBytes)} / ${formatMemorySize(performanceInfo.memoryTotalBytes)}`
    : "读取中";
  const cpuPercent = Math.max(0, Math.min(100, performanceInfo?.cpuUsagePercent ?? 0));
  const memoryPercent = Math.max(0, Math.min(100, performanceInfo?.memoryUsedPercent ?? 0));
  const loadText = performanceInfo?.loadAverage.some((value) => value > 0)
    ? performanceInfo.loadAverage.map((value) => value.toFixed(2)).join(" / ")
    : "当前系统不可用";
  const visibleMetrics = systemPerformanceMetrics(settings);
  const metricRing = (label: string, value: string, percent: number): React.JSX.Element => {
    const radius = 34;
    const circumference = 2 * Math.PI * radius;
    const clampedPercent = Math.max(0, Math.min(100, percent));
    return (
      <div className="grid place-items-center gap-1">
        <div className="relative grid size-20 place-items-center">
          <svg aria-hidden className="absolute inset-0 size-20 -rotate-90" viewBox="0 0 80 80">
            <circle className="stroke-border/70" cx="40" cy="40" fill="none" r={radius} strokeWidth="7" />
            <circle
              className="stroke-primary drop-shadow-[0_0_6px_hsl(var(--primary)/0.55)] transition-[stroke-dashoffset]"
              cx="40"
              cy="40"
              fill="none"
              r={radius}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - clampedPercent / 100)}
              strokeLinecap="round"
              strokeWidth="7"
            />
          </svg>
          <div className={cn("z-10 grid size-12 place-items-center rounded-full text-sm font-semibold", retro ? "bg-background/90" : "bg-card")}>
            {value}
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
    );
  };

  return (
    <section className={cn(retro ? "retro-panel grid gap-3 p-4" : "grid gap-3 rounded-lg border border-border bg-card p-3.5")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(retro ? "retro-title text-xl" : "text-sm font-semibold")}>系统性能</p>
          <p className="truncate text-[11px] text-muted-foreground" title={performanceInfo?.cpuModel}>
            {performanceInfo?.cpuModel ?? "正在读取系统状态"}
          </p>
        </div>
        <Cpu className="size-4 text-primary" />
      </div>
      {visibleMetrics.has("rings") ? (
        <div className="grid grid-cols-2 gap-3">
          {metricRing("CPU", cpuValue, cpuPercent)}
          {metricRing("内存", performanceInfo ? `${memoryPercent.toFixed(0)}%` : "--", memoryPercent)}
        </div>
      ) : null}
      {SYSTEM_PERFORMANCE_METRIC_OPTIONS.some((option) => option.key !== "rings" && option.key !== "memory-bar" && visibleMetrics.has(option.key)) ? (
        <div className="grid gap-2 text-xs">
          {visibleMetrics.has("cpu") ? <DetailRow label="CPU" value={cpuValue} retro={retro} /> : null}
          {visibleMetrics.has("cores") ? <DetailRow label="核心" value={performanceInfo ? `${performanceInfo.cpuCores}` : undefined} retro={retro} /> : null}
          {visibleMetrics.has("memory") ? <DetailRow label="内存" value={memoryText} retro={retro} /> : null}
          {visibleMetrics.has("memory-percent") ? <DetailRow label="内存占用" value={performanceInfo ? `${performanceInfo.memoryUsedPercent.toFixed(0)}%` : undefined} retro={retro} /> : null}
          {visibleMetrics.has("uptime") ? <DetailRow label="运行时间" value={formatUptime(performanceInfo?.uptimeSeconds)} retro={retro} /> : null}
          {visibleMetrics.has("load") ? <DetailRow label="负载" value={loadText} retro={retro} /> : null}
        </div>
      ) : null}
      {visibleMetrics.has("memory-bar") ? (
        <div className="h-2 overflow-hidden rounded-sm bg-muted">
          <div
            className="h-full rounded-sm bg-primary transition-[width]"
            style={{ width: `${Math.max(0, Math.min(100, performanceInfo?.memoryUsedPercent ?? 0))}%` }}
          />
        </div>
      ) : null}
    </section>
  );
}

function PluginSurpriseHomeCard({
  active,
  onOpenPluginDetail,
  onOpenPlugins,
  retro,
  settings,
}: {
  active: boolean;
  onOpenPluginDetail: (pluginId: string) => void;
  onOpenPlugins: () => void;
  retro: boolean;
  settings?: PluginSurpriseCardSettings;
}): React.JSX.Element {
  const [plugins, setPlugins] = useState<MarketPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const count = Math.max(1, Math.min(6, settings?.count ?? DEFAULT_PLUGIN_SURPRISE_COUNT));

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchMarketPlugins(undefined, { marketSource: "auto" });
      setPlugins(pickRandomPlugins(result.market, count));
      setLoadedCount(count);
    } catch {
      setPlugins([]);
      setLoadedCount(count);
    } finally {
      setLoading(false);
    }
  }, [count]);

  useEffect(() => {
    if (active && !loading && (plugins.length === 0 || loadedCount !== count)) {
      void loadPlugins();
    }
  }, [active, count, loadPlugins, loadedCount, loading, plugins.length]);

  return (
    <div className={cn(retro ? "retro-panel p-4" : "rounded-xl border border-border bg-card p-4 shadow-sm")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">插件惊喜随心推荐</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">从插件商店随机挑几个看看。</p>
        </div>
        <Button disabled={loading} onClick={() => void loadPlugins()} size="icon-sm" title="换一批" variant="ghost">
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      <div className="mt-3">
        {plugins.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
            {plugins.map((plugin) => (
              <button
                className={cn(
                  "grid min-h-28 w-52 shrink-0 content-between border p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/40",
                  retro ? "rounded-sm border-border/80" : "rounded-md border-border",
                )}
                key={plugin.id}
                onClick={() => onOpenPluginDetail(plugin.id)}
                type="button"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="line-clamp-2 text-sm font-medium leading-snug">{pluginName(plugin)}</span>
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      v{pluginVersion(plugin.manifest)}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                    {pluginDescription(plugin.manifest)}
                  </p>
                </div>
                <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-primary">
                  查看详情
                  <ArrowRight className="size-3" />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className={cn("border px-3 py-6 text-center text-xs text-muted-foreground", retro ? "rounded-sm" : "rounded-md")}>
            {loading ? "正在抽取插件..." : "暂时没有拿到插件推荐"}
          </div>
        )}
      </div>

      <div className="mt-3 flex justify-end">
        <Button onClick={onOpenPlugins} size="sm" variant="secondary">
          <ArrowRight className="size-3.5" />
          打开插件商店
        </Button>
      </div>
    </div>
  );
}

function pickRandomPlugins(plugins: MarketPlugin[], count: number): MarketPlugin[] {
  return [...plugins]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
}

interface DroppedMascot {
  id: number;
  src: string;
  collider: ImageAlphaBounds;
  targetRect?: CollisionRect;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotate: number;
  vr: number;
  lastCollisionAt: number;
  bornAt: number;
}

interface ImageAlphaBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CollisionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const DROP_MAX_ROTATION_SPEED = 4.2;
const DROP_COLLISION_COOLDOWN_MS = 90;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampDropRotation(drop: DroppedMascot): void {
  drop.vr = clamp(drop.vr, -DROP_MAX_ROTATION_SPEED, DROP_MAX_ROTATION_SPEED);
}

function randomDropImage(): string {
  const roll = Math.random() * 100;
  if (roll < 49) return maiDropImage;
  if (roll < 98) return mai2DropImage;
  return emojiDropImage;
}

function randomCollisionTarget(): CollisionRect | undefined {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(".retro-panel, .rounded-lg.border"))
    .filter((element) => !element.closest("[data-drop-layer='true']"))
    .filter((element) => !element.closest("[data-mascot-stage='true']"))
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 36 && rect.height > 28 && rect.top < window.innerHeight && rect.bottom > 0);
  const rect = candidates[Math.floor(Math.random() * candidates.length)];
  return rect
    ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    : undefined;
}

function droppedCollisionRect(drop: DroppedMascot): CollisionRect {
  return {
    left: drop.x + drop.collider.left * drop.size,
    top: drop.y + drop.collider.top * drop.size,
    right: drop.x + drop.collider.right * drop.size,
    bottom: drop.y + drop.collider.bottom * drop.size,
  };
}

function alphaBoundsForImage(src: string): Promise<ImageAlphaBounds> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || canvas.width === 0 || canvas.height === 0) {
        resolve({ left: 0.12, top: 0.12, right: 0.88, bottom: 0.88 });
        return;
      }

      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width;
      let top = canvas.height;
      let right = 0;
      let bottom = 0;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] <= 18) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x + 1);
          bottom = Math.max(bottom, y + 1);
        }
      }

      if (left >= right || top >= bottom) {
        resolve({ left: 0.12, top: 0.12, right: 0.88, bottom: 0.88 });
        return;
      }

      resolve({
        left: left / canvas.width,
        top: top / canvas.height,
        right: right / canvas.width,
        bottom: bottom / canvas.height,
      });
    };
    image.onerror = () => resolve({ left: 0.12, top: 0.12, right: 0.88, bottom: 0.88 });
    image.src = src;
  });
}

function ElasticMascot({
  onLongPress,
  onSecretTap,
  placement = "fixed",
}: {
  onLongPress: () => void;
  onSecretTap: () => void;
  placement?: "fixed" | "retro-column";
}): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const dropIdRef = useRef(0);
  const dropsRef = useRef<DroppedMascot[]>([]);
  const alphaBoundsRef = useRef<Record<string, ImageAlphaBounds>>({});
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
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const [pose, setPose] = useState({
    x: 0,
    y: 0,
    rotate: 0,
    stretch: 0,
    squash: 0,
  });
  const [drops, setDrops] = useState<DroppedMascot[]>([]);

  const kick = useCallback((x: number, y: number, force = 1) => {
    const body = bodyRef.current;
    body.vx += x * force;
    body.vy += y * force;
    body.vr += x * 0.18 * force;
    body.vs += Math.abs(x) * 0.015 * force + Math.abs(y) * 0.01 * force;
    body.vq += y * 0.018 * force;
  }, []);

  const spawnDrop = useCallback((clientX?: number) => {
    const src = randomDropImage();
    const size = 58 + Math.random() * 34;
    const viewportWidth = window.innerWidth || 1024;
    const x = Math.max(8, Math.min(viewportWidth - size - 8, (clientX ?? Math.random() * viewportWidth) - size / 2 + (Math.random() - 0.5) * 90));
    const diagonalDirection = Math.random() < 0.5 ? -1 : 1;
    const nextDrop: DroppedMascot = {
      id: dropIdRef.current++,
      src,
      collider: alphaBoundsRef.current[src] ?? { left: 0.12, top: 0.12, right: 0.88, bottom: 0.88 },
      targetRect: randomCollisionTarget(),
      x,
      y: -size - 12,
      vx: diagonalDirection * (1.5 + Math.random() * 2.2),
      vy: 1 + Math.random() * 2,
      size,
      rotate: (Math.random() - 0.5) * 32,
      vr: (Math.random() - 0.5) * 3.6,
      lastCollisionAt: 0,
      bornAt: performance.now(),
    };
    dropsRef.current = [...dropsRef.current, nextDrop];
    setDrops(dropsRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([maiDropImage, mai2DropImage, emojiDropImage].map(async (src) => [src, await alphaBoundsForImage(src)] as const))
      .then((entries) => {
        if (!cancelled) {
          alphaBoundsRef.current = Object.fromEntries(entries);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = performance.now();
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

      const currentDrops = dropsRef.current;
      if (currentDrops.length > 0) {
        const width = window.innerWidth || 1024;
        const height = window.innerHeight || 768;
        const nextDrops = currentDrops
          .map((drop) => ({ ...drop }))
          .filter((drop) => now - drop.bornAt < 10_000 && drop.y < height + drop.size * 2 && drop.x > -drop.size * 2 && drop.x < width + drop.size * 2);

        for (const drop of nextDrops) {
          drop.vy += 0.42;
          drop.vx *= 0.992;
          drop.vy *= 0.995;
          drop.vr *= 0.965;
          clampDropRotation(drop);
          drop.x += drop.vx;
          drop.y += drop.vy;
          drop.rotate += drop.vr;

          if (drop.x < 0) {
            drop.x = 0;
            drop.vx = Math.abs(drop.vx) * 0.72;
            drop.vr += drop.vx * 0.12;
            clampDropRotation(drop);
          } else if (drop.x + drop.size > width) {
            drop.x = width - drop.size;
            drop.vx = -Math.abs(drop.vx) * 0.72;
            drop.vr += drop.vx * 0.12;
            clampDropRotation(drop);
          }

          const rect = drop.targetRect;
          if (rect) {
            if (now - drop.lastCollisionAt < DROP_COLLISION_COOLDOWN_MS) continue;
            const collision = droppedCollisionRect(drop);
            const overlaps =
              collision.left < rect.right
              && collision.right > rect.left
              && collision.top < rect.bottom
              && collision.bottom > rect.top;
            if (!overlaps) continue;

            const fromTop = Math.abs(collision.bottom - rect.top);
            const fromBottom = Math.abs(rect.bottom - collision.top);
            const fromLeft = Math.abs(collision.right - rect.left);
            const fromRight = Math.abs(rect.right - collision.left);
            const min = Math.min(fromTop, fromBottom, fromLeft, fromRight);
            if (min === fromTop && drop.vy > 0) {
              drop.y = rect.top - drop.collider.bottom * drop.size;
              drop.vy = -Math.abs(drop.vy) * (0.42 + Math.random() * 0.18);
              drop.vx += (Math.random() - 0.5) * 3;
            } else if (min === fromBottom && drop.vy < 0) {
              drop.y = rect.bottom - drop.collider.top * drop.size;
              drop.vy = Math.abs(drop.vy) * 0.35;
            } else if (min === fromLeft) {
              drop.x = rect.left - drop.collider.right * drop.size;
              drop.vx = -Math.abs(drop.vx) * 0.62;
            } else {
              drop.x = rect.right - drop.collider.left * drop.size;
              drop.vx = Math.abs(drop.vx) * 0.62;
            }
            drop.vr = drop.vr * 0.68 + drop.vx * 0.08;
            drop.lastCollisionAt = now;
            clampDropRotation(drop);
          }
        }

        for (let index = 0; index < nextDrops.length; index++) {
          for (let otherIndex = index + 1; otherIndex < nextDrops.length; otherIndex++) {
            const left = nextDrops[index];
            const right = nextDrops[otherIndex];
            const leftRect = droppedCollisionRect(left);
            const rightRect = droppedCollisionRect(right);
            if (
              leftRect.left < rightRect.right
              && leftRect.right > rightRect.left
              && leftRect.top < rightRect.bottom
              && leftRect.bottom > rightRect.top
            ) {
              const leftCenterX = (leftRect.left + leftRect.right) / 2;
              const leftCenterY = (leftRect.top + leftRect.bottom) / 2;
              const rightCenterX = (rightRect.left + rightRect.right) / 2;
              const rightCenterY = (rightRect.top + rightRect.bottom) / 2;
              const dx = leftCenterX - rightCenterX || 1;
              const dy = leftCenterY - rightCenterY || 1;
              const distance = Math.max(1, Math.hypot(dx, dy));
              const push = 0.8;
              left.vx += (dx / distance) * push;
              left.vy += (dy / distance) * push;
              right.vx -= (dx / distance) * push;
              right.vy -= (dy / distance) * push;
              if (now - left.lastCollisionAt >= DROP_COLLISION_COOLDOWN_MS) {
                left.vr = left.vr * 0.72 + left.vx * 0.06;
                left.lastCollisionAt = now;
                clampDropRotation(left);
              }
              if (now - right.lastCollisionAt >= DROP_COLLISION_COOLDOWN_MS) {
                right.vr = right.vr * 0.72 + right.vx * 0.06;
                right.lastCollisionAt = now;
                clampDropRotation(right);
              }
            }
          }
        }

        dropsRef.current = nextDrops;
        setDrops(nextDrops);
      }
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

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const onPointerLeave = useCallback(() => {
    clearLongPress();
    pointerRef.current.t = 0;
    kick(4, 2, 0.8);
  }, [clearLongPress, kick]);

  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    spawnDrop(event.clientX);
    kick((Math.random() - 0.5) * 8, -7, 1.1);
    onSecretTap();
  }, [kick, onSecretTap, spawnDrop]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    spawnDrop();
    kick((Math.random() - 0.5) * 8, -7, 1.1);
    onSecretTap();
  }, [kick, onSecretTap, spawnDrop]);

  const onPointerDown = useCallback(() => {
    clearLongPress();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      onLongPress();
    }, 650);
  }, [clearLongPress, onLongPress]);

  const onPointerUp = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const stretch = Math.max(-0.1, Math.min(0.16, pose.stretch));
  const squash = Math.max(-0.12, Math.min(0.12, pose.squash));
  const rotate = Math.max(-9, Math.min(9, pose.rotate));
  const x = Math.max(-22, Math.min(22, pose.x));
  const y = Math.max(-18, Math.min(18, pose.y));
  const mascotImage = placement === "retro-column" ? futureRetroMascotImage : maiMascotImage;
  const mascotDirection = placement === "retro-column" ? -1 : 1;
  const mascotTransformOrigin = placement === "retro-column" ? "0 0" : "82% 86%";
  const mascotOffsetX = placement === "retro-column" ? `${164 + stretch * 82}%` : "0px";
  const mascotOffsetY = placement === "retro-column" ? `${stretch * 47.3}%` : "0px";

  return (
    <div
      aria-label="MaiBot 形象"
      className={cn(
        "z-20 hidden h-28 w-32 overflow-hidden md:block",
        placement === "retro-column" ? "retro-mascot-frame relative self-start" : "fixed",
      )}
      data-mascot-stage="true"
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerCancel={onPointerUp}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={stageRef}
      role="button"
      style={placement === "fixed"
        ? {
          right: "max(4px, calc(var(--app-window-radius, 16px) * 0.28))",
          bottom: "max(4px, calc(var(--app-window-radius, 16px) * 0.28))",
        }
        : undefined}
      tabIndex={0}
    >
      <img
        alt=""
        className={cn(
          "pointer-events-none absolute bottom-[-40px] w-32 select-none",
          placement === "retro-column" ? "right-14" : "right-[-46px]",
        )}
        draggable={false}
        src={mascotImage}
        style={{
          transform: `translate3d(calc(${x}px + ${mascotOffsetX}), calc(${y}px + ${mascotOffsetY}), 0) rotate(${rotate}deg) skew(${squash * 12}deg, ${-squash * 7}deg) scale(${mascotDirection * (1 + stretch)}, ${1 - stretch * 0.55})`,
          transformOrigin: mascotTransformOrigin,
          transition: "filter 160ms ease",
        }}
      />
      {drops.length > 0 ? (
        <div className="pointer-events-none fixed inset-0 z-50 overflow-visible" data-drop-layer="true">
          {drops.map((drop) => (
            <img
              alt=""
              className="absolute select-none drop-shadow-lg"
              draggable={false}
              key={drop.id}
              src={drop.src}
              style={{
                height: drop.size,
                left: 0,
                top: 0,
                transform: `translate3d(${drop.x}px, ${drop.y}px, 0) rotate(${drop.rotate}deg)`,
                width: drop.size,
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function HomePanel({
  active,
  snapshot,
  onSnapshot,
  onOpenTab,
  onOpenPluginConfig,
  onOpenPluginDetail,
  onEnterFloatingMode,
  onRestartService,
  onStartService,
  onStopService,
  serviceActionBusy,
}: {
  active: boolean;
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
  onOpenTab: (tab: string) => void;
  onOpenPluginConfig: (pluginId: string) => void;
  onOpenPluginDetail: (pluginId: string) => void;
  onEnterFloatingMode: () => void;
  onRestartService: (id: ServiceId) => void;
  onStartService: (id: ServiceId) => void;
  onStopService: (id: ServiceId) => void;
  serviceActionBusy: string | null;
}): React.JSX.Element {
  const [updateDialog, setUpdateDialog] = useState<"launcher" | "maibot" | "dashboard" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launcherUpdateInfo, setLauncherUpdateInfo] = useState<LauncherUpdateInfo | null>(null);
  const [messagePlatformDialogOpen, setMessagePlatformDialogOpen] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [mascotIntroOpen, setMascotIntroOpen] = useState(false);
  const [, setMascotClickCount] = useState(0);
  const [messagePlatformBackend, setMessagePlatformBackend] = useState<QqBackend>("napcat");
  const [messagePlatformAccount, setMessagePlatformAccount] = useState(snapshot.initState.qqAccount ?? "");
  const [maibotChannel, setMaibotChannel] = useState<MaiBotUpdateChannel>("stable");
  const [napcatWebuiOpen, setNapcatWebuiOpen] = useState(false);
  const [qqWebuiPort, setQqWebuiPort] = useState(() => readQqWebuiPort(snapshot.initState.qqBackend ?? "napcat"));
  const [moduleSourceConfig, setModuleSourceConfig] = useState<ModuleSourceConfig | null>(null);
  const [moduleSourceExpanded, setModuleSourceExpanded] = useState(false);
  const [moduleSourceSaving, setModuleSourceSaving] = useState(false);
  const [moduleSourcePreset, setModuleSourcePreset] = useState<ModuleSourcePreset>("auto");
  const [maibotBranches, setMaibotBranches] = useState<ModuleBranchOption[]>([]);
  const [maibotTags, setMaibotTags] = useState<ModuleTagOption[]>([]);
  const [maibotRefsLoading, setMaibotRefsLoading] = useState(false);
  const [selectedMaiBotBranch, setSelectedMaiBotBranch] = useState("main");
  const [selectedMaiBotTag, setSelectedMaiBotTag] = useState("");
  const [homeContentLayout, setHomeContentLayout] = useState<HomeContentEntry[]>(() => readHomeContentLayout());
  const [homeLayoutEditing, setHomeLayoutEditing] = useState(false);
  const [draggingHomeEntryId, setDraggingHomeEntryId] = useState<string | null>(null);
  const [homeDragOffset, setHomeDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [homeInsertIndicator, setHomeInsertIndicator] = useState<{ area: HomeContentArea; index: number } | null>(null);
  const homeDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const appearance = useAppearance();
  const useRetroHome = appearance.mode === "future-retro";
  const services = snapshot.services ?? [];
  const maibot = services.find((service) => service.id === "maibot");
  const napcat = services.find((service) => service.id === "napcat");
  const adapterPluginId = adapterPluginIdForBackend(snapshot.initState.qqBackend ?? "napcat");
  const adapterName = snapshot.initState.qqBackend === "snowluma" ? "SnowLuma 适配器" : "NapCat 适配器";
  const qqBackend = snapshot.initState.qqBackend ?? "napcat";
  const currentQqWebuiUrl = qqWebuiUrl(napcat?.url, qqBackend, qqWebuiPort);
  const messagePlatformConfigured =
    snapshot.initState.messagePlatformConfigured && Boolean(snapshot.initState.qqAccount?.trim());
  const qqBackendBusy =
    napcat?.status === "starting" || napcat?.status === "running" || napcat?.status === "stopping" || Boolean(napcat?.managed);
  const maibotUpdateBlocked =
    maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping";
  const launcherCurrentTag = versionAsTag(launcherUpdateInfo?.currentVersion ?? snapshot.appVersion);
  const launcherLatestTag =
    launcherUpdateInfo?.latestTag
    ?? versionAsTag(launcherUpdateInfo?.latestVersion)
    ?? snapshot.appLatestTag;
  const launcherUpdateAvailable =
    launcherUpdateInfo?.available ?? (compareVersionText(launcherLatestTag, launcherCurrentTag) > 0);

  const maibotTargets: Record<MaiBotUpdateChannel, string | undefined> = {
    stable: snapshot.moduleVersions.maibotLatestStableTag,
    other: selectedMaiBotTag
      ? `Tag ${selectedMaiBotTag}`
      : selectedMaiBotBranch
        ? `分支 ${selectedMaiBotBranch}`
        : undefined,
  };
  const dashboardTarget = snapshot.moduleVersions.dashboardLatestStablePypi ?? snapshot.moduleVersions.dashboardLatestPypi;

  const handleMascotSecretTap = useCallback(() => {
    if (mascotIntroShownThisSession) {
      return;
    }

    setMascotClickCount((current) => {
      const next = current + 1;
      if (next >= MASCOT_INTRO_TRIGGER_CLICKS) {
        mascotIntroShownThisSession = true;
        setMascotIntroOpen(true);
        return 0;
      }
      return next;
    });
  }, []);

  const refreshSnapshot = useCallback(async () => {
    if (!window.maibotDesktop) {
      return;
    }
    onSnapshot(await window.maibotDesktop.getSnapshot());
  }, [onSnapshot]);

  useEffect(() => {
    const syncQqWebuiPort = (): void => {
      setQqWebuiPort(readQqWebuiPort(snapshot.initState.qqBackend ?? "napcat"));
    };

    syncQqWebuiPort();
    window.addEventListener(QQ_WEBUI_PORT_CHANGE_EVENT, syncQqWebuiPort);
    window.addEventListener("storage", syncQqWebuiPort);
    return () => {
      window.removeEventListener(QQ_WEBUI_PORT_CHANGE_EVENT, syncQqWebuiPort);
      window.removeEventListener("storage", syncQqWebuiPort);
    };
  }, [snapshot.initState.qqBackend]);

  useEffect(() => {
    const syncHomeContentLayout = (event?: Event): void => {
      if (event instanceof CustomEvent && Array.isArray(event.detail)) {
        setHomeContentLayout(event.detail as HomeContentEntry[]);
        return;
      }
      setHomeContentLayout(readHomeContentLayout());
    };

    window.addEventListener(HOME_CONTENT_LAYOUT_CHANGE_EVENT, syncHomeContentLayout);
    window.addEventListener("storage", syncHomeContentLayout);
    return () => {
      window.removeEventListener(HOME_CONTENT_LAYOUT_CHANGE_EVENT, syncHomeContentLayout);
      window.removeEventListener("storage", syncHomeContentLayout);
    };
  }, []);

  const loadModuleSourceConfig = useCallback(async () => {
    if (!window.maibotDesktop?.modules) {
      return;
    }

    const config = await window.maibotDesktop.modules.getSourceConfig();
    setModuleSourceConfig(config);
    setModuleSourcePreset(config.preset);
  }, []);

  const reloadModuleSourceOptions = useCallback(async () => {
    if (!window.maibotDesktop?.modules) {
      return;
    }

    const currentPreset = moduleSourcePreset;
    const config = await window.maibotDesktop.modules.getSourceConfig();
    const currentOption = config.options.find((option) => option.preset === currentPreset);
    setModuleSourceConfig(config);
    setModuleSourcePreset(currentOption ? currentPreset : config.preset);
  }, [moduleSourcePreset]);

  const saveModuleSourceConfig = useCallback(async (preset = moduleSourcePreset): Promise<ModuleSourceConfig> => {
    if (!window.maibotDesktop?.modules) {
      throw new Error("桌面桥未就绪，无法保存模块更新源");
    }

    setModuleSourceSaving(true);
    try {
      const config = await window.maibotDesktop.modules.saveSourceConfig({
        preset,
      });
      setModuleSourceConfig(config);
      setModuleSourcePreset(config.preset);
      setError(null);
      return config;
    } finally {
      setModuleSourceSaving(false);
    }
  }, [moduleSourcePreset]);

  const loadMaiBotRefs = useCallback(async () => {
    if (!window.maibotDesktop?.modules || maibotRefsLoading) {
      return;
    }

    setMaibotRefsLoading(true);
    try {
      if (moduleSourceConfig) {
        await saveModuleSourceConfig();
      }
      const [branches, tags] = await Promise.all([
        window.maibotDesktop.modules.listMaiBotBranches(),
        window.maibotDesktop.modules.listMaiBotTags(),
      ]);
      setMaibotBranches(branches);
      setMaibotTags(tags);
      setSelectedMaiBotBranch((current) => {
        if (current && branches.some((branch) => branch.name === current)) {
          return current;
        }
        return branches.find((branch) => branch.name === "main")?.name ?? branches[0]?.name ?? "";
      });
      setSelectedMaiBotTag((current) => (
        current && tags.some((tag) => tag.name === current) ? current : ""
      ));
    } catch (nextError) {
      setError(messageFromError(nextError));
      setMaibotBranches([]);
      setMaibotTags([]);
      setSelectedMaiBotBranch("");
      setSelectedMaiBotTag("");
    } finally {
      setMaibotRefsLoading(false);
    }
  }, [maibotRefsLoading, moduleSourceConfig, saveModuleSourceConfig]);

  const openMaiBotUpdate = useCallback(() => {
    setError(null);
    setModuleSourceExpanded(false);
    setMaibotChannel(snapshot.moduleVersions.maibotLatestStableTag ? "stable" : "other");
    setUpdateDialog("maibot");
    void loadModuleSourceConfig().catch((nextError: unknown) => {
      setError(messageFromError(nextError));
    });
    void loadMaiBotRefs();
  }, [
    loadMaiBotRefs,
    loadModuleSourceConfig,
    snapshot.moduleVersions.maibotLatestStableTag,
  ]);

  const openLauncherUpdate = useCallback(() => {
    setError(null);
    setUpdateDialog("launcher");
  }, []);

  const openLauncherRelease = useCallback(() => {
    const releaseUrl = launcherUpdateInfo?.releaseUrl?.trim();
    if (releaseUrl) {
      void window.maibotDesktop?.openExternal(releaseUrl);
      return;
    }

    const tag = launcherLatestTag?.trim();
    const url = tag
      ? `https://github.com/Mai-with-u/MaiBotOneKey/releases/tag/${encodeURIComponent(tag)}`
      : "https://github.com/Mai-with-u/MaiBotOneKey/releases";
    void window.maibotDesktop?.openExternal(url);
  }, [launcherLatestTag, launcherUpdateInfo?.releaseUrl]);

  const checkLauncherUpdate = useCallback(async () => {
    if (!window.maibotDesktop?.launcher) {
      setError("桌面桥未就绪，无法检查启动器更新");
      return;
    }

    setBusy("launcher:check");
    setError(null);
    try {
      const update = await window.maibotDesktop.launcher.checkUpdate();
      setLauncherUpdateInfo(update);
      toast.success(update.available
        ? `发现新版本 ${update.latestTag ?? update.latestVersion ?? ""}`
        : "启动器已是最新版本");
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const installLauncherUpdate = useCallback(async () => {
    if (!window.maibotDesktop?.launcher) {
      setError("桌面桥未就绪，无法安装启动器更新");
      return;
    }

    setBusy("launcher:update");
    setError(null);
    try {
      const result = await window.maibotDesktop.launcher.downloadAndInstallUpdate();
      setLauncherUpdateInfo(result.update);
      toast.success(result.willQuit ? "安装器已启动，启动器即将退出" : "安装器已启动");
    } catch (nextError) {
      setError(messageFromError(nextError));
      setBusy(null);
    }
  }, []);

  const openMessagePlatformDialog = useCallback(() => {
    setError(null);
    setMessagePlatformBackend(snapshot.initState.qqBackend ?? "napcat");
    setMessagePlatformAccount(snapshot.initState.qqAccount ?? "");
    setMessagePlatformDialogOpen(true);
  }, [snapshot.initState.qqAccount, snapshot.initState.qqBackend]);

  useEffect(() => {
    const openRequestedGuide = (): void => {
      try {
        if (localStorage.getItem(MESSAGE_PLATFORM_GUIDE_REQUEST_KEY) !== "1") {
          return;
        }
        localStorage.removeItem(MESSAGE_PLATFORM_GUIDE_REQUEST_KEY);
      } catch {
        // Local storage may be unavailable in isolated previews.
      }
      openMessagePlatformDialog();
    };

    openRequestedGuide();
    window.addEventListener("maibot:open-message-platform-guide", openRequestedGuide);
    return () => {
      window.removeEventListener("maibot:open-message-platform-guide", openRequestedGuide);
    };
  }, [openMessagePlatformDialog]);

  const setupMessagePlatform = useCallback(async () => {
    const qqAccount = messagePlatformAccount.trim();
    if (!/^\d+$/u.test(qqAccount)) {
      setError("请输入正确的 QQ 号");
      return;
    }
    if (!window.maibotDesktop) {
      setError("桌面桥未就绪，无法初始化消息平台");
      return;
    }

    setBusy("message-platform:setup");
    setError(null);
    try {
      await window.maibotDesktop.init.setQqAccount({
        qqAccount,
        qqBackend: messagePlatformBackend,
      });
      await window.maibotDesktop.init.repair();
      await window.maibotDesktop.services.start("napcat");
      toast.success(`${messagePlatformBackend === "snowluma" ? "QQ-SnowLuma" : "QQ-NapCat"} 已配置并启动`);
      setMessagePlatformDialogOpen(false);
      await refreshSnapshot();
      markAdapterConfigPrompted(messagePlatformBackend);
      window.setTimeout(() => onOpenPluginConfig(adapterPluginIdForBackend(messagePlatformBackend)), 250);
    } catch (nextError) {
      setError(messageFromError(nextError));
      await refreshSnapshot().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }, [messagePlatformAccount, messagePlatformBackend, onOpenPluginConfig, refreshSnapshot]);

  const updateMaiBot = useCallback(async () => {
    const target: ModuleUpdateTarget | undefined =
      maibotChannel === "stable" && maibotTargets.stable
        ? { type: "tag", name: maibotTargets.stable }
        : maibotChannel === "other" && selectedMaiBotTag
            ? { type: "tag", name: selectedMaiBotTag }
            : maibotChannel === "other" && selectedMaiBotBranch
              ? { type: "branch", name: selectedMaiBotBranch }
              : undefined;
    if (!window.maibotDesktop?.modules || !target) {
      setError("没有可用的目标版本");
      return;
    }

    setBusy("maibot:update");
    setError(null);
    try {
      await saveModuleSourceConfig();
      await window.maibotDesktop.modules.updateMaiBot(target);
      toast.success("MaiBot 更新完成");
      setUpdateDialog(null);
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [
    maibotChannel,
    maibotTargets.stable,
    refreshSnapshot,
    saveModuleSourceConfig,
    selectedMaiBotBranch,
    selectedMaiBotTag,
  ]);

  const updateDashboard = useCallback(async () => {
    const target = dashboardTarget;
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
  }, [dashboardTarget, refreshSnapshot]);

  const renderHomeContentCard = useCallback((entry: HomeContentEntry): React.ReactNode => {
    switch (entry.type) {
      case "maibot-overview":
        return (
          <MaiBotOverviewCard
            latestStable={snapshot.moduleVersions.maibotLatestStableTag}
            localVersion={snapshot.moduleVersions.maibotLocal}
            onUpdate={openMaiBotUpdate}
            retro={useRetroHome}
            service={maibot}
            updateBusy={busy === "maibot:update"}
          />
        );
      case "local-chat":
        return (
          <LocalChatQuickCard
            active={active}
            maibotService={maibot}
            onOpenFull={() => onOpenTab("localchat")}
            retro={useRetroHome}
          />
        );
      case "message-platform":
        return messagePlatformConfigured ? (
          <ServiceSummary
            adapterAction={{
              title: `${adapterName.replace(/\s+/gu, "")}设置`,
              label: "打开配置",
              onClick: () => onOpenPluginConfig(adapterPluginId),
            }}
            icon={null}
            retro={useRetroHome}
            service={napcat}
            serviceControls={napcat ? {
              busy: serviceActionBusy?.startsWith(`${napcat.id}:`) ?? false,
              onRestart: onRestartService,
              onStart: onStartService,
              onStop: onStopService,
            } : undefined}
            webuiAction={{
              title: `${napcat?.name ?? "NapCat"} 设置`,
              label: "打开 WebUI",
              onClick: () => setNapcatWebuiOpen(true),
            }}
          />
        ) : (
          <MessagePlatformConnectCard onClick={openMessagePlatformDialog} retro={useRetroHome} />
        );
      case "launcher-update":
        return (
          <LauncherUpdateCard
            appVersion={snapshot.appVersion}
            latestTag={launcherLatestTag}
            onUpdate={openLauncherUpdate}
            retro={useRetroHome}
            updateBusy={busy === "launcher:check" || busy === "launcher:update"}
          />
        );
      case "official-docs":
        return <OfficialDocsCard retro={useRetroHome} />;
      case "stats":
        return (
          <StatsInfoCard retro={useRetroHome} snapshot={snapshot} />
        );
      case "quick-actions":
        return <QuickActionsCard onOpenQuickActions={() => setQuickActionsOpen(true)} retro={useRetroHome} />;
      case "system-performance":
        return <SystemPerformanceCard retro={useRetroHome} settings={entry.settings as SystemPerformanceCardSettings | undefined} />;
      case "plugin-surprise":
        return (
          <PluginSurpriseHomeCard
            active={active}
            onOpenPluginDetail={onOpenPluginDetail}
            onOpenPlugins={() => onOpenTab("pluginmarket")}
            retro={useRetroHome}
            settings={entry.settings as PluginSurpriseCardSettings | undefined}
          />
        );
      case "environment-health":
        return <EnvironmentHealthCard retro={useRetroHome} snapshot={snapshot} />;
      case "recent-logs":
        return <RecentLogsCard retro={useRetroHome} snapshot={snapshot} />;
      case "path-overview":
        return <PathOverviewCard retro={useRetroHome} snapshot={snapshot} />;
      case "daily-fortune":
        return <DailyFortuneCard retro={useRetroHome} />;
      case "service-heartbeat":
        return <ServiceHeartbeatCard retro={useRetroHome} snapshot={snapshot} />;
      default:
        return null;
    }
  }, [
    active,
    adapterName,
    adapterPluginId,
    busy,
    launcherLatestTag,
    maibot,
    messagePlatformConfigured,
    napcat,
    onOpenPluginConfig,
    onOpenPluginDetail,
    onOpenTab,
    onRestartService,
    onStartService,
    onStopService,
    openLauncherUpdate,
    openMaiBotUpdate,
    qqWebuiPort,
    serviceActionBusy,
    snapshot,
    useRetroHome,
  ]);

  const homeContentCards = useMemo(
    () => homeContentLayout.map((entry) => ({
      ...entry,
      content: renderHomeContentCard(entry),
    })).filter((entry) => entry.content !== null),
    [homeContentLayout, renderHomeContentCard],
  );
  const mainHomeContentCards = homeContentCards.filter((entry) => entry.area === "main");
  const sideHomeContentCards = homeContentCards.filter((entry) => entry.area === "side");
  const enabledHomeContentTypes = new Set(homeContentLayout.map((entry) => entry.type));
  const addableHomeContentOptions = HOME_CONTENT_CARD_OPTIONS.filter((option) => !enabledHomeContentTypes.has(option.type));

  const persistHomeContentLayout = useCallback((layout: HomeContentEntry[]) => {
    setHomeContentLayout(saveHomeContentLayout(layout));
  }, []);

  const moveHomeContentEntry = useCallback((entryId: string, targetArea: HomeContentArea, targetIndex: number) => {
    const sourceIndex = homeContentLayout.findIndex((entry) => entry.id === entryId);
    if (sourceIndex < 0) {
      return;
    }
    const sourceEntry = homeContentLayout[sourceIndex];
    const sourceAreaIndex = homeContentLayout.filter((entry) => entry.area === sourceEntry.area).findIndex((entry) => entry.id === entryId);
    if (
      sourceEntry.area === targetArea &&
      (targetIndex === sourceAreaIndex || targetIndex === sourceAreaIndex + 1)
    ) {
      return;
    }
    const nextLayout = [...homeContentLayout];
    const [entry] = nextLayout.splice(sourceIndex, 1);
    const adjustedTargetIndex = sourceEntry.area === targetArea && targetIndex > sourceAreaIndex
      ? targetIndex - 1
      : targetIndex;
    const targetEntries = nextLayout.filter((item) => item.area === targetArea);
    const beforeTarget = targetEntries.slice(0, adjustedTargetIndex);
    const insertIndex = beforeTarget.length === 0
      ? nextLayout.findIndex((item) => item.area === targetArea)
      : nextLayout.findIndex((item) => item.id === beforeTarget[beforeTarget.length - 1]?.id) + 1;
    nextLayout.splice(insertIndex < 0 ? nextLayout.length : insertIndex, 0, { ...entry, area: targetArea });
    persistHomeContentLayout(nextLayout);
  }, [homeContentLayout, persistHomeContentLayout]);

  const removeHomeContentEntry = useCallback((entryId: string) => {
    if (homeContentLayout.length <= 1) {
      return;
    }
    persistHomeContentLayout(homeContentLayout.filter((entry) => entry.id !== entryId));
  }, [homeContentLayout, persistHomeContentLayout]);

  const addHomeContentEntry = useCallback((type: HomeContentCardType, area: HomeContentArea) => {
    if (enabledHomeContentTypes.has(type)) {
      return;
    }
    persistHomeContentLayout([...homeContentLayout, createHomeContentEntry(type, area)]);
  }, [enabledHomeContentTypes, homeContentLayout, persistHomeContentLayout]);

  const resetHomeContentLayoutToDefault = useCallback(() => {
    setHomeContentLayout(resetHomeContentLayout());
  }, []);

  const updateHomeContentWidth = useCallback((entryId: string, width: HomeContentWidth) => {
    persistHomeContentLayout(homeContentLayout.map((entry) => entry.id === entryId ? { ...entry, width } : entry));
  }, [homeContentLayout, persistHomeContentLayout]);

  const updateHomeContentSettings = useCallback((entryId: string, settings: HomeContentEntry["settings"]) => {
    persistHomeContentLayout(homeContentLayout.map((entry) => entry.id === entryId ? { ...entry, settings } : entry));
  }, [homeContentLayout, persistHomeContentLayout]);

  const toggleSystemPerformanceMetric = useCallback((entry: HomeContentEntry, metric: SystemPerformanceMetricKey, checked: boolean) => {
    const current = systemPerformanceMetrics(entry.settings as SystemPerformanceCardSettings | undefined);
    if (checked) {
      current.add(metric);
    } else if (current.size > 1) {
      current.delete(metric);
    }
    updateHomeContentSettings(entry.id, { visibleMetrics: DEFAULT_SYSTEM_PERFORMANCE_METRICS.filter((item) => current.has(item)) });
  }, [updateHomeContentSettings]);

  const updatePluginSurpriseCount = useCallback((entryId: string, count: number) => {
    updateHomeContentSettings(entryId, { count: Math.max(1, Math.min(6, Math.round(count))) });
  }, [updateHomeContentSettings]);

  const isHomeInsertNoop = useCallback((entryId: string, targetArea: HomeContentArea, targetIndex: number) => {
    const sourceIndex = homeContentLayout.findIndex((entry) => entry.id === entryId);
    const source = homeContentLayout[sourceIndex];
    if (!source || source.area !== targetArea) {
      return false;
    }
    const sourceAreaIndex = homeContentLayout.slice(0, sourceIndex).filter((entry) => entry.area === targetArea).length;
    return targetIndex === sourceAreaIndex || targetIndex === sourceAreaIndex + 1;
  }, [homeContentLayout]);

  const renderHomeCardSettings = useCallback((entry: HomeContentEntry): React.ReactNode => {
    if (entry.type === "system-performance") {
      const visibleMetrics = systemPerformanceMetrics(entry.settings as SystemPerformanceCardSettings | undefined);
      return (
        <div className="grid gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            <Settings className="size-3" />
            系统性能
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {SYSTEM_PERFORMANCE_METRIC_OPTIONS.map((option) => (
              <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" key={option.key}>
                <input
                  checked={visibleMetrics.has(option.key)}
                  className="size-3 accent-primary"
                  disabled={visibleMetrics.size <= 1 && visibleMetrics.has(option.key)}
                  onChange={(event) => toggleSystemPerformanceMetric(entry, option.key, event.target.checked)}
                  type="checkbox"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      );
    }

    if (entry.type === "plugin-surprise") {
      const settings = entry.settings as PluginSurpriseCardSettings | undefined;
      const count = settings?.count ?? DEFAULT_PLUGIN_SURPRISE_COUNT;
      return (
        <div className="grid gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            <Settings className="size-3" />
            插件推荐
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            显示数量
            <select
              className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onChange={(event) => updatePluginSurpriseCount(entry.id, Number(event.target.value))}
              value={count}
            >
              {[1, 2, 3, 4, 5, 6].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
      );
    }

    return null;
  }, [toggleSystemPerformanceMetric, updatePluginSurpriseCount]);

  const renderHomeEditableCard = useCallback((
    entry: HomeContentEntry & { content: React.ReactNode },
    areaEntries: Array<HomeContentEntry & { content: React.ReactNode }>,
    area: HomeContentArea,
    index: number,
  ): React.JSX.Element => {
    const effectiveWidth = entry.width ?? "full";
    const dragStyle = draggingHomeEntryId === entry.id && homeDragOffset
      ? { transform: `translate3d(${homeDragOffset.x}px, ${homeDragOffset.y}px, 0)` }
      : undefined;
    const cardSettings = renderHomeCardSettings(entry);

    return (
    <div
      className={cn(
        "group/home-card relative min-w-0 transition-[opacity,transform,grid-column,max-width]",
        area === "main" && (effectiveWidth === "half" ? "md:col-span-1" : "md:col-span-2"),
        homeLayoutEditing && "rounded-md outline outline-1 outline-dashed outline-primary/35",
        draggingHomeEntryId === entry.id && "pointer-events-none z-50 opacity-80 shadow-2xl transition-none",
      )}
      key={entry.id}
      style={dragStyle}
      data-home-card-entry="true"
      data-home-card-area={area}
      data-home-card-index={index}
      onPointerDown={(event) => {
        if (!homeLayoutEditing || event.button !== 0) return;
        if ((event.target as HTMLElement).closest("[data-home-resize-handle='true'], [data-home-card-control='true']")) return;
        homeDragStartRef.current = { x: event.clientX, y: event.clientY };
        setHomeDragOffset({ x: 0, y: 0 });
        setDraggingHomeEntryId(entry.id);
        setHomeInsertIndicator(null);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!homeLayoutEditing || draggingHomeEntryId !== entry.id) return;
        if (homeDragStartRef.current) {
          setHomeDragOffset({
            x: event.clientX - homeDragStartRef.current.x,
            y: event.clientY - homeDragStartRef.current.y,
          });
        }
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        const target = hit?.closest<HTMLElement>("[data-home-card-entry='true']");
        if (!target) {
          const dropArea = hit?.closest<HTMLElement>("[data-home-drop-area]");
          const targetArea = dropArea?.dataset.homeDropArea as HomeContentArea | undefined;
          if (targetArea === "main" || targetArea === "side") {
            const nextIndex = targetArea === "main" ? mainHomeContentCards.length : sideHomeContentCards.length;
            setHomeInsertIndicator(
              isHomeInsertNoop(entry.id, targetArea, nextIndex)
                ? null
                : { area: targetArea, index: nextIndex },
            );
          }
          return;
        }
        const targetArea = target.dataset.homeCardArea as HomeContentArea | undefined;
        const rawIndex = Number(target.dataset.homeCardIndex);
        if ((targetArea !== "main" && targetArea !== "side") || !Number.isFinite(rawIndex)) return;
        const rect = target.getBoundingClientRect();
        const nextIndex = event.clientY > rect.top + rect.height / 2 ? rawIndex + 1 : rawIndex;
        setHomeInsertIndicator(
          isHomeInsertNoop(entry.id, targetArea, nextIndex)
            ? null
            : { area: targetArea, index: nextIndex },
        );
      }}
      onPointerUp={(event) => {
        if (draggingHomeEntryId === entry.id && homeInsertIndicator) {
          moveHomeContentEntry(entry.id, homeInsertIndicator.area, homeInsertIndicator.index);
        }
        homeDragStartRef.current = null;
        setHomeDragOffset(null);
        setDraggingHomeEntryId(null);
        setHomeInsertIndicator(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        homeDragStartRef.current = null;
        setHomeDragOffset(null);
        setDraggingHomeEntryId(null);
        setHomeInsertIndicator(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
    >
      {homeLayoutEditing && homeInsertIndicator?.area === area && homeInsertIndicator.index === index ? (
        <div className="pointer-events-none absolute -top-2 left-0 right-0 z-50 h-1.5 rounded-full bg-orange-500 shadow-[0_0_0_2px_rgb(255_255_255/0.8)]" />
      ) : null}
      {homeLayoutEditing ? (
        <div className="absolute right-2 top-2 z-30 flex items-center gap-1">
          <span
            className="grid size-7 cursor-grab place-items-center rounded-md border border-border bg-card/95 text-muted-foreground shadow-sm active:cursor-grabbing"
            title={`拖动 ${homeContentCardLabel(entry.type)}`}
          >
            <GripVertical className="size-4" />
          </span>
          <button
            aria-label={`移除 ${homeContentCardLabel(entry.type)}`}
            className="grid size-7 place-items-center rounded-md border border-destructive/40 bg-card/95 text-destructive shadow-sm hover:bg-destructive hover:text-destructive-foreground"
            data-home-card-control="true"
            disabled={homeContentLayout.length <= 1}
            onClick={() => removeHomeContentEntry(entry.id)}
            onDragStart={(event) => event.preventDefault()}
            title="从首页移除"
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
      {homeLayoutEditing && cardSettings ? (
        <div
          className="absolute left-2 top-2 z-30 max-w-[min(260px,calc(100%-5rem))] rounded-md border border-border bg-card/95 p-2 shadow-sm backdrop-blur"
          data-home-card-control="true"
        >
          {cardSettings}
        </div>
      ) : null}
      {homeLayoutEditing && area === "main" ? (
        <button
          aria-label={`切换 ${homeContentCardLabel(entry.type)} 宽度`}
          className="absolute bottom-0 right-0 z-30 h-9 w-9 cursor-pointer overflow-hidden rounded-br-md text-primary transition-transform hover:scale-110"
          data-home-resize-handle="true"
          onClick={(event) => {
            event.stopPropagation();
            updateHomeContentWidth(entry.id, effectiveWidth === "half" ? "full" : "half");
          }}
          onDragStart={(event) => event.preventDefault()}
          title={effectiveWidth === "half" ? "切换为 100%" : "切换为 50%"}
          type="button"
        >
          <span className="absolute bottom-0 right-0 h-0 w-0 border-b-[28px] border-l-[28px] border-b-primary/80 border-l-transparent" />
          <span className="absolute bottom-1 right-1 font-mono text-[9px] font-bold text-primary-foreground">
            {effectiveWidth === "half" ? "50" : "100"}
          </span>
        </button>
      ) : null}
      <div className={cn(homeLayoutEditing && "pointer-events-none select-none blur-[1.5px] opacity-70 transition-[filter,opacity]")}>
        {entry.content}
      </div>
      {homeLayoutEditing ? (
        <div className="pointer-events-none absolute inset-0 z-10 rounded-md bg-background/20 backdrop-blur-[1px]" />
      ) : null}
      {homeLayoutEditing && index === areaEntries.length - 1 ? (
        <div
          className={cn(
            "mt-2 rounded-md border border-dashed py-2 text-center text-[11px] text-muted-foreground",
            homeInsertIndicator?.area === area && homeInsertIndicator.index === areaEntries.length
              ? "border-orange-500 bg-orange-500/10"
              : "border-primary/30",
          )}
        >
          拖到这里放在末尾
        </div>
      ) : null}
    </div>
    );
  }, [
    draggingHomeEntryId,
    homeDragOffset,
    homeContentLayout.length,
    homeInsertIndicator,
    homeLayoutEditing,
    isHomeInsertNoop,
    mainHomeContentCards.length,
    moveHomeContentEntry,
    removeHomeContentEntry,
    renderHomeCardSettings,
    sideHomeContentCards.length,
    updateHomeContentWidth,
    useRetroHome,
  ]);

  return (
    <>
      <div className={cn("h-full overflow-auto px-5 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", useRetroHome && "pb-24", !useRetroHome && "bg-background", active ? "block" : "hidden")}>
        <div className={cn("mx-auto grid", useRetroHome ? "max-w-[1480px] gap-4" : "max-w-6xl gap-4")}>
          <div
            className={cn(
              "grid",
              useRetroHome
                ? "grid-cols-[minmax(0,1fr)_minmax(300px,360px)] items-stretch gap-4"
                : "grid-cols-[minmax(0,1fr)_minmax(280px,320px)] items-start gap-3",
            )}
          >
            <div
            className={cn("grid min-w-0 content-start md:grid-cols-2", useRetroHome ? "gap-4" : "gap-3")}
              data-home-drop-area="main"
            >
              {mainHomeContentCards.map((entry, index) => renderHomeEditableCard(entry, mainHomeContentCards, "main", index))}
            </div>
            <div
              className={cn("grid min-w-0 content-start", useRetroHome ? "gap-4" : "gap-3")}
              data-home-drop-area="side"
            >
              {sideHomeContentCards.map((entry, index) => renderHomeEditableCard(entry, sideHomeContentCards, "side", index))}
              {useRetroHome ? (
                <div className="group/home-edit relative w-fit overflow-visible pr-30">
                  <ElasticMascot
                    onLongPress={onEnterFloatingMode}
                    onSecretTap={handleMascotSecretTap}
                    placement="retro-column"
                  />
                  <div className="absolute left-full top-0 h-full w-40" />
                  <div
                    className={cn(
                      "absolute right-0 top-1/2 z-30 flex -translate-y-1/2 translate-x-full items-center gap-1 opacity-0 transition-[opacity,transform] duration-150",
                      homeLayoutEditing
                        ? "pointer-events-auto translate-x-[calc(100%-4rem)] opacity-100"
                        : "pointer-events-none group-hover/home-edit:pointer-events-auto group-hover/home-edit:translate-x-[calc(100%+0.75rem)] group-hover/home-edit:opacity-100",
                    )}
                  >
                    <Button
                      aria-label={homeLayoutEditing ? "完成首页调整" : "调整首页"}
                      className="size-20 shrink-0 !border-0 !bg-transparent text-primary !shadow-none outline-none ring-0 hover:!bg-transparent hover:text-primary active:!bg-transparent [&_svg]:!size-12"
                      onClick={() => setHomeLayoutEditing((current) => !current)}
                      size="icon"
                      title={homeLayoutEditing ? "完成首页调整" : "调整首页"}
                      variant="ghost"
                    >
                      {homeLayoutEditing ? <SharpSaveIcon /> : <SolidEditLayoutIcon />}
                    </Button>
                    {homeLayoutEditing ? (
                      <Button
                        aria-label="恢复默认首页布局"
                        className="size-20 shrink-0 !border-0 !bg-transparent text-muted-foreground !shadow-none outline-none ring-0 hover:!bg-transparent hover:text-primary active:!bg-transparent [&_svg]:!size-12"
                        onClick={resetHomeContentLayoutToDefault}
                        size="icon"
                        title="恢复默认首页布局"
                        variant="ghost"
                      >
                        <RefreshCw className="!size-12" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          {homeLayoutEditing ? (
            <div className={cn("rounded-lg border border-border bg-card p-3", useRetroHome && "retro-control rounded-sm")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">可添加到首页</p>
                  <p className="text-xs text-muted-foreground">点击添加后会放到左侧主内容，再拖到想要的位置。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {addableHomeContentOptions.length > 0 ? addableHomeContentOptions.map((option) => (
                    <Button key={option.type} onClick={() => addHomeContentEntry(option.type, "main")} size="sm" variant="outline">
                      <Plus className="size-3.5" />
                      {option.label}
                    </Button>
                  )) : (
                    <span className="text-xs text-muted-foreground">所有卡片都已显示</span>
                  )}
                </div>
              </div>
            </div>
          ) : null}
          {!useRetroHome ? (
            <>
              <div className="group/home-layout-actions pointer-events-auto fixed bottom-0 right-16 z-30 h-36 w-56 overflow-visible">
                <Button
                  aria-label={homeLayoutEditing ? "完成首页调整" : "调整首页"}
                  className={cn(
                    "absolute bottom-4 right-20 size-16 !border-0 !bg-transparent text-primary !shadow-none outline-none ring-0 transition-opacity hover:!bg-transparent hover:text-primary active:!bg-transparent [&_svg]:!size-10",
                    homeLayoutEditing
                      ? "opacity-100"
                      : "pointer-events-none opacity-0 group-hover/home-layout-actions:pointer-events-auto group-hover/home-layout-actions:opacity-100 group-focus-within/home-layout-actions:pointer-events-auto group-focus-within/home-layout-actions:opacity-100",
                  )}
                  onClick={() => setHomeLayoutEditing((current) => !current)}
                  size="icon"
                  title={homeLayoutEditing ? "完成首页调整" : "调整首页"}
                  variant="ghost"
                >
                  {homeLayoutEditing ? <SharpSaveIcon className="size-10" /> : <SolidEditLayoutIcon />}
                </Button>
                {homeLayoutEditing ? (
                  <Button
                    aria-label="恢复默认首页布局"
                    className="absolute bottom-4 right-36 size-16 !border-0 !bg-transparent text-muted-foreground !shadow-none outline-none ring-0 hover:!bg-transparent hover:text-primary active:!bg-transparent [&_svg]:!size-10"
                    onClick={resetHomeContentLayoutToDefault}
                    size="icon"
                    title="恢复默认首页布局"
                    variant="ghost"
                  >
                    <RefreshCw className="!size-10" />
                  </Button>
                ) : null}
              </div>
              <ElasticMascot onLongPress={onEnterFloatingMode} onSecretTap={handleMascotSecretTap} />
            </>
          ) : null}
        </div>
      </div>

      <Dialog open={mascotIntroOpen} onOpenChange={setMascotIntroOpen}>
        <DialogContent size="md">
          <DialogHeader
            description="你把角落里的它点醒了。"
            icon={<Sparkles className="size-4" />}
            title="关于这个形象"
            tone="primary"
          />
          <DialogBody className="space-y-4">
            <div className={cn(useRetroHome ? "retro-control flex items-center gap-4 p-4" : "flex items-center gap-4 rounded-lg border border-border bg-muted/35 p-4")}>
              <div className={cn("relative h-24 w-24 shrink-0 overflow-hidden bg-background", useRetroHome ? "rounded-sm" : "rounded-md")}>
                <img
                  alt=""
                  className="absolute -right-7 -bottom-6 w-28 select-none"
                  draggable={false}
                  src={maiMascotImage}
                />
              </div>
              <div className="min-w-0 space-y-2 text-sm leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">MaiBot OneKey 的角落形象</p>
                <p>
                  它是一个橘子和一条萨卡班甲鱼喝醉了之后留下的结果。现在主要以一种形态的 AI 存在，
                  平时窝在首页右下角，陪你盯着服务状态、WebUI 和插件更新。
                </p>
                <p>
                  偶尔，它也会以人类形态出没。本次启动它只会认真自我介绍这一次；下次重启，再让它重新鼓起勇气开口。
                </p>
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setMascotIntroOpen(false)} size="sm">
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={quickActionsOpen} onOpenChange={setQuickActionsOpen}>
        <DialogContent size="lg">
          <DialogHeader
            description="选择路径、导入旧数据库或覆盖 MaiBot 配置文件。"
            icon={<Wrench className="size-4" />}
            title="快捷操作"
            tone="primary"
          />
          <DialogBody>
            <QuickActionsPanel embedded />
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setQuickActionsOpen(false)} size="sm" variant="ghost">
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={messagePlatformDialogOpen}
        onOpenChange={(next) => {
          if (!next && busy !== "message-platform:setup") setMessagePlatformDialogOpen(false);
        }}
      >
        <DialogContent size="md">
          <DialogHeader
            description="选择要接入的消息软件平台，一键包会写入适配器配置和 WebSocket 服务连接，然后启动对应后端。"
            icon={<Server className="size-4" />}
            title="新增消息平台"
            tone="primary"
          />
          <DialogBody className="space-y-4">
            {error && messagePlatformDialogOpen ? (
              <div className={cn("border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive", useRetroHome ? "rounded-sm" : "rounded-lg")}>
                {error}
              </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                {
                  backend: "napcat",
                  title: "QQ-NapCat",
                  description: "使用 NapCat WebUI 登录 QQ，并通过 OneBot WebSocket 连接 MaiBot。",
                },
                {
                  backend: "snowluma",
                  title: "QQ-SnowLuma",
                  description: "使用 SnowLuma 注入 QQ 进程，并通过 OneBot WebSocket 连接 MaiBot。",
                },
              ] as const).map((option) => (
                <button
                  className={cn(
                    cn(useRetroHome ? "rounded-sm" : "rounded-lg", "border p-3 text-left transition-colors"),
                    messagePlatformBackend === option.backend
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  )}
                  disabled={busy === "message-platform:setup"}
                  key={option.backend}
                  onClick={() => setMessagePlatformBackend(option.backend)}
                  type="button"
                >
                  <span className="block text-sm font-semibold">{option.title}</span>
                  <span className="mt-1 block text-xs leading-relaxed">{option.description}</span>
                </button>
              ))}
            </div>
            <label className="grid gap-1.5 text-xs font-medium">
              机器人 QQ 号
              <Input
                disabled={busy === "message-platform:setup"}
                inputMode="numeric"
                monospace
                onChange={(event) => setMessagePlatformAccount(event.target.value)}
                placeholder="例如 123456789"
                value={messagePlatformAccount}
              />
            </label>
            {qqBackendBusy ? (
              <div className={cn("border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning-foreground", useRetroHome ? "rounded-sm" : "rounded-lg")}>
                QQ 后端正在运行，请先停止后再新增或切换消息平台。
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy === "message-platform:setup"} onClick={() => setMessagePlatformDialogOpen(false)} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              disabled={busy === "message-platform:setup" || qqBackendBusy || !messagePlatformAccount.trim()}
              onClick={setupMessagePlatform}
              size="sm"
            >
              {busy === "message-platform:setup" ? <Loader2 className="animate-spin" /> : <Server />}
              配置并启动
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={updateDialog === "launcher"}
        onOpenChange={(next) => {
          if (!next && busy !== "launcher:check" && busy !== "launcher:update") setUpdateDialog(null);
        }}
      >
        <DialogContent size="lg">
          <DialogHeader
            description="检查 MaiBot OneKey 的最新安装包，并在确认后启动安装器。"
            icon={<PackageCheck className="size-4" />}
            title="更新一键包"
            tone="primary"
          />
          <DialogBody className="space-y-4">
            {error && updateDialog === "launcher" ? (
              <div className={cn("border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive", useRetroHome ? "rounded-sm" : "rounded-lg")}>
                {error}
              </div>
            ) : null}
            <div className={cn(useRetroHome ? "retro-control grid gap-2 p-3 text-xs" : "grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs")}>
              <DetailRow label="本地版本" value={launcherCurrentTag} retro={useRetroHome} />
              <DetailRow label="最新版本" value={launcherLatestTag} retro={useRetroHome} />
              <div className="my-1 border-t border-border/70" />
              <DetailRow label="发布版本" value={launcherUpdateInfo?.releaseName ?? launcherLatestTag} retro={useRetroHome} />
              <DetailRow label="安装包" value={launcherUpdateInfo?.assetName} retro={useRetroHome} />
              <DetailRow label="大小" value={formatFileSize(launcherUpdateInfo?.assetSize)} retro={useRetroHome} />
              <DetailRow label="更新源" value={launcherUpdateInfo?.source ?? snapshot.appLatestSource} retro={useRetroHome} />
            </div>
            {launcherUpdateInfo?.releaseNotes ? (
              <div className={cn(useRetroHome ? "retro-control grid gap-2 p-3" : "grid gap-2 rounded-lg border border-border bg-muted/40 p-3")}>
                <p className="text-xs font-medium">更新说明</p>
                <MarkdownRenderer
                  className="max-h-48 overflow-auto break-words pr-1 text-xs"
                  content={launcherUpdateInfo.releaseNotes}
                />
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={busy === "launcher:check" || busy === "launcher:update"}
              onClick={() => setUpdateDialog(null)}
              size="sm"
              variant="ghost"
            >
              取消
            </Button>
            <Button disabled={busy !== null} onClick={() => void checkLauncherUpdate()} size="sm" variant="secondary">
              {busy === "launcher:check" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              检查更新
            </Button>
            <Button disabled={busy !== null} onClick={openLauncherRelease} size="sm" variant="secondary">
              <ExternalLink />
              查看更新
            </Button>
            <Button
              disabled={busy !== null || !launcherUpdateAvailable}
              onClick={() => void installLauncherUpdate()}
              size="sm"
            >
              {busy === "launcher:update" ? <Loader2 className="animate-spin" /> : <Download />}
              下载并安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={updateDialog === "maibot"}
        onOpenChange={(next) => {
          if (!next && busy !== "maibot:update") setUpdateDialog(null);
        }}
      >
        <DialogContent size="lg">
          <DialogHeader
            title="更新 MaiBot"
            tone="primary"
          />
          <DialogBody className="space-y-4">
            {error && updateDialog === "maibot" ? (
              <div className={cn("border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive", useRetroHome ? "rounded-sm" : "rounded-lg")}>
                {error}
              </div>
            ) : null}
            <div className={cn(useRetroHome ? "retro-control grid gap-2 p-3 text-xs" : "grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs")}>
              <DetailRow label="本地版本" value={snapshot.moduleVersions.maibotLocal} retro={useRetroHome} />
              <div className="my-1 border-t border-border/70" />
              <DetailRow label="正式版" value={snapshot.moduleVersions.maibotLatestStableTag} retro={useRetroHome} />
            </div>
            {maibotUpdateBlocked ? (
              <div className={cn("border border-warning/40 bg-warning/15 px-3 py-2 text-xs", useRetroHome ? "rounded-sm" : "rounded-lg")}>
                请先停止 MaiBot Core，再执行更新。
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <ChoiceSwitch
                value={maibotChannel}
                onChange={(value) => {
                  setMaibotChannel(value);
                  if (value === "other") {
                    void loadMaiBotRefs();
                  }
                }}
                options={[
                  { value: "stable", label: "正式版", version: maibotTargets.stable },
                  { value: "other", label: "其他版本", version: maibotRefsLoading ? undefined : maibotTargets.other },
                ]}
                retro={useRetroHome}
              />
            </div>
            {maibotChannel === "other" ? (
              <div className={cn(useRetroHome ? "retro-control grid gap-3 p-3 md:grid-cols-2" : "grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-2")}>
                <label className="grid gap-1.5 text-xs font-medium">
                  分支
                  <select
                    className={cn("h-9 border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60", useRetroHome ? "rounded-sm" : "rounded-md")}
                    disabled={busy !== null || maibotRefsLoading}
                    onChange={(event) => {
                      setSelectedMaiBotBranch(event.target.value);
                      if (event.target.value) {
                        setSelectedMaiBotTag("");
                      }
                    }}
                    value={selectedMaiBotBranch}
                  >
                    <option value="">不指定分支</option>
                    {maibotBranches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs font-medium">
                  Tag
                  <select
                    className={cn("h-9 border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60", useRetroHome ? "rounded-sm" : "rounded-md")}
                    disabled={busy !== null || maibotRefsLoading}
                    onChange={(event) => {
                      setSelectedMaiBotTag(event.target.value);
                      if (event.target.value) {
                        setSelectedMaiBotBranch("");
                      }
                    }}
                    value={selectedMaiBotTag}
                  >
                    <option value="">最新内容</option>
                    {maibotTags.map((tag) => (
                      <option key={tag.name} value={tag.name}>
                        {tag.name}{tag.isPrerelease ? " (测试)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            <div className={cn(useRetroHome ? "retro-control grid gap-3 p-3" : "grid gap-3 rounded-lg border border-border bg-muted/40 p-3")}>
              <button
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() => setModuleSourceExpanded((expanded) => !expanded)}
                type="button"
              >
                <span className="text-xs font-medium">更新源</span>
                <ChevronDown
                  className={cn("size-4 shrink-0 text-muted-foreground transition-transform", moduleSourceExpanded && "rotate-180")}
                />
              </button>
              {moduleSourceExpanded ? (
                <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto] md:items-end">
                    <label className="grid gap-1.5 text-xs font-medium">
                      源预设
                      <select
                        className={cn("h-9 border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60", useRetroHome ? "rounded-sm" : "rounded-md")}
                        disabled={busy !== null || moduleSourceSaving || !moduleSourceConfig}
                        onChange={(event) => {
                          const preset = event.target.value as ModuleSourcePreset;
                          setModuleSourcePreset(preset);
                          void saveModuleSourceConfig(preset).catch((nextError: unknown) => setError(messageFromError(nextError)));
                        }}
                        value={moduleSourcePreset}
                      >
                        {moduleSourceConfig?.options.map((option) => (
                          <option key={option.preset} value={option.preset}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1.5 text-xs font-medium">
                      当前解析地址
                      <Input
                        disabled
                        value={moduleSourceConfig?.maibotUrl ?? ""}
                      />
                    </label>
                    <Button
                      disabled={busy !== null || moduleSourceSaving}
                      onClick={() => {
                        void (async () => {
                          await reloadModuleSourceOptions();
                          await loadMaiBotRefs();
                        })().catch((nextError: unknown) => setError(messageFromError(nextError)));
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <RefreshCw className={cn((maibotRefsLoading || moduleSourceSaving) && "animate-spin")} />
                      刷新
                    </Button>
                  </div>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy === "maibot:update"} onClick={() => setUpdateDialog(null)} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              disabled={
                busy !== null ||
                moduleSourceSaving ||
                maibotUpdateBlocked ||
                !maibotTargets[maibotChannel] ||
                (maibotChannel === "other" && maibotRefsLoading)
              }
              onClick={() => void updateMaiBot()}
              size="sm"
            >
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
              <div className={cn("border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive", useRetroHome ? "rounded-sm" : "rounded-lg")}>
                {error}
              </div>
            ) : null}
            <div className={cn(useRetroHome ? "retro-control grid gap-2 p-3 text-xs" : "grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs")}>
              <DetailRow label="已安装版本" value={snapshot.moduleVersions.dashboardOverride} retro={useRetroHome} />
              <div className="my-1 border-t border-border/70" />
              <DetailRow label="最新正式版" value={dashboardTarget} retro={useRetroHome} />
            </div>
            {maibotUpdateBlocked ? (
              <div className={cn("border border-warning/40 bg-warning/15 px-3 py-2 text-xs", useRetroHome ? "rounded-sm" : "rounded-lg")}>
                请先停止 MaiBot Core，再更新 WebUI 覆盖依赖。
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy === "dashboard:update"} onClick={() => setUpdateDialog(null)} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              disabled={busy !== null || maibotUpdateBlocked || !dashboardTarget}
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
            description={`从首页打开，关闭后不会影响 ${napcat?.name ?? "QQ 后端"} 服务运行。`}
            icon={<Server className="size-4" />}
            title={`${napcat?.name ?? "QQ 后端"} WebUI`}
            tone="primary"
          />
          <DialogBody className="overflow-hidden p-0">
            <WebviewPanel
              active={napcatWebuiOpen}
              emptyText={`${napcat?.name ?? "QQ 后端"} 启动后会在这里打开它自己的 WebUI。`}
              title={`${napcat?.name ?? "QQ 后端"} WebUI`}
              url={currentQqWebuiUrl}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
