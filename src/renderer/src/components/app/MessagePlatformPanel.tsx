import { getDesktopSnapshot } from "@/lib/desktop-api";
import { normalizeQqAccount } from "@shared/qq-account";
import { MESSAGE_PLATFORM_GUIDE_EVENT, MESSAGE_PLATFORM_GUIDE_REQUEST_KEY } from "@/lib/message-platform-guide";
import {
  AlertTriangle,
  ArrowUp,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Download,
  ExternalLink,
  Loader2,
  PackageCheck,
  Play,
  Radar,
  RefreshCw,
  Server,
  Settings,
  Sparkles,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import type React from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DropdownMenu } from "radix-ui";
import emojiDropImage from "@/assets/home-drops/emoji2.png";
import maiDropImage from "@/assets/home-drops/mai.png";
import mai2DropImage from "@/assets/home-drops/mai2.png";
import maiMascotImage from "@/assets/mai2.png";
import futureRetroMascotImage from "@/assets/mai-fr.png";
import type {
  DesktopSnapshot,
  LauncherUpdateDownloadProgress,
  LauncherUpdateInfo,
  MaiBotModuleUpdateProgress,
  MaiBotUpdateInfo,
  ModuleTagOption,
  ModuleUpdateTarget,
  QqBackend,
  QqProtocol,
  ServiceDescriptor,
  ServiceId,
  ServiceStatus,
} from "@shared/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { localChatErrorMessage } from "@/lib/local-chat-error";
import { QQ_OFFICIAL_ADAPTER_PLUGIN_ID } from "@shared/qq-official-adapter";
import { resolveMaiBotUpdateTarget } from "@shared/maibot-update-target";
import {
  QQ_WEBUI_PORT_CHANGE_EVENT,
  isValidPortText,
  readQqWebuiPort,
} from "@/lib/qq-webui-port";
import { useAppearance, usesRetroStructure } from "@/lib/use-appearance";
import { cn } from "@/lib/utils";
import { QqWebuiDialog } from "./QqWebuiDialog";
import { MessagePlatformAdvancedSettings } from "./MessagePlatformAdvancedSettings";
import { OfficialQqCredentialsFields } from "./OfficialQqCredentialsFields";
import { saveQqProtocol } from "@/lib/qq-protocol";
import { MarkdownRenderer } from "./MarkdownRenderer";

type MaiBotUpdateChannel = "stable" | "other";
type MaiBotVersionFetchProgress = {
  value: number;
  label: string;
  detail?: string;
  tone: "loading" | "success" | "error";
};

const MASCOT_INTRO_TRIGGER_CLICKS = 10;

let mascotIntroShownThisSession = false;

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

function formatMaiBotSelectedTarget(snapshot: DesktopSnapshot): string | undefined {
  const target = snapshot.moduleVersions.maibotSelectedTarget;
  if (!target) {
    return undefined;
  }
  const channel = snapshot.moduleVersions.maibotSelectedChannel;
  const channelLabel = channel === "stable" ? "正式版" : "自定义版本";
  const targetLabel = `PyPI ${target.name}`;
  return `${channelLabel} / ${targetLabel}`;
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

function formatDownloadBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const launcherDownloadPhaseLabels: Record<LauncherUpdateDownloadProgress["phase"], string> = {
  checking: "检查更新",
  downloading: "下载安装包",
  starting: "打开安装包",
  completed: "已完成",
};

function launcherDownloadProgressValue(progress: LauncherUpdateDownloadProgress): number {
  if (typeof progress.percent === "number" && Number.isFinite(progress.percent)) {
    return Math.max(0, Math.min(100, progress.percent));
  }
  if (progress.phase === "completed") {
    return 100;
  }
  if (progress.phase === "starting") {
    return 92;
  }
  if (progress.phase === "downloading") {
    return Math.min(88, 18 + Math.log10(Math.max(1, progress.receivedBytes)) * 9);
  }
  return 8;
}

function LauncherDownloadProgressDetails({
  progress,
  retro,
}: {
  progress: LauncherUpdateDownloadProgress;
  retro: boolean;
}): React.JSX.Element {
  const value = launcherDownloadProgressValue(progress);
  const percentText =
    typeof progress.percent === "number" && Number.isFinite(progress.percent)
      ? `${Math.round(progress.percent)}%`
      : progress.phase === "completed"
        ? "100%"
        : "接收中";
  const totalText = progress.totalBytes ? formatDownloadBytes(progress.totalBytes) : undefined;
  const byteText = totalText
    ? `${formatDownloadBytes(progress.receivedBytes)} / ${totalText}`
    : formatDownloadBytes(progress.receivedBytes);

  return (
    <div className={cn(retro ? "retro-control grid gap-2 p-3 text-xs" : "grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs")}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate font-medium">
          {launcherDownloadPhaseLabels[progress.phase]}
          {progress.assetName ? ` · ${progress.assetName}` : ""}
        </span>
        <span className="shrink-0 font-mono tabular-nums">{percentText}</span>
      </div>
      <Progress value={value} />
      <div className="flex min-w-0 items-center justify-between gap-3 text-muted-foreground">
        <span className="min-w-0 truncate">{progress.assetName ?? "准备下载更新安装包"}</span>
        <span className="shrink-0 font-mono tabular-nums">{byteText}</span>
      </div>
    </div>
  );
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

interface ParsedVersionText {
  raw: string;
  parts: number[];
  prerelease: boolean;
  prereleaseLabel?: string;
  prereleaseNumber?: number;
}

function parseVersionText(version: string | undefined): ParsedVersionText | undefined {
  const raw = version?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = raw.replace(/^v/iu, "");
  const match = normalized.match(/^(\d+(?:\.\d+){0,3})(?:[-._]?([a-z]+)\.?(\d*)?)?$/iu);
  if (!match) {
    return undefined;
  }
  const prereleaseLabel = match[2]?.toLowerCase();
  return {
    raw,
    parts: match[1].split(".").map((part) => Number(part)),
    prerelease: Boolean(prereleaseLabel),
    prereleaseLabel,
    prereleaseNumber: match[3] ? Number(match[3]) : undefined,
  };
}

function prereleaseRank(label: string | undefined): number {
  switch (label) {
    case "dev":
      return 0;
    case "a":
    case "alpha":
      return 1;
    case "b":
    case "beta":
      return 2;
    case "pre":
    case "preview":
      return 3;
    case "rc":
      return 4;
    default:
      return 5;
  }
}

function compareVersionText(left: string | undefined, right: string | undefined): number {
  const parsedLeft = parseVersionText(left);
  const parsedRight = parseVersionText(right);
  if (!parsedLeft || !parsedRight) {
    return (left ?? "").localeCompare(right ?? "", "en-US", { numeric: true, sensitivity: "base" });
  }
  const length = Math.max(parsedLeft.parts.length, parsedRight.parts.length);
  for (let index = 0; index < length; index++) {
    const diff = (parsedLeft.parts[index] ?? 0) - (parsedRight.parts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (parsedLeft.prerelease !== parsedRight.prerelease) {
    return parsedLeft.prerelease ? -1 : 1;
  }
  if (parsedLeft.prerelease && parsedRight.prerelease) {
    const rankDiff = prereleaseRank(parsedLeft.prereleaseLabel) - prereleaseRank(parsedRight.prereleaseLabel);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    const numberDiff = (parsedLeft.prereleaseNumber ?? 0) - (parsedRight.prereleaseNumber ?? 0);
    if (numberDiff !== 0) {
      return numberDiff;
    }
  }
  return 0;
}

function messageFromError(error: unknown): string {
  return localChatErrorMessage(error);
}

function isLikelyNetworkError(error: unknown): boolean {
  const message = messageFromError(error);
  return (
    /(?:fetch failed|network|网络|连接|timeout|timed out|abort|socket|proxy|代理)/iu.test(message)
    || /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/iu.test(message)
    || /HTTP (?:408|429|5\d\d)\b/iu.test(message)
  );
}

function DetailRow({
  label,
  value,
  className,
  valueClassName,
  retro = false,
}: {
  label: string;
  value: string | undefined;
  className?: string;
  valueClassName?: string;
  retro?: boolean;
}): React.JSX.Element {
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-3", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate",
          retro ? "retro-value text-right" : "font-mono font-semibold",
          valueClassName,
        )}
        title={value}
      >
        {valueOrFallback(value)}
      </span>
    </div>
  );
}

function ServiceCardControls({
  service,
  busy,
  onStart,
  onStop,
  retro,
}: {
  service: ServiceDescriptor;
  busy: boolean;
  onStart: (id: ServiceId) => void;
  onStop: (id: ServiceId) => void;
  retro: boolean;
}): React.JSX.Element {
  const isTransitioning = service.status === "starting" || service.status === "stopping" || busy;
  const isRunning = service.status === "running";
  const actionLabel = isTransitioning
    ? service.status === "stopping" ? `正在停止 ${service.name}` : `正在启动 ${service.name}`
    : isRunning ? `停止 ${service.name}` : `启动 ${service.name}`;
  const runServiceAction = isRunning ? onStop : onStart;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        aria-label={actionLabel}
        className={cn(retro ? "size-8" : "size-7")}
        disabled={isTransitioning}
        onClick={() => runServiceAction(service.id)}
        size="icon"
        title={actionLabel}
        variant={retro ? "secondary" : "ghost"}
      >
        {isTransitioning ? <Loader2 className="animate-spin" /> : isRunning ? <Square /> : <Play />}
      </Button>
    </div>
  );
}

