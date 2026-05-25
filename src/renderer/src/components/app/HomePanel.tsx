import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  Maximize2,
  PackageCheck,
  Puzzle,
  Radar,
  RefreshCw,
  Server,
  Settings,
  Send,
  Sparkles,
  Store,
  Wrench,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import emojiDropImage from "@/assets/home-drops/emoji2.png";
import maiDropImage from "@/assets/home-drops/mai.png";
import mai2DropImage from "@/assets/home-drops/mai2.png";
import maiMascotImage from "@/assets/mai2.png";
import type {
  DesktopSnapshot,
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
import { Input } from "@/components/ui/input";
import { localChatErrorMessage } from "@/lib/local-chat-error";
import { cn } from "@/lib/utils";
import { WebviewPanel } from "./WebviewPanel";
import { QuickActionsPanel } from "./QuickActionsPanel";

type MaiBotUpdateChannel = "stable" | "test" | "other";
type DashboardUpdateChannel = "stable" | "test";
type CompactChatState = "idle" | "connecting" | "connected" | "error";

const LOCAL_CHAT_USER_NAME_STORAGE_KEY = "maibot.localChat.userName";
const QQ_WEBUI_PORT_STORAGE_PREFIX = "maibot.qqWebuiPort";
const ADAPTER_CONFIG_PROMPTED_STORAGE_PREFIX = "maibot.adapterConfigPrompted";
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

function qqWebuiPortStorageKey(backend: QqBackend): string {
  return `${QQ_WEBUI_PORT_STORAGE_PREFIX}.${backend}`;
}

function defaultQqWebuiPort(backend: QqBackend): string {
  return backend === "snowluma" ? "5099" : "6099";
}

function readQqWebuiPort(backend: QqBackend): string {
  try {
    return localStorage.getItem(qqWebuiPortStorageKey(backend)) ?? defaultQqWebuiPort(backend);
  } catch {
    return defaultQqWebuiPort(backend);
  }
}

function isValidPortText(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
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

function LocalChatQuickCard({
  active,
  maibotService,
  onOpenFull,
}: {
  active: boolean;
  maibotService: ServiceDescriptor | undefined;
  onOpenFull: () => void;
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

  const statusLabel =
    connected ? "已连接" : state === "connecting" ? "连接中" : maibotService?.status === "running" ? "未连接" : "MaiBot 未启动";
  const visibleMessages = messages
    .map((message) => ({ ...message, text: localChatText(message) }))
    .filter((message) => message.text.length > 0)
    .slice(-12);

  return (
    <section className="rounded-lg border border-border bg-card p-3.5">
      <div className="mb-3 flex items-center justify-end gap-2">
        <div className="flex shrink-0 items-center gap-2">
          <Badge dot variant={connected ? "success" : state === "connecting" ? "warning" : "secondary"}>
            {statusLabel}
          </Badge>
          <Button className="size-7" onClick={onOpenFull} size="icon" title="展开随便聊聊" variant="secondary">
            <Maximize2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="mb-3 grid max-h-32 min-h-20 gap-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 [scrollbar-width:thin]">
        {visibleMessages.length > 0 ? (
          visibleMessages.map((message) => (
            <div
              className={cn("flex min-w-0", message.role === "user" ? "justify-end" : "justify-start")}
              key={message.id}
            >
              <p
                className={cn(
                  "max-w-[82%] truncate rounded-md px-2.5 py-1.5 text-xs",
                  message.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : message.role === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-card text-foreground",
                )}
                title={message.text}
              >
                {message.text}
              </p>
            </div>
          ))
        ) : (
          <div className="grid place-items-center text-xs text-muted-foreground">
            {error ?? "这里会显示最近几句简单文字。"}
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
          className="h-8 shrink-0 px-3 text-xs"
          disabled={!connected || !draft.trim() || sending}
          onClick={() => void sendQuickMessage()}
          size="sm"
        >
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
          发送
        </Button>
      </div>
    </section>
  );
}

function ServiceSummary({
  icon,
  service,
  webuiAction,
  adapterAction,
}: {
  icon: React.ReactNode;
  service: ServiceDescriptor | undefined;
  webuiAction?: {
    title: string;
    label: string;
    port: string;
    portValid: boolean;
    onPortChange: (value: string) => void;
    onClick: () => void;
  };
  adapterAction?: {
    title: string;
    description?: string;
    label: string;
    onClick: () => void;
  };
}): React.JSX.Element {
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-card p-3.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            {icon}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{service?.name ?? "未知服务"}</p>
          </div>
        </div>
        {service ? (
          <Badge dot variant={statusVariant[service.status]}>
            {statusText[service.status]}
          </Badge>
        ) : null}
      </div>
      {(webuiAction || adapterAction) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {webuiAction ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
              <p className="min-w-0 truncate text-xs font-semibold">{webuiAction.title}</p>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <label aria-label="端口" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Input
                    className={cn("h-8 w-20 font-mono text-xs", !webuiAction.portValid && "border-destructive")}
                    inputMode="numeric"
                    onChange={(event) => webuiAction.onPortChange(event.target.value.replace(/\D/gu, "").slice(0, 5))}
                    value={webuiAction.port}
                  />
                </label>
                <Button
                  className="h-8 justify-self-start px-3 text-xs"
                  disabled={!webuiAction.portValid}
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
            <div className="grid gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{adapterAction.title}</p>
                {adapterAction.description ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                    {adapterAction.description}
                  </p>
                ) : null}
              </div>
              <Button className="h-7 px-2.5 text-[11px]" onClick={adapterAction.onClick} size="sm" variant="secondary">
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
}: {
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className="grid gap-3 rounded-lg border border-dashed border-primary/45 bg-card p-3.5 text-left transition-colors hover:border-primary hover:bg-primary/5"
      onClick={onClick}
      type="button"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Server className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">连接到消息软件平台.......</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              新增 QQ-NapCat 或 QQ-SnowLuma，自动写入连接配置并启动后端。
            </p>
          </div>
        </div>
        <Badge variant="warning">待配置</Badge>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
        <span className="text-xs text-muted-foreground">选择一个消息平台开始初始化</span>
        <span className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground">
          新增平台
          <ArrowRight className="size-3.5" />
        </span>
      </div>
    </button>
  );
}

function LauncherUpdateCard({
  appVersion,
  busy,
  latestTag,
  onCheckUpdate,
  onInstallUpdate,
  onOpenRelease,
}: {
  appVersion: string;
  busy?: "check" | "install" | null;
  latestTag?: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  onOpenRelease: () => void;
}): React.JSX.Element {
  const currentTag = `v${appVersion}`;
  const updateAvailable = latestTag ? compareVersionText(latestTag, currentTag) > 0 : false;
  const busyRunning = busy !== null && busy !== undefined;

  return (
    <section className="rounded-lg border border-border bg-card p-3.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Download className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">一键包版本</p>
          </div>
        </div>
        <Badge dot variant={latestTag ? (updateAvailable ? "warning" : "success") : "secondary"}>
          {latestTag ? (updateAvailable ? "可更新" : "已是最新") : "未读取"}
        </Badge>
      </div>
      <div className="mt-3 grid gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
        <DetailRow label="本地版本" value={currentTag} />
        <DetailRow label="最新版本" value={latestTag} />
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button className="h-8 px-3 text-xs" disabled={busyRunning} onClick={onCheckUpdate} size="sm" variant="secondary">
          {busy === "check" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          检查更新
        </Button>
        <Button className="h-8 px-3 text-xs" disabled={busyRunning} onClick={onOpenRelease} size="sm" variant="secondary">
          <ExternalLink className="size-3.5" />
          查看更新
        </Button>
        {updateAvailable ? (
          <Button className="h-8 px-3 text-xs" disabled={busyRunning} onClick={onInstallUpdate} size="sm">
            {busy === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            下载并安装
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function MaiBotOverviewCard({
  service,
  localVersion,
  latestStable,
  latestPrerelease,
  updateBusy,
  onUpdate,
  onOpenPluginStore,
  onOpenPluginManager,
}: {
  service: ServiceDescriptor | undefined;
  localVersion: string | undefined;
  latestStable: string | undefined;
  latestPrerelease: string | undefined;
  updateBusy?: boolean;
  onUpdate: () => void;
  onOpenPluginStore: () => void;
  onOpenPluginManager: () => void;
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<"version" | "plugins">("version");
  const hasNewVersion =
    compareVersionText(latestStable, localVersion) > 0 ||
    compareVersionText(latestPrerelease, localVersion) > 0;

  return (
    <div className="grid min-w-0 gap-4 rounded-lg border border-border bg-card p-3.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Radar className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{service?.name ?? "MaiBot Core"}</p>
          </div>
        </div>
        {service ? (
          <Badge dot variant={statusVariant[service.status]}>
            {statusText[service.status]}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_4.25rem]">
        <div className="min-w-0 sm:order-2">
          <div className="grid grid-cols-2 rounded-md border border-border bg-muted/35 p-1 sm:grid-cols-1">
          {([
            { value: "version", label: "版本" },
            { value: "plugins", label: "插件" },
          ] as const).map((tab) => (
            <button
              className={cn(
                "h-7 rounded-sm px-2 text-[11px] font-medium transition-colors sm:h-12",
                activeTab === tab.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
          </div>
        </div>

        {activeTab === "version" ? (
          <div className="grid min-w-0 gap-3 rounded-md border border-border bg-muted/30 p-3 sm:order-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">MaiBot 版本</p>
              <p className="mt-1 truncate font-mono text-base font-semibold" title={localVersion}>
                {valueOrFallback(localVersion)}
              </p>
            </div>
            <div className="grid min-w-0 gap-1 sm:min-w-44">
              <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
                <span className="shrink-0 text-muted-foreground">正式版</span>
                <span className="min-w-0 truncate font-mono text-xs font-medium text-muted-foreground/80" title={latestStable}>
                  {valueOrFallback(latestStable)}
                </span>
              </div>
              <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
                <span className="shrink-0 text-muted-foreground">测试版</span>
                <span className="min-w-0 truncate font-mono text-xs font-medium text-muted-foreground/80" title={latestPrerelease}>
                  {valueOrFallback(latestPrerelease)}
                </span>
              </div>
              <Button
                aria-label="更新 MaiBot"
                className="relative mt-1 h-7 justify-self-end px-2.5 text-[11px]"
                disabled={updateBusy}
                onClick={onUpdate}
                size="sm"
                variant="secondary"
              >
                {hasNewVersion ? (
                  <span className="absolute -right-1 -top-1 size-2 rounded-full bg-warning ring-2 ring-card" />
                ) : null}
                {updateBusy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 sm:order-1">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <Puzzle className="size-4.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">插件</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  安装或管理 MaiBot Core 插件。
                </span>
              </span>
            </div>
            <span className="flex shrink-0 flex-wrap gap-2">
              <Button className="h-8 px-2.5 text-[11px]" onClick={onOpenPluginStore} size="sm">
                <Store className="size-3.5" />
                打开商店
                <ArrowRight className="size-3.5" />
              </Button>
              <Button className="h-8 px-2.5 text-[11px]" onClick={onOpenPluginManager} size="sm" variant="secondary">
                <Puzzle className="size-3.5" />
                插件管理
                <ArrowRight className="size-3.5" />
              </Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function HomeStatsPanel({
  snapshot,
  services,
  onOpenQuickActions,
}: {
  snapshot: DesktopSnapshot;
  services: ServiceDescriptor[];
  onOpenQuickActions: () => void;
}): React.JSX.Element {
  const [maibotStats, setMaibotStats] = useState<MaiBotStatisticSummary | null>(null);
  const runningCount = services.filter((service) => service.status === "running").length;
  const readyCount = services.filter((service) => service.health === "ready").length;
  const qqBackend = snapshot.initState.qqBackend === "snowluma" ? "SnowLuma" : "NapCat";
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
    <div className="grid gap-3 self-start">
      <button
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:border-primary/45 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => void window.maibotDesktop?.openExternal(MAIBOT_OFFICIAL_DOCS_URL)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <ExternalLink className="size-4.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">官方文档</span>
            <span className="block truncate text-[11px] text-muted-foreground">docs.mai-mai.org</span>
          </span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <aside className="grid gap-3 rounded-lg border border-border bg-card p-3.5">
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <PackageCheck className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">统计信息</p>
          </div>
        </div>

        <div className="grid gap-2 text-xs">
          <DetailRow label="" value={`${runningCount}/${services.length}`} />
          <DetailRow label="" value={`${readyCount}/${services.length}`} />
          <DetailRow label="一键包版本" value={`v${snapshot.appVersion}`} />
          <DetailRow label="MaiBot 本地版本" value={snapshot.moduleVersions.maibotLocal} />
          <DetailRow label="QQ 后端" value={qqBackend} />
        </div>

        <div className="grid gap-2 border-t border-border pt-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-muted-foreground">LLM 用量</p>
            {maibotStats?.periodLabel ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                {maibotStats.periodLabel}
              </span>
            ) : null}
          </div>
          <DetailRow label="请求数" value={formatStatNumber(maibotStats?.totalRequests)} />
          <DetailRow label="Token" value={formatStatNumber(maibotStats?.totalTokens)} />
          <DetailRow label="总花费" value={maibotStats?.totalCost} />
          <DetailRow label="Token/小时" value={maibotStats?.tokensPerHour} />
        </div>

        <div className="grid gap-2 border-t border-border pt-3 text-xs">
          <p className="text-[11px] font-semibold text-muted-foreground">消息统计</p>
          <DetailRow label="消息数" value={formatStatNumber(maibotStats?.totalMessages)} />
          <DetailRow label="回复数" value={formatStatNumber(maibotStats?.totalReplies)} />
          <DetailRow label="在线时间" value={maibotStats?.totalOnlineTime} />
          {topChats.map((chat) => (
            <DetailRow
              key={chat.name}
              label={chat.name}
              value={formatStatNumber(chat.messageCount)}
            />
          ))}
        </div>
      </aside>
      <section className="rounded-lg border border-border bg-card p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <Wrench className="size-4.5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">快捷操作</p>
              <p className="text-[11px] text-muted-foreground">路径、数据库和配置导入。</p>
            </div>
          </div>
          <Button className="h-8 px-2.5 text-[11px]" onClick={onOpenQuickActions} size="sm" variant="secondary">
            打开
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </section>
    </div>
  );
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
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(".rounded-lg.border"))
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
}: {
  onLongPress: () => void;
  onSecretTap: () => void;
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

  return (
    <div
      aria-label="MaiBot 形象"
      className="fixed z-20 hidden h-28 w-32 overflow-hidden md:block"
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
      style={{
        right: "max(4px, calc(var(--app-window-radius, 16px) * 0.28))",
        bottom: "max(4px, calc(var(--app-window-radius, 16px) * 0.28))",
      }}
      tabIndex={0}
    >
      <img
        alt=""
        className="pointer-events-none absolute right-[-46px] bottom-[-40px] w-32 select-none"
        draggable={false}
        src={maiMascotImage}
        style={{
          transform: `translate3d(${x}px, ${y}px, 0) rotate(${rotate}deg) skew(${squash * 12}deg, ${-squash * 7}deg) scale(${1 + stretch}, ${1 - stretch * 0.55})`,
          transformOrigin: "82% 86%",
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
  onEnterFloatingMode,
}: {
  active: boolean;
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
  onOpenTab: (tab: string) => void;
  onOpenPluginConfig: (pluginId: string) => void;
  onEnterFloatingMode: () => void;
}): React.JSX.Element {
  const [updateDialog, setUpdateDialog] = useState<"maibot" | "dashboard" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messagePlatformDialogOpen, setMessagePlatformDialogOpen] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [mascotIntroOpen, setMascotIntroOpen] = useState(false);
  const [, setMascotClickCount] = useState(0);
  const [messagePlatformBackend, setMessagePlatformBackend] = useState<QqBackend>("napcat");
  const [messagePlatformAccount, setMessagePlatformAccount] = useState(snapshot.initState.qqAccount ?? "");
  const [maibotChannel, setMaibotChannel] = useState<MaiBotUpdateChannel>("stable");
  const [dashboardChannel, setDashboardChannel] = useState<DashboardUpdateChannel>("stable");
  const [napcatWebuiOpen, setNapcatWebuiOpen] = useState(false);
  const [qqWebuiPort, setQqWebuiPort] = useState(() => readQqWebuiPort(snapshot.initState.qqBackend ?? "napcat"));
  const [moduleSourceConfig, setModuleSourceConfig] = useState<ModuleSourceConfig | null>(null);
  const [moduleSourceExpanded, setModuleSourceExpanded] = useState(false);
  const [moduleSourcePreset, setModuleSourcePreset] = useState<ModuleSourcePreset>("ghproxy");
  const [customMaiBotUrl, setCustomMaiBotUrl] = useState("");
  const [customNapcatAdapterUrl, setCustomNapcatAdapterUrl] = useState("");
  const [maibotBranches, setMaibotBranches] = useState<ModuleBranchOption[]>([]);
  const [maibotTags, setMaibotTags] = useState<ModuleTagOption[]>([]);
  const [maibotRefsLoading, setMaibotRefsLoading] = useState(false);
  const [selectedMaiBotBranch, setSelectedMaiBotBranch] = useState("main");
  const [selectedMaiBotTag, setSelectedMaiBotTag] = useState("");
  const services = snapshot.services ?? [];
  const maibot = services.find((service) => service.id === "maibot");
  const napcat = services.find((service) => service.id === "napcat");
  const adapterPluginId = adapterPluginIdForBackend(snapshot.initState.qqBackend ?? "napcat");
  const adapterName = snapshot.initState.qqBackend === "snowluma" ? "SnowLuma 适配器" : "NapCat 适配器";
  const qqWebuiPortValid = isValidPortText(qqWebuiPort);
  const qqBackend = snapshot.initState.qqBackend ?? "napcat";
  const currentQqWebuiUrl = qqWebuiUrl(napcat?.url, qqBackend, qqWebuiPort);
  const messagePlatformConfigured =
    snapshot.initState.messagePlatformConfigured && Boolean(snapshot.initState.qqAccount?.trim());
  const qqBackendBusy =
    napcat?.status === "starting" || napcat?.status === "running" || napcat?.status === "stopping" || Boolean(napcat?.managed);
  const maibotUpdateBlocked =
    maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping";

  const maibotTargets: Record<MaiBotUpdateChannel, string | undefined> = {
    stable: snapshot.moduleVersions.maibotLatestStableTag,
    test: snapshot.moduleVersions.maibotLatestPrereleaseTag,
    other: selectedMaiBotTag
      ? `Tag ${selectedMaiBotTag}`
      : selectedMaiBotBranch
        ? `分支 ${selectedMaiBotBranch}`
        : undefined,
  };
  const dashboardTargets: Record<DashboardUpdateChannel, string | undefined> = {
    stable: snapshot.moduleVersions.dashboardLatestStablePypi ?? snapshot.moduleVersions.dashboardLatestPypi,
    test: snapshot.moduleVersions.dashboardLatestPrereleasePypi,
  };

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
    setQqWebuiPort(readQqWebuiPort(snapshot.initState.qqBackend ?? "napcat"));
  }, [snapshot.initState.qqBackend]);

  useEffect(() => {
    if (!qqWebuiPortValid) {
      return;
    }
    try {
      localStorage.setItem(qqWebuiPortStorageKey(snapshot.initState.qqBackend ?? "napcat"), String(Number(qqWebuiPort)));
    } catch {
      // Local storage may be unavailable in isolated previews.
    }
  }, [qqWebuiPort, qqWebuiPortValid, snapshot.initState.qqBackend]);

  const loadModuleSourceConfig = useCallback(async () => {
    if (!window.maibotDesktop?.modules) {
      return;
    }

    const config = await window.maibotDesktop.modules.getSourceConfig();
    setModuleSourceConfig(config);
    setModuleSourcePreset(config.preset);
    setCustomMaiBotUrl(config.maibotUrl);
    setCustomNapcatAdapterUrl(config.napcatAdapterUrl);
  }, []);

  const reloadModuleSourceOptions = useCallback(async () => {
    if (!window.maibotDesktop?.modules) {
      return;
    }

    const currentPreset = moduleSourcePreset;
    const currentMaiBotUrl = customMaiBotUrl;
    const currentNapcatAdapterUrl = customNapcatAdapterUrl;
    const config = await window.maibotDesktop.modules.getSourceConfig();
    setModuleSourceConfig(config);
    setModuleSourcePreset(currentPreset);
    setCustomMaiBotUrl(currentMaiBotUrl);
    setCustomNapcatAdapterUrl(currentNapcatAdapterUrl);
  }, [customMaiBotUrl, customNapcatAdapterUrl, moduleSourcePreset]);

  const loadMaiBotRefs = useCallback(async () => {
    if (!window.maibotDesktop?.modules || maibotRefsLoading) {
      return;
    }

    setMaibotRefsLoading(true);
    try {
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
  }, [maibotRefsLoading]);

  const openMaiBotUpdate = useCallback(() => {
    setError(null);
    setModuleSourceExpanded(false);
    setMaibotChannel(
      snapshot.moduleVersions.maibotLatestStableTag
        ? "stable"
        : "test",
    );
    setUpdateDialog("maibot");
    void loadModuleSourceConfig().catch((nextError: unknown) => {
      setError(messageFromError(nextError));
    });
    void loadMaiBotRefs();
  }, [
    loadMaiBotRefs,
    loadModuleSourceConfig,
    snapshot.moduleVersions.maibotLatestPrereleaseTag,
    snapshot.moduleVersions.maibotLatestStableTag,
  ]);

  const openPluginStore = useCallback(() => {
    onOpenTab("pluginmarket");
  }, [onOpenTab]);

  const openPluginManager = useCallback(() => {
    onOpenTab("pluginmanage");
  }, [onOpenTab]);

  const openLauncherRelease = useCallback(() => {
    const tag = snapshot.appLatestTag?.trim();
    const url = tag
      ? `https://github.com/DrSmoothl/MaiBotOneKey/releases/tag/${encodeURIComponent(tag)}`
      : "https://github.com/DrSmoothl/MaiBotOneKey/releases";
    void window.maibotDesktop?.openExternal(url);
  }, [snapshot.appLatestTag]);

  const checkLauncherUpdate = useCallback(async () => {
    if (!window.maibotDesktop?.launcher) {
      setError("桌面桥未就绪，无法检查启动器更新");
      return;
    }

    setBusy("launcher:check");
    setError(null);
    try {
      const update = await window.maibotDesktop.launcher.checkUpdate();
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
        : maibotChannel === "test" && maibotTargets.test
          ? { type: "tag", name: maibotTargets.test }
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
      const config = await window.maibotDesktop.modules.saveSourceConfig({
        preset: moduleSourcePreset,
        maibotUrl: customMaiBotUrl,
        napcatAdapterUrl: customNapcatAdapterUrl,
      });
      setModuleSourceConfig(config);
      setModuleSourcePreset(config.preset);
      setCustomMaiBotUrl(config.maibotUrl);
      setCustomNapcatAdapterUrl(config.napcatAdapterUrl);
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
    customMaiBotUrl,
    customNapcatAdapterUrl,
    maibotChannel,
    maibotTargets.stable,
    maibotTargets.test,
    moduleSourcePreset,
    refreshSnapshot,
    selectedMaiBotBranch,
    selectedMaiBotTag,
  ]);

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
          <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid min-w-0 gap-3">
              <MaiBotOverviewCard
                latestPrerelease={snapshot.moduleVersions.maibotLatestPrereleaseTag}
                latestStable={snapshot.moduleVersions.maibotLatestStableTag}
                localVersion={snapshot.moduleVersions.maibotLocal}
                onOpenPluginManager={openPluginManager}
                onOpenPluginStore={openPluginStore}
                onUpdate={openMaiBotUpdate}
                service={maibot}
                updateBusy={busy === "maibot:update"}
              />
              <LocalChatQuickCard
                active={active}
                maibotService={maibot}
                onOpenFull={() => onOpenTab("localchat")}
              />
              {messagePlatformConfigured ? (
                <ServiceSummary
                  adapterAction={{
                    title: `${adapterName.replace(/\s+/gu, "")}设置`,
                    label: "打开配置",
                    onClick: () => onOpenPluginConfig(adapterPluginId),
                  }}
                  icon={<Server className="size-4.5" />}
                  service={napcat}
                  webuiAction={{
                    title: `${napcat?.name ?? "NapCat"} 设置`,
                    label: "打开 WebUI",
                    port: qqWebuiPort,
                    portValid: qqWebuiPortValid,
                    onPortChange: setQqWebuiPort,
                    onClick: () => setNapcatWebuiOpen(true),
                  }}
                />
              ) : (
                <MessagePlatformConnectCard onClick={openMessagePlatformDialog} />
              )}
              <LauncherUpdateCard
                appVersion={snapshot.appVersion}
                busy={busy === "launcher:check" ? "check" : busy === "launcher:update" ? "install" : null}
                latestTag={snapshot.appLatestTag}
                onCheckUpdate={() => void checkLauncherUpdate()}
                onInstallUpdate={() => void installLauncherUpdate()}
                onOpenRelease={openLauncherRelease}
              />
            </div>
            <HomeStatsPanel
              onOpenQuickActions={() => setQuickActionsOpen(true)}
              services={services}
              snapshot={snapshot}
            />
          </div>
          <ElasticMascot onLongPress={onEnterFloatingMode} onSecretTap={handleMascotSecretTap} />
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
            <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/35 p-4">
              <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md bg-background">
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
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
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
                    "rounded-lg border p-3 text-left transition-colors",
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
              <div className="rounded-lg border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
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
        open={updateDialog === "maibot"}
        onOpenChange={(next) => {
          if (!next && busy !== "maibot:update") setUpdateDialog(null);
        }}
      >
        <DialogContent size="lg">
          <DialogHeader
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
              <DetailRow label="正式版" value={snapshot.moduleVersions.maibotLatestStableTag} />
              <DetailRow label="测试版" value={snapshot.moduleVersions.maibotLatestPrereleaseTag} />
            </div>
            {maibotUpdateBlocked ? (
              <div className="rounded-lg border border-warning/40 bg-warning/15 px-3 py-2 text-xs">
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
                  { value: "test", label: "测试版", version: maibotTargets.test },
                  { value: "other", label: "其他版本", version: maibotRefsLoading ? undefined : maibotTargets.other },
                ]}
              />
            </div>
            {maibotChannel === "other" ? (
              <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-medium">
                  分支
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
            <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3">
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
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        disabled={busy !== null || !moduleSourceConfig}
                        onChange={(event) => {
                          const preset = event.target.value as ModuleSourcePreset;
                          setModuleSourcePreset(preset);
                          const option = moduleSourceConfig?.options.find((item) => item.preset === preset);
                          if (option) {
                            setCustomMaiBotUrl(option.maibotUrl);
                            setCustomNapcatAdapterUrl(option.napcatAdapterUrl);
                          }
                        }}
                        value={moduleSourcePreset}
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
                      disabled={busy !== null}
                      onClick={() => {
                        void reloadModuleSourceOptions();
                        void loadMaiBotRefs();
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <RefreshCw />
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
