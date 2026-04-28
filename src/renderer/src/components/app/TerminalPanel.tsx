import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine, Loader2, RotateCcw, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { PtySessionSnapshot, ServiceDescriptor, ServiceId } from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ptyLogStore } from "@/lib/pty-log-store";
import { useShortcut } from "@/lib/use-shortcut";

const serviceTerminals: Array<{ serviceId: ServiceId; sessionId: string; title: string }> = [
  { serviceId: "maibot", sessionId: "service:maibot", title: "MaiBot Core" },
  { serviceId: "napcat", sessionId: "service:napcat", title: "NapCat" },
];

const statusText: Record<PtySessionSnapshot["status"], string> = {
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  exited: "已退出",
  error: "异常",
};

const ansi16Colors = [
  "#11150f",
  "#e26d5a",
  "#9bd56c",
  "#d5ba65",
  "#7bb5e8",
  "#c98ee8",
  "#70d5c1",
  "#dfe8d1",
  "#596151",
  "#f28c78",
  "#b8ed88",
  "#ecd37d",
  "#9fd1ff",
  "#dfadff",
  "#96ead9",
  "#f2f8e8",
];

interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: CSSProperties["fontWeight"];
  fontStyle?: CSSProperties["fontStyle"];
  textDecoration?: CSSProperties["textDecoration"];
  opacity?: number;
}

interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

function serviceBadgeVariant(service?: ServiceDescriptor): "success" | "warning" | "danger" | "outline" {
  if (!service) {
    return "outline";
  }
  if (service.status === "running") {
    return "success";
  }
  if (service.status === "starting" || service.status === "stopping") {
    return "warning";
  }
  if (service.status === "error") {
    return "danger";
  }
  return "outline";
}

function ansi256ToColor(code: number): string | undefined {
  if (code >= 0 && code <= 15) {
    return ansi16Colors[code];
  }

  if (code >= 16 && code <= 231) {
    const value = code - 16;
    const r = Math.floor(value / 36);
    const g = Math.floor((value % 36) / 6);
    const b = value % 6;
    const toChannel = (item: number): number => (item === 0 ? 0 : 55 + item * 40);
    return `rgb(${toChannel(r)}, ${toChannel(g)}, ${toChannel(b)})`;
  }

  if (code >= 232 && code <= 255) {
    const gray = 8 + (code - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }

  return undefined;
}

function stripNonSgrControls(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b[@-Z\\-_]/gu, "");
}

function cloneStyle(style: AnsiStyle): AnsiStyle {
  return { ...style };
}

function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  const next = cloneStyle(style);
  const values = params.length > 0 ? params : [0];

  for (let index = 0; index < values.length; index += 1) {
    const code = values[index];

    if (code === 0) {
      Object.keys(next).forEach((key) => {
        delete next[key as keyof AnsiStyle];
      });
    } else if (code === 1) {
      next.fontWeight = 700;
    } else if (code === 2) {
      next.opacity = 0.72;
    } else if (code === 3) {
      next.fontStyle = "italic";
    } else if (code === 4) {
      next.textDecoration = "underline";
    } else if (code === 22) {
      delete next.fontWeight;
      delete next.opacity;
    } else if (code === 23) {
      delete next.fontStyle;
    } else if (code === 24) {
      delete next.textDecoration;
    } else if (code === 39) {
      delete next.color;
    } else if (code === 49) {
      delete next.backgroundColor;
    } else if (code >= 30 && code <= 37) {
      next.color = ansi16Colors[code - 30];
    } else if (code >= 90 && code <= 97) {
      next.color = ansi16Colors[8 + code - 90];
    } else if (code >= 40 && code <= 47) {
      next.backgroundColor = ansi16Colors[code - 40];
    } else if (code >= 100 && code <= 107) {
      next.backgroundColor = ansi16Colors[8 + code - 100];
    } else if ((code === 38 || code === 48) && values[index + 1] === 2) {
      const [r, g, b] = [values[index + 2], values[index + 3], values[index + 4]];
      if ([r, g, b].every((value) => Number.isFinite(value))) {
        const color = `rgb(${r}, ${g}, ${b})`;
        if (code === 38) {
          next.color = color;
        } else {
          next.backgroundColor = color;
        }
      }
      index += 4;
    } else if ((code === 38 || code === 48) && values[index + 1] === 5) {
      const color = ansi256ToColor(values[index + 2]);
      if (color) {
        if (code === 38) {
          next.color = color;
        } else {
          next.backgroundColor = color;
        }
      }
      index += 2;
    }
  }

  return next;
}

