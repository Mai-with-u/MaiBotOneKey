import { ChevronDown, Copy, ExternalLink, Loader2, Play, RotateCw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { toast } from "sonner";
import type { ServiceDescriptor, ServiceId } from "@shared/contracts";
import { cn } from "@/lib/utils";

/** 标题栏中间的服务状态胶囊：取代原来的地址栏和启停大键。 */

type PillTone = "on" | "busy" | "off" | "error";

const menuItemClassName =
  "flex cursor-default select-none items-center gap-2.5 px-3.5 py-2 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
const menuLabelClassName = "px-3.5 pt-2 pb-1 text-[11px] text-muted-foreground";

export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function servicePillState(
  service: ServiceDescriptor | undefined,
  operation: string | undefined,
): { tone: PillTone; label: string } {
  if (operation) return { tone: "busy", label: `正在${operation}` };
  switch (service?.status) {
    case "running":
      return service.health === "ready" ? { tone: "on", label: "运行中" } : { tone: "busy", label: "等待就绪" };
    case "starting":
      return { tone: "busy", label: "启动中" };
    case "stopping":
      return { tone: "busy", label: "停止中" };
    case "error":
      return { tone: "error", label: "已出错" };
    default:
      return { tone: "off", label: "未启动" };
  }
}

function useUptime(startedAt: number | undefined, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  return running && startedAt ? formatUptime(now - startedAt) : "";
}

export function ServiceStatusPill({
  service,
  operation,
  transitioning,
  active,
  primaryLabel,
  onPrimary,
  webuiUrl,
  onReload,
  onOpenExternal,
  onStartAll,
  onStartService,
  onStopAll,
  qqBackendName,
  qqBackendAvailable,
}: {
  service: ServiceDescriptor | undefined;
  operation?: string;
  transitioning: boolean;
  /** 是否有服务进程在跑：决定主键是启动还是停止 */
  active: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  webuiUrl?: string;
  /** 只有 WebUI 页签可见时才提供 */
  onReload?: () => void;
  onOpenExternal?: () => void;
  onStartAll: () => void;
  onStartService: (id: ServiceId) => void;
  onStopAll: () => void;
  qqBackendName: string;
  qqBackendAvailable: boolean;
}): React.JSX.Element {
  const { tone, label } = servicePillState(service, operation);
  const uptime = useUptime(service?.startedAt, service?.status === "running");
  const meta = tone === "error" ? service?.error || service?.detail || "" : tone === "on" ? uptime : "";

  const copyUrl = () => {
    if (!webuiUrl) return;
    void navigator.clipboard.writeText(webuiUrl).then(
      () => toast.success("已复制 WebUI 地址"),
      () => toast.error("复制失败"),
    );
  };

  return (
    <div className="app-service-pill" data-tone={tone} role="group" aria-label={`MaiBot ${label}`}>
      <span className="app-service-pill-led" aria-hidden="true" />
      <span className="app-service-pill-label">{label}</span>
      {meta ? <span className="app-service-pill-meta" title={meta}>{meta}</span> : null}
      <span className="app-service-pill-sep" aria-hidden="true" />
      <button
        aria-label={primaryLabel}
        className="app-service-pill-key"
        data-primary={!active && !transitioning ? "true" : undefined}
        disabled={transitioning}
        onClick={onPrimary}
        title={primaryLabel}
        type="button"
      >
        {transitioning ? <Loader2 className="animate-spin" /> : active ? <Square /> : <Play />}
      </button>
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <button aria-label="更多服务操作" className="app-service-pill-key" type="button">
            <ChevronDown />
          </button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align="end"
            className="app-service-menu z-50 min-w-60 border border-border bg-popover py-1.5 text-popover-foreground shadow-lg shadow-black/15"
            sideOffset={6}
          >
            {webuiUrl ? (
              <DropdownMenuPrimitive.Label className={cn(menuLabelClassName, "font-mono")}>
                {webuiUrl.replace(/^https?:\/\//u, "").replace(/\/$/u, "")}
              </DropdownMenuPrimitive.Label>
            ) : null}
            <DropdownMenuPrimitive.Item className={menuItemClassName} disabled={!onReload} onSelect={onReload}>
              <RotateCw className="size-3.5" />
              <span className="flex-1">重新加载页面</span>
              <span className="font-mono text-[10px] text-muted-foreground">Ctrl R</span>
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item className={menuItemClassName} disabled={!onOpenExternal} onSelect={onOpenExternal}>
              <ExternalLink className="size-3.5" />
              在浏览器中打开
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item className={menuItemClassName} disabled={!webuiUrl} onSelect={copyUrl}>
              <Copy className="size-3.5" />
              复制 WebUI 地址
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Separator className="my-1.5 h-px bg-border" />
            <DropdownMenuPrimitive.Label className={menuLabelClassName}>服务</DropdownMenuPrimitive.Label>
            <DropdownMenuPrimitive.Item className={menuItemClassName} disabled={transitioning} onSelect={onStartAll}>
              <Play className="size-3.5" />
              启动全部服务
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item
              className={menuItemClassName}
              disabled={transitioning || !service || service.status === "running"}
              onSelect={() => onStartService("maibot")}
            >
              <Play className="size-3.5" />
              启动 MaiBot
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item
              className={menuItemClassName}
              disabled={transitioning || !qqBackendAvailable}
              onSelect={() => onStartService("napcat")}
            >
              <Play className="size-3.5" />
              启动 {qqBackendName}
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item
              className={cn(menuItemClassName, "text-destructive focus:text-destructive")}
              disabled={transitioning || !active}
              onSelect={onStopAll}
            >
              <Square className="size-3.5" />
              停止全部服务
            </DropdownMenuPrimitive.Item>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    </div>
  );
}