function ServiceSummary({
  icon,
  title,
  service,
  serviceControls,
  webuiAction,
  terminalAction,
  adapterAction,
  stoppedStatusAfterTitle = false,
  retro,
}: {
  icon: React.ReactNode;
  title?: string;
  service: ServiceDescriptor | undefined;
  serviceControls?: {
    busy: boolean;
    onStart: (id: ServiceId) => void;
    onStop: (id: ServiceId) => void;
  };
  webuiAction?: {
    title: string;
    label: string;
    onClick: () => void;
  };
  terminalAction?: {
    label: string;
    onClick: () => void;
  };
  adapterAction?: {
    title: string;
    description?: string;
    label: string;
    onClick: () => void;
  };
  stoppedStatusAfterTitle?: boolean;
  retro: boolean;
}): React.JSX.Element {
  const showStoppedStatusAfterTitle = retro && stoppedStatusAfterTitle && service?.status === "stopped";

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
            <p className={cn("flex min-w-0 items-baseline gap-2", retro ? "retro-title text-2xl" : "text-sm font-semibold")}>
              <span className="min-w-0 truncate">{title ?? service?.name ?? "未知服务"}</span>
              {showStoppedStatusAfterTitle ? (
                <span className="shrink-0 text-2xl font-extrabold not-italic leading-[inherit] text-destructive">
                  未启动
                </span>
              ) : null}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {service && serviceControls ? (
            <ServiceCardControls
              busy={serviceControls.busy}
              onStart={serviceControls.onStart}
              onStop={serviceControls.onStop}
              retro={retro}
              service={service}
            />
          ) : null}
          {service && !showStoppedStatusAfterTitle ? <ServiceStatusText status={service.status} /> : null}
        </div>
      </div>
      {(webuiAction || adapterAction) ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
          {webuiAction ? (
            <div className={cn(retro ? "retro-control flex flex-wrap items-center justify-between gap-3 px-3 py-2" : "flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2")}>
              <p className={cn("min-w-0 truncate font-bold", retro ? "text-base" : "text-xs")}>{webuiAction.title}</p>
              <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
                {terminalAction ? (
                  <Button
                    className="h-8 shrink-0 justify-self-start px-3 text-xs"
                    onClick={terminalAction.onClick}
                    size="sm"
                    variant="secondary"
                  >
                    <TerminalSquare className="size-4" />
                    {terminalAction.label}
                  </Button>
                ) : null}
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

function SolidUpgradeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden className="size-5" fill="none" viewBox="0 0 24 24">
      <path d="M12 21V7" stroke="currentColor" strokeWidth="6" />
      <path d="M4 12 12 4" stroke="currentColor" strokeWidth="6" />
      <path d="M20 12 12 4" stroke="currentColor" strokeWidth="6" />
    </svg>
  );
}

function MaiBotOverviewCard({
  localVersion,
  launcherVersion,
  retro,
}: {
  localVersion: string | undefined;
  launcherVersion: string;
  retro: boolean;
}): React.JSX.Element {
  return (
    <div className="flex h-8 items-center gap-2 whitespace-nowrap">
      <span className={cn("font-bold leading-none", retro && "retro-title")}>
        MaiBot
      </span>
      <div className="flex flex-col items-start gap-0.5 font-mono text-primary">
        <span className="text-xs font-semibold leading-none" title="MaiBot 版本">{valueOrFallback(localVersion)}</span>
        <span className="text-[9px] leading-none" title="一键包版本">v{launcherVersion}</span>
      </div>
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
  className,
}: {
  onLongPress: () => void;
  onSecretTap: () => void;
  placement?: "fixed" | "retro-column";
  className?: string;
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
        className,
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

export function MessagePlatformPanel({
  coreToolbarTarget,
  updateToolbarTarget,
  active,
  snapshot,
  onSnapshot,
  onOpenPluginConfig,
  onOpenTerminalSession,
  onEnterFloatingMode,
  onStartService,
  onStopService,
  serviceActionBusy,
}: {
  coreToolbarTarget?: HTMLDivElement | null;
  updateToolbarTarget?: HTMLDivElement | null;
  active: boolean;
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
  onOpenPluginConfig: (pluginId: string) => void;
  onOpenTerminalSession: (sessionId: string) => void;
  onEnterFloatingMode: () => void;
  onStartService: (id: ServiceId) => void;
  onStopService: (id: ServiceId) => void;
  serviceActionBusy: string | null;
}): React.JSX.Element {
  const [updateDialog, setUpdateDialog] = useState<"launcher" | "maibot" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launcherUpdateInfo, setLauncherUpdateInfo] = useState<LauncherUpdateInfo | null>(null);
  const [launcherDownloadProgress, setLauncherDownloadProgress] = useState<LauncherUpdateDownloadProgress | null>(null);
  const [launcherNetworkFailed, setLauncherNetworkFailed] = useState(false);
  const [launcherQuitPromptOpen, setLauncherQuitPromptOpen] = useState(false);
  const [maibotUpdateInfo, setMaibotUpdateInfo] = useState<MaiBotUpdateInfo | null>(null);
  const [maibotUpdateInfoLoading, setMaibotUpdateInfoLoading] = useState(false);
  const [maibotUpdateInfoError, setMaibotUpdateInfoError] = useState<string | null>(null);
  const [maibotModuleUpdateProgress, setMaibotModuleUpdateProgress] =
    useState<MaiBotModuleUpdateProgress | null>(null);
  const [maibotModuleUpdateLogs, setMaibotModuleUpdateLogs] = useState<string[]>([]);
  const [messagePlatformDialogOpen, setMessagePlatformDialogOpen] = useState(false);
  const [pendingProtocolSwitch, setPendingProtocolSwitch] = useState<QqProtocol | null>(null);
  const [officialAppId, setOfficialAppId] = useState("");
  const [officialAppSecret, setOfficialAppSecret] = useState("");
  const [mascotIntroOpen, setMascotIntroOpen] = useState(false);
  const [, setMascotClickCount] = useState(0);
  const [messagePlatformBackend, setMessagePlatformBackend] = useState<QqBackend | "official">("napcat");
  const currentProtocol = snapshot.initState.qqProtocol ?? snapshot.initState.qqBackend ?? "napcat";
  const [selectedProtocol, setSelectedProtocol] = useState<QqProtocol>(currentProtocol);
  useEffect(() => {
    setSelectedProtocol(currentProtocol);
  }, [currentProtocol]);
  const [messagePlatformAccount, setMessagePlatformAccount] = useState(snapshot.initState.qqAccount ?? "");
  const [maibotChannel, setMaibotChannel] = useState<MaiBotUpdateChannel>("stable");
  const [napcatWebuiOpen, setNapcatWebuiOpen] = useState(false);
  const [qqWebuiPort, setQqWebuiPort] = useState(() => readQqWebuiPort(snapshot.initState.qqBackend, snapshot.services.find((service) => service.id === "napcat")?.url));
  const [maibotTags, setMaibotTags] = useState<ModuleTagOption[]>([]);
  const [maibotRefsLoading, setMaibotRefsLoading] = useState(false);
  const [maibotVersionFetchProgress, setMaibotVersionFetchProgress] = useState<MaiBotVersionFetchProgress | null>(null);
  const [selectedMaiBotTag, setSelectedMaiBotTag] = useState("");
  const maibotUpdateInfoRequestRef = useRef(0);
  const appearance = useAppearance();
  const useRetroStyle = usesRetroStructure(appearance.mode);
  const services = snapshot.services ?? [];
  const maibot = services.find((service) => service.id === "maibot");
  const napcat = services.find((service) => service.id === "napcat");
  const adapterPluginId = "maibot-team.snowluma-adapter";
  const adapterName = "QQ 适配器";
  const qqBackend = snapshot.initState.qqBackend ?? "napcat";
  const currentQqWebuiUrl = qqWebuiUrl(napcat?.url, qqBackend, qqWebuiPort);
  const messagePlatformConfigured =
    snapshot.initState.messagePlatformConfigured;
  const qqBackendBusy = Boolean(snapshot.runtimeOperation) ||
    napcat?.status === "starting" || napcat?.status === "running" || napcat?.status === "stopping" || Boolean(napcat?.managed);
  const maibotUpdateBlocked =
    maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping";
  const launcherUpdateBlocked = maibotUpdateBlocked || qqBackendBusy;
  const launcherCurrentTag = versionAsTag(launcherUpdateInfo?.currentVersion ?? snapshot.appVersion);
  const launcherLatestTag =
    launcherUpdateInfo?.latestTag
    ?? versionAsTag(launcherUpdateInfo?.latestVersion)
    ?? snapshot.appLatestTag;
  const launcherDownloadTag =
    launcherUpdateInfo?.downloadTag
    ?? versionAsTag(launcherUpdateInfo?.downloadVersion)
    ?? launcherLatestTag;
  const launcherUsesFallbackAsset = Boolean(
    launcherUpdateInfo?.latestAssetUnavailable
    && launcherLatestTag
    && launcherDownloadTag
    && launcherLatestTag !== launcherDownloadTag,
  );
  const launcherUpdateAvailable =
    launcherUpdateInfo?.available ?? (compareVersionText(launcherLatestTag, launcherCurrentTag) > 0);
  const maibotUpdateAvailable = compareVersionText(
    snapshot.moduleVersions.maibotLatestStableTag,
    snapshot.moduleVersions.maibotLocal,
  ) > 0;
  const maibotSelectedTarget = formatMaiBotSelectedTarget(snapshot);
  const maibotHistoryTags = useMemo(
    () => maibotTags.filter((tag) => !/^Easy/iu.test(tag.name)),
    [maibotTags],
  );
  const defaultMaiBotHistoryTag = maibotHistoryTags[0]?.name;
  const selectedMaiBotHistoryTag = selectedMaiBotTag || defaultMaiBotHistoryTag;
  const selectedMaiBotTarget = useMemo(() => resolveMaiBotUpdateTarget(
    maibotChannel,
    snapshot.moduleVersions.maibotLatestStableTag,
    selectedMaiBotHistoryTag,
  ), [
    maibotChannel,
    snapshot.moduleVersions.maibotLatestStableTag,
    selectedMaiBotHistoryTag,
  ]);
  const maibotTargetIsCurrent =
    selectedMaiBotTarget?.type === "package"
    // 源码实例即使版本号相同，也需要执行迁移。
    && snapshot.moduleVersions.maibotSelectedTarget?.type === "package"
    && snapshot.moduleVersions.maibotSelectedTarget.name === selectedMaiBotTarget.name
    && Boolean(snapshot.moduleVersions.maibotLocal)
    && compareVersionText(selectedMaiBotTarget.name, versionAsTag(snapshot.moduleVersions.maibotLocal)) === 0;

  const maibotVersionOptions = useMemo(() => Array.from(new Set([
    snapshot.moduleVersions.maibotLatestStableTag,
    ...maibotHistoryTags.map((tag) => tag.name),
  ].filter((version): version is string => Boolean(version)))), [snapshot.moduleVersions.maibotLatestStableTag, maibotHistoryTags]);
  useEffect(() => {
    if (!maibotRefsLoading) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setMaibotVersionFetchProgress((current) => {
        if (!current || current.tone !== "loading" || current.value >= 88) {
          return current;
        }
        return {
          ...current,
          value: Math.min(88, current.value + (current.value < 45 ? 3 : 1)),
        };
      });
    }, 500);

    return () => window.clearInterval(timer);
  }, [maibotRefsLoading]);

  useEffect(() => {
    return window.maibotDesktop?.launcher?.onDownloadProgress((progress) => {
      setLauncherDownloadProgress(progress);
    });
  }, []);

  useEffect(() => {
    return window.maibotDesktop?.modules?.onMaiBotUpdateProgress((progress) => {
      setMaibotModuleUpdateProgress(progress);
      const log = progress.log;
      if (log) {
        setMaibotModuleUpdateLogs((current) => (
          current.at(-1) === log
            ? current
            : [...current, log].slice(-20)
        ));
      }
    });
  }, []);

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
    onSnapshot(await getDesktopSnapshot());
  }, [onSnapshot]);

  const openNapcatWebui = useCallback(() => {
    if (napcat?.status !== "running") {
      toast.error(`请先启动 ${napcat?.name ?? "QQ 后端"}`);
      return;
    }
    setNapcatWebuiOpen(true);
  }, [napcat?.name, napcat?.status]);

  useEffect(() => {
    const syncQqWebuiPort = (): void => {
      setQqWebuiPort(readQqWebuiPort(snapshot.initState.qqBackend, snapshot.services.find((service) => service.id === "napcat")?.url));
    };

    syncQqWebuiPort();
    window.addEventListener(QQ_WEBUI_PORT_CHANGE_EVENT, syncQqWebuiPort);
    window.addEventListener("storage", syncQqWebuiPort);
    return () => {
      window.removeEventListener(QQ_WEBUI_PORT_CHANGE_EVENT, syncQqWebuiPort);
      window.removeEventListener("storage", syncQqWebuiPort);
    };
  }, [snapshot.initState.qqBackend, napcat?.url]);

  const checkMaiBotUpdateInfo = useCallback(async (target: ModuleUpdateTarget | undefined = selectedMaiBotTarget) => {
    const requestId = maibotUpdateInfoRequestRef.current + 1;
    maibotUpdateInfoRequestRef.current = requestId;

    if (!window.maibotDesktop?.modules || !target) {
      setMaibotUpdateInfo(null);
      setMaibotUpdateInfoError(null);
      setMaibotUpdateInfoLoading(false);
      return;
    }

    setMaibotUpdateInfoLoading(true);
    setMaibotUpdateInfoError(null);
    try {
      const update = await window.maibotDesktop.modules.checkMaiBotUpdate(target);
      if (maibotUpdateInfoRequestRef.current === requestId) {
        setMaibotUpdateInfo(update);
      }
    } catch (nextError) {
      if (maibotUpdateInfoRequestRef.current === requestId) {
        setMaibotUpdateInfo(null);
        setMaibotUpdateInfoError(messageFromError(nextError));
      }
    } finally {
      if (maibotUpdateInfoRequestRef.current === requestId) {
        setMaibotUpdateInfoLoading(false);
      }
    }
  }, [selectedMaiBotTarget]);

  useEffect(() => {
    if (updateDialog !== "maibot") {
      return;
    }

    void checkMaiBotUpdateInfo();
  }, [checkMaiBotUpdateInfo, updateDialog]);

  const loadMaiBotRefs = useCallback(async () => {
    if (!window.maibotDesktop?.modules || maibotRefsLoading) {
      return;
    }

    setMaibotRefsLoading(true);
    setMaibotVersionFetchProgress({
      value: 8,
      label: "准备获取 MaiBot 更新",
      detail: "正在检查桌面桥和更新源配置。",
      tone: "loading",
    });
    try {
      setMaibotVersionFetchProgress({
        value: 38,
        label: "获取版本信息",
        detail: "正在读取 MaiBot PyPI 包和 Dashboard 版本。",
        tone: "loading",
      });
      const refreshedSnapshot = await window.maibotDesktop.modules.refreshVersions();
      onSnapshot(refreshedSnapshot);

      const maibotRemoteError = refreshedSnapshot.moduleVersions.maibotRemoteError;
      setMaibotVersionFetchProgress({
        value: maibotRemoteError ? 52 : 62,
        label: maibotRemoteError ? "MaiBot 版本获取异常" : "远端版本已返回",
        detail: maibotRemoteError
          ? maibotRemoteError
          : `来源: ${refreshedSnapshot.moduleVersions.maibotRemoteSource ?? "默认更新源"}`,
        tone: maibotRemoteError ? "error" : "loading",
      });
      if (maibotRemoteError && !refreshedSnapshot.moduleVersions.maibotLatestStableTag) {
        throw new Error(`获取 MaiBot 远端版本失败：${maibotRemoteError}`);
      }

      setMaibotVersionFetchProgress({
        value: 74,
        label: "读取可选版本",
        detail: "正在刷新可安装的包版本。",
        tone: "loading",
      });
      const tags = await window.maibotDesktop.modules.listMaiBotTags();
      setMaibotTags(tags);
      const historyTags = tags.filter((tag) => !/^Easy/iu.test(tag.name));
      setSelectedMaiBotTag((current) => (
        current && historyTags.some((tag) => tag.name === current) ? current : historyTags[0]?.name ?? ""
      ));
      setMaibotVersionFetchProgress({
        value: 100,
        label: "获取完成",
        detail: tags.length > 0 ? `已读取 ${tags.length} 个包版本。` : "已完成远端版本刷新。",
        tone: "success",
      });
      window.setTimeout(() => {
        setMaibotVersionFetchProgress((current) => current?.tone === "success" ? null : current);
      }, 1200);
    } catch (nextError) {
      const message = messageFromError(nextError);
      setError(message);
      setMaibotVersionFetchProgress({
        value: 100,
        label: "获取失败",
        detail: message,
        tone: "error",
      });
      setMaibotTags([]);
      setSelectedMaiBotTag("");
    } finally {
      setMaibotRefsLoading(false);
    }
  }, [maibotRefsLoading, onSnapshot]);

  const openMaiBotUpdate = useCallback(() => {
    setError(null);
    setMaibotUpdateInfo(null);
    setMaibotUpdateInfoError(null);
    setMaibotUpdateInfoLoading(false);
    setMaibotVersionFetchProgress(null);
    setMaibotModuleUpdateProgress(null);
    setMaibotModuleUpdateLogs([]);
    setMaibotChannel("stable");
    setSelectedMaiBotTag("");
    const storedTarget = snapshot.moduleVersions.maibotSelectedTarget;
    if (storedTarget?.type === "package" && storedTarget.name !== snapshot.moduleVersions.maibotLatestStableTag) {
      setSelectedMaiBotTag(storedTarget.name);
    }
    setUpdateDialog("maibot");
    void loadMaiBotRefs();
  }, [
    loadMaiBotRefs,
    snapshot.moduleVersions.maibotLatestStableTag,
    snapshot.moduleVersions.maibotSelectedTarget,
  ]);

  const openLauncherUpdate = useCallback(() => {
    setError(null);
    setLauncherDownloadProgress(null);
    setLauncherNetworkFailed(false);
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

  const openMaiBotRelease = useCallback(() => {
    const releaseUrl = maibotUpdateInfo?.releaseUrl?.trim();
    if (releaseUrl) {
      void window.maibotDesktop?.openExternal(releaseUrl);
      return;
    }

    const target = selectedMaiBotTarget;
    const url = target
      ? `https://pypi.org/project/maibot/${encodeURIComponent(target.name)}/`
      : "https://pypi.org/project/maibot/";
    void window.maibotDesktop?.openExternal(url);
  }, [maibotUpdateInfo?.releaseUrl, selectedMaiBotTarget]);

  const checkLauncherUpdate = useCallback(async () => {
    setLauncherNetworkFailed(false);
    if (!window.maibotDesktop?.launcher) {
      setError("桌面桥未就绪，无法检查启动器更新");
      return;
    }

    setBusy("launcher:check");
    setError(null);
    try {
      const update = await window.maibotDesktop.launcher.checkUpdate();
      setLauncherUpdateInfo(update);
      const latestLabel = update.latestTag ?? update.latestVersion ?? "";
      const downloadLabel = update.downloadTag ?? update.downloadVersion ?? latestLabel;
      toast.success(update.available
        ? update.latestAssetUnavailable && latestLabel !== downloadLabel
          ? `最新版本 ${latestLabel} 暂无当前平台安装包，可下载 ${downloadLabel}`
          : `发现新版本 ${latestLabel}`
        : update.latestAssetUnavailable
          ? `最新版本 ${latestLabel} 暂无当前平台安装包`
        : "启动器已是最新版本");
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
      setLauncherNetworkFailed(isLikelyNetworkError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const installLauncherUpdate = useCallback(async () => {
    setLauncherNetworkFailed(false);
    if (!window.maibotDesktop?.launcher) {
      setError("桌面桥未就绪，无法安装启动器更新");
      return;
    }
    if (launcherUpdateBlocked) {
      setError("请先停止 MaiBot Core 和 QQ 后端，再更新一键包。");
      return;
    }

    setBusy("launcher:update");
    setError(null);
    setLauncherDownloadProgress({
      phase: "checking",
      receivedBytes: 0,
    });
    try {
      const result = await window.maibotDesktop.launcher.downloadAndInstallUpdate();
      setLauncherUpdateInfo(result.update);
      if (result.willQuit) {
        toast.success("安装包已打开，启动器即将退出");
        return;
      }
      setBusy(null);
      if (snapshot.platform === "darwin") {
        setUpdateDialog(null);
        setLauncherQuitPromptOpen(true);
      } else {
        toast.success("安装包已打开");
      }
    } catch (nextError) {
      setError(messageFromError(nextError));
      setLauncherNetworkFailed(isLikelyNetworkError(nextError));
      setLauncherDownloadProgress(null);
      setBusy(null);
    }
  }, [launcherUpdateBlocked, snapshot.platform]);

  const quitAfterLauncherUpdate = useCallback(async () => {
    if (!window.maibotDesktop?.launcher) {
      setError("桌面桥未就绪，无法退出启动器");
      return;
    }
    setBusy("launcher:quit");
    setError(null);
    try {
      await window.maibotDesktop.launcher.quit();
    } catch (nextError) {
      setError(messageFromError(nextError));
      setBusy(null);
    }
  }, []);

  const openMessagePlatformDialog = useCallback((backend: QqBackend = snapshot.initState.qqBackend) => {
    setError(null);

    setMessagePlatformBackend(backend);
    setMessagePlatformAccount(backend === snapshot.initState.qqBackend ? snapshot.initState.qqAccount ?? "" : "");
    setMessagePlatformDialogOpen(true);
  }, [snapshot.initState.qqAccount, snapshot.initState.qqBackend]);

  useEffect(() => {
    const openRequestedGuide = (event?: Event): void => {
      let request = (event as CustomEvent<QqBackend> | undefined)?.detail;
      try {
        const stored = localStorage.getItem(MESSAGE_PLATFORM_GUIDE_REQUEST_KEY);
        if (!event && !stored) return;
        if (!request && (stored === "napcat" || stored === "snowluma")) request = stored;
        localStorage.removeItem(MESSAGE_PLATFORM_GUIDE_REQUEST_KEY);
      } catch {
        if (!event) return;
      }
      openMessagePlatformDialog(request);
    };

    openRequestedGuide();
    window.addEventListener(MESSAGE_PLATFORM_GUIDE_EVENT, openRequestedGuide);
    return () => {
      window.removeEventListener(MESSAGE_PLATFORM_GUIDE_EVENT, openRequestedGuide);
    };
  }, [openMessagePlatformDialog]);

  const closeMessagePlatformDialog = useCallback(() => {
    if (busy === "message-platform:setup") return;
    setMessagePlatformDialogOpen(false);
    setOfficialAppId("");
    setOfficialAppSecret("");
    setError(null);

    if (pendingProtocolSwitch !== null) {
      setSelectedProtocol(pendingProtocolSwitch);
      setPendingProtocolSwitch(null);
      toast.info("未完成账号配置，已取消切换并保留原协议端");
    }
  }, [busy, pendingProtocolSwitch]);

  const setupMessagePlatform = useCallback(async () => {
    if (messagePlatformBackend === "official") {
      if (!officialAppId.trim() || !officialAppSecret.trim()) {
        setError("请填写 AppID 和 AppSecret");
        return;
      }
      setBusy("message-platform:setup");
      setError(null);
      try {
        if (!window.maibotDesktop) throw new Error("桌面桥未就绪");
        await saveQqProtocol("official", { officialCredentials: { appId: officialAppId, appSecret: officialAppSecret } });
        setPendingProtocolSwitch(null);
        await refreshSnapshot();
        setMessagePlatformDialogOpen(false);
        setOfficialAppId("");
        setOfficialAppSecret("");
        toast.success("官方适配器已配置并保存");
      } catch (nextError) {
        setError(messageFromError(nextError));
      } finally {
        setBusy(null);
      }
      return;
    }
    const qqAccount = normalizeQqAccount(messagePlatformAccount);
    if (!qqAccount) {
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
      await window.maibotDesktop.protocols.setQqAccount({
        qqAccount,
        qqBackend: messagePlatformBackend,
      });
      // Adding a platform is an explicit connection workflow; MaiBot owns adapter validation and activation.
      await window.maibotDesktop.adapters.syncQqConnections();
      await window.maibotDesktop.adapters.setEnabled("onebot", true);
      setPendingProtocolSwitch(null);
      await window.maibotDesktop.services.start("napcat");
      toast.success(`${messagePlatformBackend === "snowluma" ? "QQ-SnowLuma" : "QQ-NapCat"} 已配置并启动`);
      setMessagePlatformDialogOpen(false);
      await refreshSnapshot();
      if (messagePlatformBackend === "snowluma") {
        setQqWebuiPort(readQqWebuiPort("snowluma"));
        setNapcatWebuiOpen(true);
      }
    } catch (nextError) {
      const message = messageFromError(nextError);
      setError(message);
      toast.error(message);
      await refreshSnapshot().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }, [messagePlatformAccount, messagePlatformBackend, officialAppId, officialAppSecret, refreshSnapshot]);

  const saveProtocolSelection = useCallback(async () => {
    if (!window.maibotDesktop || qqBackendBusy) return;
    const savedAccounts = selectedProtocol !== "official" ? await window.maibotDesktop.protocols.getLoginInfo().catch((error) => {
      setError(messageFromError(error));
      return null;
    }) : null;
    if (selectedProtocol !== "official" && !savedAccounts) return;
    const targetAccount = selectedProtocol !== "official"
      ? normalizeQqAccount(savedAccounts?.[selectedProtocol].qqAccount) ?? ""
      : "";
    const targetAccountValid = Boolean(targetAccount);
    if (selectedProtocol === currentProtocol && (selectedProtocol === "official" ? snapshot.initState.qqOfficialConfigured : targetAccountValid)) return;
    if (selectedProtocol === "official" && snapshot.initState.qqOfficialConfigured === false) {
      setPendingProtocolSwitch(currentProtocol);
      setMessagePlatformBackend("official");
      setOfficialAppId("");
      setOfficialAppSecret("");
      setError(null);

      setMessagePlatformDialogOpen(true);
      return;
    }
    if (selectedProtocol !== "official" && !targetAccountValid) {
      setPendingProtocolSwitch(currentProtocol);
      setMessagePlatformBackend(selectedProtocol);
      setMessagePlatformAccount(targetAccount);
      setError(null);

      setMessagePlatformDialogOpen(true);
      return;
    }
    setBusy("message-platform:protocol");
    setError(null);
    try {
      if (selectedProtocol === "snowluma") {
        await window.maibotDesktop.protocols.setQqAccount({ qqAccount: targetAccount, qqBackend: "snowluma" });
        await window.maibotDesktop.init.repair();
        await window.maibotDesktop.services.start("napcat");
        setQqWebuiPort(readQqWebuiPort("snowluma"));
      } else {
        await saveQqProtocol(selectedProtocol);
      }
      await refreshSnapshot();
      if (selectedProtocol === "snowluma") setNapcatWebuiOpen(true);
      toast.success("协议端已保存");
    } catch (nextError) {
      setError(messageFromError(nextError));
      await refreshSnapshot().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }, [currentProtocol, selectedProtocol, qqBackendBusy, refreshSnapshot, snapshot.initState.messagePlatformConfigured, snapshot.initState.qqAccount, snapshot.initState.qqOfficialConfigured]);

  const updateMaiBot = useCallback(async () => {
    const target = selectedMaiBotTarget;
    if (!window.maibotDesktop?.modules || !target) {
      setError("没有可用的目标版本");
      return;
    }
    setBusy("maibot:update");
    setError(null);
    setMaibotModuleUpdateLogs(["准备安装指定 PyPI 版本。"]);
    setMaibotModuleUpdateProgress({
      phase: "preparing",
      percent: 2,
      label: "准备更新 MaiBot",
      detail: "准备安装指定 PyPI 版本。",
      updatedAt: Date.now(),
    });
    try {
      await window.maibotDesktop.modules.updateMaiBot(target);
      toast.success("MaiBot 更新完成");
      await refreshSnapshot();
    } catch (nextError) {
      const message = messageFromError(nextError);
      setError(message);
      setMaibotModuleUpdateLogs((current) => (
        current.at(-1) === "更新未完成，请根据错误信息检查网络或更新源。"
          ? current
          : [...current, "更新未完成，请根据错误信息检查网络或更新源。"].slice(-20)
      ));
      setMaibotModuleUpdateProgress((current) => current?.phase === "failed"
        ? current
        : {
            phase: "failed",
            percent: current?.percent ?? 0,
            label: "MaiBot 更新失败",
            detail: message,
            log: "更新未完成，请根据错误信息检查网络或更新源。",
            updatedAt: Date.now(),
          });
    } finally {
      setBusy(null);
    }
  }, [
    refreshSnapshot,
    selectedMaiBotTarget,
  ]);

  const messagePlatformCard = snapshot.initState.qqProtocol === "official" ? (
    <section className={cn("flex items-center justify-between gap-4 p-4", useRetroStyle ? "retro-panel" : "rounded-lg border border-border bg-card")}>
      <h2 className="text-xl font-semibold">QQ 官方适配器</h2>
      <Button onClick={() => onOpenPluginConfig(QQ_OFFICIAL_ADAPTER_PLUGIN_ID)} size="sm" variant="secondary">配置</Button>
    </section>
  ) : messagePlatformConfigured ? (
          <ServiceSummary
            adapterAction={{
              title: `${adapterName.replace(/\s+/gu, "")}设置`,
              label: "配置",
              onClick: () => onOpenPluginConfig(adapterPluginId),
            }}
            icon={null}
            retro={useRetroStyle}
            service={napcat}
            serviceControls={napcat ? {
              busy: serviceActionBusy?.startsWith(`${napcat.id}:`) ?? false,
              onStart: onStartService,
              onStop: onStopService,
            } : undefined}
            terminalAction={{
              label: "终端",
              onClick: () => onOpenTerminalSession("service:napcat"),
            }}
            webuiAction={{
              title: `${napcat?.name ?? "NapCat"} 设置`,
              label: "WebUI",
              onClick: openNapcatWebui,
            }}
            stoppedStatusAfterTitle
          />
        ) : (
          <MessagePlatformConnectCard onClick={() => openMessagePlatformDialog()} retro={useRetroStyle} />
        );

  const maibotUpdateNotesPanel = (
    <div className={cn(useRetroStyle ? "retro-control grid max-h-[min(36vh,320px)] min-h-0 content-start gap-2 overflow-auto p-3" : "grid max-h-[min(36vh,320px)] min-h-0 content-start gap-2 overflow-auto rounded-lg border border-border bg-muted/40 p-3")}>
      {maibotUpdateInfoLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          正在读取更新说明...
        </div>
      ) : maibotUpdateInfoError ? (
        <div className={cn("border border-warning/40 bg-warning/15 px-3 py-2 text-xs", useRetroStyle ? "rounded-sm" : "rounded-lg")}>
          <p>更新说明读取失败：{maibotUpdateInfoError}</p>
          <Button className="mt-2" disabled={busy !== null || !selectedMaiBotTarget} onClick={() => void checkMaiBotUpdateInfo()} size="sm" variant="secondary">
            <RefreshCw />
            重试
          </Button>
        </div>
      ) : maibotUpdateInfo?.releaseNotes ? (
        <MarkdownRenderer
          className="break-words pr-1 text-xs"
          content={maibotUpdateInfo.releaseNotes}
        />
      ) : maibotUpdateInfo ? (
        <p className="text-xs text-muted-foreground">这个目标版本没有可展示的 Release 更新说明。</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {maibotChannel === "stable" && !selectedMaiBotTarget
            ? "尚未获取到正式 Release，请等待版本查询完成或重试。"
            : "选择目标版本后会在这里显示更新说明。"}
        </p>
      )}
    </div>
  );

  return (
    <>
      {coreToolbarTarget ? createPortal(
        <MaiBotOverviewCard
          localVersion={snapshot.moduleVersions.maibotLocal}
          launcherVersion={snapshot.appVersion}
          retro={useRetroStyle}
        />,
        coreToolbarTarget,
      ) : null}
      {updateToolbarTarget ? createPortal(
        <Button
          aria-label="更新 MaiBot"
          className={cn("relative", useRetroStyle ? "retro-top-action" : "size-7")}
          disabled={busy === "maibot:update"}
          onClick={openMaiBotUpdate}
          size="icon-sm"
          title="更新 MaiBot"
          variant="secondary"
        >
          {compareVersionText(snapshot.moduleVersions.maibotLatestStableTag, snapshot.moduleVersions.maibotLocal) > 0 ? (
            <span className="absolute right-0 top-0 size-1.5 rounded-full bg-warning" />
          ) : null}
          {busy === "maibot:update" ? <Loader2 className="animate-spin" /> : <SolidUpgradeIcon />}
        </Button>,
        updateToolbarTarget,
      ) : null}
      <div className={cn("relative h-full overflow-auto px-5 py-4", !useRetroStyle && "bg-background", active ? "block" : "hidden")}>
        <div className="mx-auto w-full max-w-5xl pb-40">
          {messagePlatformCard}
          {messagePlatformConfigured || snapshot.initState.qqProtocol === "official" ? (
            <>
              <section className={cn("mt-4 flex flex-wrap items-center justify-between gap-3 p-4", useRetroStyle ? "retro-panel" : "rounded-lg border border-border bg-card")}>
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold">协议端选择</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedProtocol === "snowluma" ? "使用 SnowLuma 注入 QQ 进程。" : selectedProtocol === "official" ? "直连 QQ 开放平台，使用 AppID 和 AppSecret 配置。" : "使用 NapCat 启动 QQ 与 OneBot 连接。"}
                  </p>
                </div>
                <div aria-label="QQ 协议端" className="grid w-full grid-cols-3 overflow-hidden rounded-md border border-border sm:w-auto" role="group">
                  {([{ value: "napcat", label: "NapCat" }, { value: "snowluma", label: "SnowLuma" }, { value: "official", label: "官方 QQ 适配器" }] as const).map((option) => (
                    <button
                      aria-pressed={selectedProtocol === option.value}
                      className={cn("px-4 py-2 text-xs font-semibold transition-colors", selectedProtocol === option.value ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-accent", "disabled:cursor-not-allowed disabled:opacity-50")}
                      disabled={busy !== null || (qqBackendBusy && option.value !== currentProtocol)}
                      key={option.value}
                      onClick={() => setSelectedProtocol(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <Button disabled={busy !== null || qqBackendBusy || (selectedProtocol === currentProtocol && (selectedProtocol === "official" ? snapshot.initState.qqOfficialConfigured : Boolean(normalizeQqAccount(snapshot.initState.qqAccount))))} onClick={() => void saveProtocolSelection()} size="sm" variant="secondary">
                  {busy === "message-platform:protocol" ? <Loader2 className="animate-spin" /> : <PackageCheck />}
                  保存协议端
                </Button>
                {qqBackendBusy ? <p className="w-full text-xs text-muted-foreground">{snapshot.runtimeOperation ? `正在${snapshot.runtimeOperation}，请稍候。` : "请先停止当前 QQ 协议端，再切换。"}</p> : null}
                {error && !messagePlatformDialogOpen ? <p className="w-full text-xs text-destructive">{error}</p> : null}
              </section>
              <div className="mt-4 flex justify-end">
                <MessagePlatformAdvancedSettings snapshot={snapshot} refreshSnapshot={refreshSnapshot} disabled={busy !== null} />
              </div>
              {currentProtocol === "napcat" ? (
                <aside className={cn("mt-4 space-y-4 !border-0 !bg-amber-100 p-5 !text-amber-950 dark:!bg-amber-950 dark:!text-amber-100", useRetroStyle ? "retro-panel" : "rounded-lg")}>
                  <h2 className="flex items-center gap-2 text-xl font-bold">
                    <AlertTriangle className="size-6 shrink-0" />
                    注意
                  </h2>
                  <div className="space-y-3 text-sm leading-relaxed">
                    <p><strong className="font-bold">NapCat一键配置可能在未来一键包被移除</strong>，推荐使用<strong className="font-bold">Snowluma或官方QQ bot平台</strong>连接。</p>
                    <p>不过NapCat连接方法仍旧可以，你可以单独部署NapCat，使用Snowluma适配器连接到MaiBot</p>
                  </div>
                </aside>
              ) : null}
            </>
          ) : null}
        </div>
        {useRetroStyle ? (
          <div className="absolute bottom-6 right-6 h-24 w-[104px]">
            <ElasticMascot
              className="!h-24 !w-[104px]"
              onLongPress={onEnterFloatingMode}
              onSecretTap={handleMascotSecretTap}
              placement="retro-column"
            />
          </div>
        ) : (
          <ElasticMascot onLongPress={onEnterFloatingMode} onSecretTap={handleMascotSecretTap} />
        )}
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
            <div className={cn(useRetroStyle ? "retro-control flex items-center gap-4 p-4" : "flex items-center gap-4 rounded-lg border border-border bg-muted/35 p-4")}>
              <div className={cn("relative h-24 w-24 shrink-0 overflow-hidden bg-background", useRetroStyle ? "rounded-sm" : "rounded-md")}>
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
                  平时窝在消息平台页面右下角，陪你盯着服务状态、WebUI 和插件更新。
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

      <Dialog
        open={messagePlatformDialogOpen}
        onOpenChange={(next) => {
          if (!next) closeMessagePlatformDialog();
        }}
      >
        <DialogContent aria-describedby={undefined} className="grid-rows-[minmax(0,1fr)_auto]" size="lg">
          <DialogTitle className="sr-only">新增消息平台</DialogTitle>
          <DialogBody className="space-y-4 pt-12">
            {error && messagePlatformDialogOpen ? (
              <div className={cn("border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive", useRetroStyle ? "rounded-sm" : "rounded-lg")}>
                {error}
              </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                {
                  backend: "snowluma",
                  title: "QQ-SnowLuma",
                  description: "使用最新Snowluma连接QQ，需要下载QQ并登录，使用WS连接到MaiBot",
                },
                {
                  backend: "napcat",
                  title: "QQ-NapCat",
                  description: "通过NapCat连接QQ，不需要额外下载QQ客户端，直接扫码登录，使用WS连接到MaiBot",
                },
                {
                  backend: "official",
                  title: "QQ-官方适配器",
                  description: "直连 QQ 开放平台，无需 QQ 客户端，使用 AppID 和 AppSecret 配置。",
                },
              ] as const).map((option) => (
                <button
                  data-slot="choice-card"
                  aria-pressed={messagePlatformBackend === option.backend}
                  className={cn(
                    cn(useRetroStyle ? "rounded-sm" : "rounded-lg", "relative border p-3 pt-9 text-left transition-colors"),
                    messagePlatformBackend === option.backend
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  )}
                  disabled={busy === "message-platform:setup"}
                  key={option.backend}
                  onClick={() => {
                    setMessagePlatformBackend(option.backend);
                    setError(null);

                  }}
                  type="button"
                >
                  {option.backend === "snowluma" || option.backend === "official" ? (
                    <span className="absolute -left-2 -top-3 rounded-sm border border-primary-foreground/20 bg-primary px-3 py-1.5 text-xs font-bold leading-none text-primary-foreground shadow-sm">
                      {option.backend === "official" ? "稳定" : "推荐"}
                    </span>
                  ) : null}
                  <span className="block text-sm font-semibold">{option.title}</span>
                  <span className="mt-1 block text-xs leading-relaxed">{option.description}</span>
                </button>
              ))}
            </div>
            {messagePlatformBackend !== "official" ? <label className="grid gap-1.5 text-xs font-medium">
              机器人 QQ 号
              <Input
                disabled={busy === "message-platform:setup"}
                inputMode="numeric"
                monospace
                onChange={(event) => setMessagePlatformAccount(event.target.value)}
                placeholder="例如 123456789"
                value={messagePlatformAccount}
              />
              {messagePlatformBackend === "snowluma" ? <span className="font-normal text-muted-foreground">请先在 QQ 客户端登录此账号。SnowLuma 会持续检测并只自动注入此账号，QQ 后续启动或重启也会检测。</span> : null}
            </label> : null}
            {messagePlatformBackend === "official" ? (
              <OfficialQqCredentialsFields appId={officialAppId} appSecret={officialAppSecret} onAppIdChange={setOfficialAppId} onAppSecretChange={setOfficialAppSecret} disabled={busy === "message-platform:setup"} />
            ) : null}
            {qqBackendBusy ? (
              <div className={cn("border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning-foreground", useRetroStyle ? "rounded-sm" : "rounded-lg")}>
                QQ 后端正在运行，请先停止后再新增或切换消息平台。
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy === "message-platform:setup"} onClick={closeMessagePlatformDialog} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              disabled={busy === "message-platform:setup" || qqBackendBusy || (messagePlatformBackend !== "official" && !messagePlatformAccount.trim()) || (messagePlatformBackend === "official" && (!officialAppId.trim() || !officialAppSecret.trim()))}
              onClick={() => void setupMessagePlatform()}
              size="sm"
            >
              {busy === "message-platform:setup" ? <Loader2 className="animate-spin" /> : <Server />}
              {messagePlatformBackend === "official" ? "配置并保存" : "配置并启动"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={launcherQuitPromptOpen}
        onOpenChange={(next) => {
          if (busy !== "launcher:quit") setLauncherQuitPromptOpen(next);
        }}
      >
        <DialogContent onInteractOutside={(event) => event.preventDefault()} size="sm">
          <DialogHeader
            description="请关闭当前启动器并拖拽替换。安装完成后再重新打开 MaiBot OneKey。"
            icon={<PackageCheck className="size-4" />}
            title="安装包已打开"
            tone="primary"
          />
          <DialogBody className="space-y-3 text-sm text-muted-foreground">
            {error ? (
              <div className={cn("border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive", useRetroStyle ? "rounded-sm" : "rounded-lg")}>
                {error}
              </div>
            ) : null}
            <p>请在打开的 DMG 窗口中，把新版应用拖拽替换到 Applications。</p>
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={busy === "launcher:quit"}
              onClick={() => setLauncherQuitPromptOpen(false)}
              size="sm"
              variant="ghost"
            >
              稍后退出
            </Button>
            <Button
              disabled={busy === "launcher:quit"}
              onClick={() => void quitAfterLauncherUpdate()}
              size="sm"
            >
              {busy === "launcher:quit" ? <Loader2 className="animate-spin" /> : <X />}
              退出启动器
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={updateDialog !== null}
        onOpenChange={(next) => {
          if (
            !next
            && busy !== "maibot:update"
            && busy !== "launcher:check"
            && busy !== "launcher:update"
          ) {
            setUpdateDialog(null);
          }
        }}
      >
        <DialogContent
          onInteractOutside={(event) => event.preventDefault()}
          showCloseButton={false}
          size="xl"
          className="sm:max-w-[624px]"
        >
          <div>
            <button
              aria-label="关闭更新窗口"
              className="absolute right-3 top-5 z-10 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => setUpdateDialog(null)}
              type="button"
            >
              <X className="size-4" />
            </button>
            <div className="grid grid-cols-2 gap-2 py-5 pl-5 pr-14">
              <button
                aria-pressed={updateDialog === "maibot"}
                data-slot="update-tab"
                className={cn(
                  "flex min-w-0 items-center justify-between gap-3 border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  useRetroStyle ? "rounded-sm" : "rounded-lg",
                  updateDialog === "maibot"
                    ? "border-primary bg-primary/10 text-foreground shadow-sm"
                    : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted/50",
                )}
                disabled={busy !== null}
                onClick={openMaiBotUpdate}
                type="button"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className={cn(
                    "grid size-8 shrink-0 place-items-center",
                    updateDialog === "maibot" ? "bg-foreground/10 text-inherit" : "bg-primary/10 text-primary",
                  )}>
                    <Radar className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">MaiBot 更新</span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] opacity-70">
                      {valueOrFallback(snapshot.moduleVersions.maibotLocal)} → {valueOrFallback(snapshot.moduleVersions.maibotLatestStableTag)}
                    </span>
                  </span>
                </span>
                {maibotUpdateAvailable ? (
                  <span className={cn("shrink-0 bg-warning px-1.5 py-1 text-[10px] font-semibold leading-none text-warning-foreground", useRetroStyle ? "rounded-none" : "rounded-sm")}>
                    有更新
                  </span>
                ) : null}
              </button>
              <button
                aria-pressed={updateDialog === "launcher"}
                data-slot="update-tab"
                className={cn(
                  "flex min-w-0 items-center justify-between gap-3 border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  useRetroStyle ? "rounded-sm" : "rounded-lg",
                  updateDialog === "launcher"
                    ? "border-primary bg-primary/10 text-foreground shadow-sm"
                    : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted/50",
                )}
                disabled={busy !== null}
                onClick={openLauncherUpdate}
                type="button"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className={cn(
                    "grid size-8 shrink-0 place-items-center",
                    updateDialog === "launcher" ? "bg-foreground/10 text-inherit" : "bg-primary/10 text-primary",
                  )}>
                    <PackageCheck className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">启动器更新</span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] opacity-70">
                      {valueOrFallback(launcherCurrentTag)} → {valueOrFallback(launcherLatestTag)}
                    </span>
                  </span>
                </span>
                {launcherUpdateAvailable ? (
                  <span className={cn("shrink-0 bg-warning px-1.5 py-1 text-[10px] font-semibold leading-none text-warning-foreground", useRetroStyle ? "rounded-none" : "rounded-sm")}>
                    有更新
                  </span>
                ) : null}
              </button>
            </div>
            <DialogTitle className="sr-only">{updateDialog === "launcher" ? "启动器更新" : "MaiBot 更新"}</DialogTitle>
          </div>
          {updateDialog === "launcher" ? (
            <>
              <DialogBody className="space-y-4">
                {error ? (
                  <div className={cn("border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive", useRetroStyle ? "rounded-sm" : "rounded-lg")}>
                    {error}
                  </div>
                ) : null}
                {launcherNetworkFailed ? (
                  <div className={cn(
                    "grid gap-3 border border-warning/40 bg-warning/15 px-3 py-3 text-xs",
                    useRetroStyle ? "rounded-sm" : "rounded-lg",
                  )}>
                    <div className="grid gap-1">
                      <p className="font-medium text-warning-foreground">自动更新未完成</p>
                      <p className="text-muted-foreground">
                        可能是网络连接问题。你可以前往 GitHub Releases 手动下载安装包完成更新。
                      </p>
                    </div>
                    <Button className="justify-self-start" onClick={openLauncherRelease} size="sm" variant="secondary">
                      <ExternalLink />
                      前往发布页
                    </Button>
                  </div>
                ) : null}
                <div className={cn(useRetroStyle ? "retro-control grid gap-2 p-3 text-xs" : "grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs")}>
                  <DetailRow label="本地版本" value={launcherCurrentTag} retro={useRetroStyle} />
                  <DetailRow label="最新版本" value={launcherLatestTag} retro={useRetroStyle} />
                  {launcherUsesFallbackAsset ? (
                    <DetailRow label="可用版本" value={launcherDownloadTag} retro={useRetroStyle} />
                  ) : null}
                  <div className="my-1 border-t border-border/70" />
                  <DetailRow label="发布版本" value={launcherUpdateInfo?.releaseName ?? launcherLatestTag} retro={useRetroStyle} />
                  <DetailRow label="安装包" value={launcherUpdateInfo?.assetName} retro={useRetroStyle} />
                  <DetailRow label="大小" value={formatFileSize(launcherUpdateInfo?.assetSize)} retro={useRetroStyle} />
                  <DetailRow label="更新源" value={launcherUpdateInfo?.source ?? snapshot.appLatestSource} retro={useRetroStyle} />
                </div>
                {launcherUsesFallbackAsset ? (
                  <div className={cn(useRetroStyle ? "retro-control grid gap-1 p-3 text-xs" : "grid gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100")}>
                    <p className="font-medium">最新版本暂不可下载</p>
                    <p>
                      最新版本是 {launcherLatestTag}，{launcherLatestTag} 版本暂无可用内容，是否下载可用最新版本 {launcherDownloadTag}？
                    </p>
                  </div>
                ) : null}
                {launcherDownloadProgress ? (
                  <LauncherDownloadProgressDetails progress={launcherDownloadProgress} retro={useRetroStyle} />
                ) : null}
                {launcherUpdateInfo?.releaseNotes ? (
                  <div className={cn(useRetroStyle ? "retro-control grid gap-2 p-3" : "grid gap-2 rounded-lg border border-border bg-muted/40 p-3")}>
                    <p className="text-xs font-medium">更新说明</p>
                    <MarkdownRenderer className="max-h-48 overflow-auto break-words pr-1 text-xs" content={launcherUpdateInfo.releaseNotes} />
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
                  disabled={busy !== null || !launcherUpdateAvailable || launcherUpdateBlocked}
                  onClick={() => void installLauncherUpdate()}
                  size="sm"
                >
                  {busy === "launcher:update" ? <Loader2 className="animate-spin" /> : <Download />}
                  {launcherUsesFallbackAsset ? "下载可用版本" : "下载并打开"}
                </Button>
              </DialogFooter>
            </>
          ) : (
          <>
            <DialogBody className="grid gap-4">
            {error && updateDialog === "maibot" ? (
              <div className={cn("border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive", useRetroStyle ? "rounded-sm" : "rounded-lg")}>
                {error}
              </div>
            ) : null}
            <div className={cn(useRetroStyle ? "retro-control grid gap-2 p-3 text-sm" : "grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm")}>
              <DetailRow label="本地版本" value={snapshot.moduleVersions.maibotLocal} retro={useRetroStyle} valueClassName={cn("text-base", !useRetroStyle && "text-primary")} />
              <DetailRow label="上次更新版本" value={maibotSelectedTarget} retro={useRetroStyle} valueClassName="text-base" />
              <div className="my-1 border-t border-border/70" />
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">目标版本</span>
                <div className="flex min-w-0 items-center gap-2">
                  <span className={cn("truncate text-base", useRetroStyle ? "retro-value" : "font-mono font-semibold text-primary")}>
                    {valueOrFallback(selectedMaiBotTarget?.name)}
                  </span>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <Button aria-label="选择 MaiBot 更新版本" disabled={busy !== null || maibotRefsLoading || maibotVersionOptions.length === 0} size="icon-sm" variant="outline">
                        <ChevronDown className="size-4" />
                      </Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="end" className={cn("z-[110] max-h-64 min-w-40 overflow-y-auto border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg", useRetroStyle ? "rounded-none" : "rounded-md")} sideOffset={4}>
                        <DropdownMenu.RadioGroup
                          value={selectedMaiBotTarget?.name ?? ""}
                          onValueChange={(version) => {
                            setMaibotModuleUpdateProgress(null);
                            setMaibotModuleUpdateLogs([]);
                            setSelectedMaiBotTag(version);
                            setMaibotChannel(version === snapshot.moduleVersions.maibotLatestStableTag ? "stable" : "other");
                          }}
                        >
                          {maibotVersionOptions.map((version) => (
                            <DropdownMenu.RadioItem className="flex cursor-pointer items-center gap-2 px-3 py-2 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:font-semibold" key={version} value={version}>
                              <span className="w-3"><DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator></span>
                              {version}{version === snapshot.moduleVersions.maibotLatestStableTag ? "（最新正式版）" : maibotHistoryTags.find((tag) => tag.name === version)?.isPrerelease ? "（预发布）" : ""}
                            </DropdownMenu.RadioItem>
                          ))}
                        </DropdownMenu.RadioGroup>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
              <DetailRow label="版本查询源" value={snapshot.moduleVersions.maibotRemoteSource ?? maibotUpdateInfo?.source} retro={useRetroStyle} />
              {snapshot.moduleVersions.maibotRemoteError ? (
                <DetailRow label="远端错误" value={snapshot.moduleVersions.maibotRemoteError} retro={useRetroStyle} />
              ) : null}
            </div>
            {maibotUpdateBlocked ? (
              <div className={cn("border border-warning/40 bg-warning/15 px-3 py-2 text-xs", useRetroStyle ? "rounded-sm" : "rounded-lg")}>
                请先停止 MaiBot Core，再执行更新。
              </div>
            ) : null}
            {maibotModuleUpdateProgress || maibotVersionFetchProgress ? <div className={cn("transition-[height] duration-200 motion-reduce:transition-none", maibotModuleUpdateProgress ? "h-40" : "h-20")}>
              {maibotModuleUpdateProgress ? (
                <div
                  aria-live="polite"
                  className={cn(
                    "grid h-full min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-2 border px-3 py-2 text-xs",
                    useRetroStyle ? "retro-control rounded-sm" : "rounded-lg",
                    maibotModuleUpdateProgress.phase === "failed"
                      ? "border-destructive/30 bg-destructive/10"
                      : maibotModuleUpdateProgress.phase === "completed"
                        ? "border-success/30 bg-success/10"
                        : "border-border bg-muted/40",
                  )}
                  role="status"
                >
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                      {maibotModuleUpdateProgress.phase === "completed" ? (
                        <CheckCircle2 className="size-3.5 shrink-0 text-success-foreground" />
                      ) : maibotModuleUpdateProgress.phase === "failed" ? (
                        <CircleAlert className="size-3.5 shrink-0 text-destructive" />
                      ) : (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
                      )}
                      <span className="truncate">{maibotModuleUpdateProgress.label}</span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {Math.round(maibotModuleUpdateProgress.percent)}%
                    </span>
                  </div>
                  <Progress
                    className={cn(
                      "h-1.5",
                      maibotModuleUpdateProgress.phase === "failed"
                        && "[&_[data-slot=progress-indicator]]:bg-destructive",
                    )}
                    value={maibotModuleUpdateProgress.percent}
                  />
                  <p
                    className={cn(
                      "truncate",
                      maibotModuleUpdateProgress.phase === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                    title={maibotModuleUpdateProgress.detail}
                  >
                    {maibotModuleUpdateProgress.detail ?? "正在执行更新任务。"}
                  </p>
                  <div className="min-h-0 overflow-auto border-t border-border/60 pt-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                    {maibotModuleUpdateLogs.length > 0 ? (
                      maibotModuleUpdateLogs.slice(-5).map((line, index) => (
                        <p className="break-words" key={`${index}-${line}`}>
                          <span aria-hidden="true" className="mr-1 text-primary">›</span>
                          {line}
                        </p>
                      ))
                    ) : (
                      <p>等待安装进度...</p>
                    )}
                  </div>
                </div>
              ) : maibotVersionFetchProgress ? (
                <div
                  className={cn(
                    "grid h-full gap-2 border px-3 py-2 text-xs",
                    useRetroStyle ? "retro-control rounded-sm" : "rounded-lg",
                    maibotVersionFetchProgress.tone === "error"
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : maibotVersionFetchProgress.tone === "success"
                        ? "border-success/30 bg-success/10 text-success-foreground"
                        : "border-border bg-muted/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{maibotVersionFetchProgress.label}</span>
                    <span className="font-mono tabular-nums">{Math.round(maibotVersionFetchProgress.value)}%</span>
                  </div>
                  <Progress
                    className={cn(
                      "h-1.5",
                      maibotVersionFetchProgress.tone === "error" && "[&_[data-slot=progress-indicator]]:bg-destructive",
                    )}
                    value={maibotVersionFetchProgress.value}
                  />
                  {maibotVersionFetchProgress.detail ? (
                    <p className="min-h-0 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
                      {maibotVersionFetchProgress.detail}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div> : null}
              {maibotUpdateNotesPanel}
            </DialogBody>
            <DialogFooter className="flex-wrap sm:justify-between">
            <div className="flex flex-wrap justify-start gap-2">
              <Button
                disabled={
                  busy !== null ||
                  maibotUpdateBlocked ||
                  snapshot.paths.maibotDevMode === "source" ||
                  !selectedMaiBotTarget ||
                  (maibotChannel === "other" && maibotRefsLoading)
                }
                onClick={() => void updateMaiBot()}
                size="sm"
              >
                {busy === "maibot:update" ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                {snapshot.paths.maibotDevMode === "source" ? "源码调试模式" : busy === "maibot:update"
                  ? "更新中"
                  : maibotTargetIsCurrent
                    ? "重新安装当前版本"
                    : selectedMaiBotTarget?.type === "package" && snapshot.moduleVersions.maibotDeploymentMode === "source" ? "迁移到 PyPI" : "安装 / 修复"}
              </Button>
              {snapshot.moduleVersions.maibotCanRollback ? <Button
                disabled={busy !== null || maibotUpdateBlocked}
                size="sm" variant="secondary"
                onClick={() => {
                  if (!window.confirm("恢复上一运行环境，并用更新前快照替换当前配置、数据和插件？更新后的这些数据将被替换。")) return;
                  setBusy("maibot:update");
                  void window.maibotDesktop?.modules.rollbackMaiBot()
                    .then(() => refreshSnapshot()).then(() => toast.success("已恢复上一环境及实例数据"))
                    .catch((nextError: unknown) => setError(messageFromError(nextError)))
                    .finally(() => setBusy(null));
                }}>恢复上一环境</Button> : null}
            </div>
                <Button disabled={busy !== null || !selectedMaiBotTarget} onClick={openMaiBotRelease} size="sm" variant="secondary">
                  <ExternalLink />
                  查看更新
                </Button>
            </DialogFooter>
          </>
          )}
        </DialogContent>
      </Dialog>

      <QqWebuiDialog
        open={napcatWebuiOpen}
        onOpenChange={setNapcatWebuiOpen}
        backend={qqBackend}
        url={currentQqWebuiUrl}
      />
    </>
  );
}