function parseAnsiLine(raw: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const sgrPattern = /\x1b\[([0-9;]*)m/gu;
  let style: AnsiStyle = {};
  let lastIndex = 0;

  for (const match of raw.matchAll(sgrPattern)) {
    const index = match.index ?? 0;
    const text = stripNonSgrControls(raw.slice(lastIndex, index));
    if (text.length > 0) {
      segments.push({ text, style: cloneStyle(style) });
    }

    const params = match[1]
      .split(";")
      .filter((part) => part.length > 0)
      .map((part) => Number(part));
    style = applySgr(style, params);
    lastIndex = index + match[0].length;
  }

  const tail = stripNonSgrControls(raw.slice(lastIndex));
  if (tail.length > 0 || segments.length === 0) {
    segments.push({ text: tail.length > 0 ? tail : " ", style: cloneStyle(style) });
  }

  return segments;
}

function AnsiLine({ raw }: { raw: string }): React.JSX.Element {
  const segments = useMemo(() => parseAnsiLine(raw), [raw]);
  return (
    <>
      {segments.map((segment, index) => (
        <span key={`${index}-${segment.text.slice(0, 8)}`} style={segment.style}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

export function TerminalPanel({
  active = true,
  services = [],
}: {
  active?: boolean;
  services?: ServiceDescriptor[];
}): React.JSX.Element {
  const [activeServiceId, setActiveServiceId] = useState<ServiceId>("maibot");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const version = useSyncExternalStore(
    (listener) => ptyLogStore.subscribe(listener),
    () => ptyLogStore.getVersion(),
    () => ptyLogStore.getVersion(),
  );

  const servicesById = useMemo(
    () => new Map<ServiceId, ServiceDescriptor>(services.map((service) => [service.id, service])),
    [services],
  );

  const activeTerminal = serviceTerminals.find((terminal) => terminal.serviceId === activeServiceId) ?? serviceTerminals[0];
  const activeSession = ptyLogStore.getSession(activeTerminal.sessionId);
  const activeService = servicesById.get(activeServiceId);
  const lineCount = ptyLogStore.getLineCount(activeTerminal.sessionId);

  const virtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 80,
  });

  const scrollToTail = useCallback(() => {
    if (lineCount > 0) {
      virtualizer.scrollToIndex(lineCount - 1, { align: "end" });
    }
  }, [lineCount, virtualizer]);

  useEffect(() => {
    if (!followRef.current) {
      return;
    }

    requestAnimationFrame(scrollToTail);
  }, [scrollToTail, version, activeServiceId]);

  const refreshSessions = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await ptyLogStore.connect();
      requestAnimationFrame(scrollToTail);
    } finally {
      setIsRefreshing(false);
    }
  }, [scrollToTail]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const nextFollowing = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    followRef.current = nextFollowing;
    setIsFollowing(nextFollowing);
  }, []);

  const selectService = useCallback((serviceId: ServiceId) => {
    followRef.current = true;
    setIsFollowing(true);
    setActiveServiceId(serviceId);
  }, []);

  useShortcut("Mod+Shift+R", refreshSessions, { enabled: active });

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0c100e] text-[#dfe8d1]">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-4 border-b border-[#1f2620] bg-[#101611] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="size-4 shrink-0 text-[#9bd56c]" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight text-[#e9f0db]">
              后台 PTY 终端
            </h2>
            <p className="truncate text-[11px] text-[#8f9a84]">
              全局订阅已开启，当前缓存 {lineCount.toLocaleString("zh-CN")} 行
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isFollowing ? (
            <Button onClick={scrollToTail} size="sm" variant="outline">
              <ArrowDownToLine />
              跟随底部
            </Button>
          ) : null}
          <Button disabled={isRefreshing} onClick={refreshSessions} size="sm" variant="outline">
            {isRefreshing ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            刷新附加
            <Kbd className="ml-1" keys="Mod+Shift+R" size="xs" tone="muted" />
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[#1f2620] bg-[#0f1411] px-3 py-2">
        {serviceTerminals.map((item) => {
          const session = ptyLogStore.getSession(item.sessionId);
          const service = servicesById.get(item.serviceId);
          const selected = activeServiceId === item.serviceId;
          return (
            <button
              className={[
                "flex h-9 min-w-[174px] items-center justify-between gap-3 rounded-md border px-3 text-left transition-colors",
                selected
                  ? "border-[#5c7d45] bg-[#182217] text-[#eff8df]"
                  : "border-[#263027] bg-[#111711] text-[#aebaa6] hover:border-[#3b4939] hover:bg-[#151d15]",
              ].join(" ")}
              key={item.serviceId}
              onClick={() => selectService(item.serviceId)}
              type="button"
            >
              <span className="min-w-0 truncate text-xs font-semibold">{item.title}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Badge className="h-5 border-[#344132] bg-transparent px-1.5 text-[10px]" variant={serviceBadgeVariant(service)}>
                  {service?.status === "running" ? "服务运行" : service?.status === "error" ? "异常" : "未运行"}
                </Badge>
                <Badge className="h-5 border-[#344132] bg-[#121a12] px-1.5 text-[10px] text-[#b8ed88]" variant="outline">
                  {session ? statusText[session.status] : "无 PTY"}
                </Badge>
              </span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <div
          className="size-full overflow-auto rounded-md border border-[#20281f] bg-[#0c100e] shadow-inner"
          onScroll={handleScroll}
          ref={scrollRef}
        >
          <div
            className="relative w-full font-mono text-[12px] leading-[18px] text-[#dfe8d1]"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              fontVariantLigatures: "none",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const line = ptyLogStore.getLine(activeTerminal.sessionId, virtualRow.index);
              return (
                <div
                  className="absolute left-0 top-0 min-h-[18px] w-full whitespace-pre-wrap break-all px-3"
                  data-index={virtualRow.index}
                  key={line?.id === -1 ? `partial-${activeTerminal.sessionId}` : line?.id ?? virtualRow.key}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {line ? <AnsiLine raw={line.raw} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-[#1f2620] bg-[#101611] px-4 font-mono text-[11px] text-[#8f9a84]">
        <span>{activeSession?.pid ? `pid ${activeSession.pid}` : "等待后台服务启动"}</span>
        <span className="min-w-0 truncate pl-4 text-right">{activeService?.command?.[0] ?? "启动命令会在服务启动后显示"}</span>
      </div>
    </section>
  );
}
