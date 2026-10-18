import {
  Maximize2,
  Minus,
  Square,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ServiceStatus, WindowState } from "@shared/contracts";
import { cn } from "@/lib/utils";
import { usePlatform } from "@/lib/platform";
import { useShortcut } from "@/lib/use-shortcut";

interface TitlebarProps {
  appVersion: string;
  serviceStatus?: ServiceStatus;
  retro?: boolean;
  navigation?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  coreHostRef?: (element: HTMLDivElement | null) => void;
  brand?: ReactNode;
}

function useWindowState(): WindowState {
  const [state, setState] = useState<WindowState>({
    isMaximized: false,
    isFullScreen: false,
    isFocused: true,
  });

  useEffect(() => {
    const bridge = window.maibotDesktop?.window;
    if (!bridge) return;
    let mounted = true;
    bridge.getState().then((next) => {
      if (mounted) setState(next);
    });
    const off = bridge.onState((next) => setState((current) => ({ ...current, ...next })));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return state;
}

function MacTrafficLights(): React.JSX.Element {
  const bridge = window.maibotDesktop?.window;
  return (
    <div
      className="app-window-controls flex items-center gap-1.5 px-2.5"
      data-app-region="no-drag"
      aria-label="窗口控制"
    >
      <button
        aria-label="关闭"
        className="group grid size-3 place-items-center rounded-full bg-[#ff5f57] text-[#4d0000] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => bridge?.close()}
        type="button"
      >
        <X className="size-2 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={3} />
      </button>
      <button
        aria-label="最小化"
        className="group grid size-3 place-items-center rounded-full bg-[#febc2e] text-[#5a3a00] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => bridge?.minimize()}
        type="button"
      >
        <Minus className="size-2 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={3} />
      </button>
      <button
        aria-label="最大化"
        className="group grid size-3 place-items-center rounded-full bg-[#28c840] text-[#003d00] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => bridge?.toggleMaximize()}
        type="button"
      >
        <Maximize2 className="size-1.5 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={3} />
      </button>
    </div>
  );
}

function WinControls({ isMaximized, miniMode = false, retro = false }: { isMaximized: boolean; miniMode?: boolean; retro?: boolean }): React.JSX.Element {
  const bridge = window.maibotDesktop?.window;
  const baseBtn =
    "grid h-7 w-8 place-items-center text-foreground/75 transition-colors hover:bg-accent hover:text-foreground focus:outline-none";
  return (
    <div
      className="app-window-controls flex h-full items-center gap-1 pl-1 pr-1"
      data-app-region="no-drag"
      style={{
        paddingRight: retro
          ? "clamp(12px, calc(var(--app-window-radius, 16px) * 0.8 + 2px), 32px)"
          : undefined,
      }}
    >
      <button
        aria-label="最小化"
        className={baseBtn}
        onClick={() => bridge?.minimize()}
        type="button"
      >
        <Minus className="size-3.5" strokeWidth={2} />
      </button>
      <button
        aria-label={miniMode ? "退出迷你模式" : isMaximized ? "还原" : "最大化"}
        className={baseBtn}
        onClick={() => bridge?.toggleMaximize()}
        type="button"
      >
        {isMaximized ? (
          <svg
            aria-hidden
            fill="none"
            height="11"
            stroke="currentColor"
            strokeWidth="1.4"
            viewBox="0 0 12 12"
            width="11"
          >
            <rect height="7" width="7" x="2.5" y="3.5" />
            <path d="M4.5 3V2h6v6H9.5" />
          </svg>
        ) : (
          <Square className="size-3" strokeWidth={1.6} />
        )}
      </button>
      <button
        aria-label="关闭"
        className="grid h-7 w-8 place-items-center text-primary transition-colors hover:bg-primary hover:text-primary-foreground focus:outline-none"
        onClick={() => bridge?.close()}
        type="button"
      >
        <X className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

const serviceStatusLabels: Record<ServiceStatus, string> = {
  stopped: "已停止",
  starting: "正在启动",
  running: "运行中",
  stopping: "正在停止",
  error: "启动或运行出错",
};

export function Titlebar({
  appVersion,
  serviceStatus,
  retro = false,
  navigation,
  actions,
  toolbar,
  coreHostRef,
  brand,
}: TitlebarProps): React.JSX.Element {
  const platform = usePlatform();
  const state = useWindowState();
  const isMac = platform === "darwin";
  const bridge = window.maibotDesktop?.window;
  const statusLabel = `MaiBot 状态：${serviceStatus ? serviceStatusLabels[serviceStatus] : "未就绪"}`;

  useShortcut("Mod+M", () => bridge?.minimize());
  useShortcut("Mod+Shift+M", () => bridge?.toggleMaximize());

  return (
    <div
      className={cn(
        "app-titlebar relative z-40 flex h-9 shrink-0 items-stretch border-b-2",
        retro ? "border-[var(--retro-titlebar-line)]" : "border-border",
        "bg-card",
        !state.isFocused && "opacity-90",
      )}
      data-app-region="drag"
    >
      {isMac ? <MacTrafficLights /> : null}

      {/* Brand */}
      <div className="app-titlebar-brand flex items-center gap-2.5 pl-4 pr-1.5" data-app-region="no-drag">
        <span
          aria-label={statusLabel}
          className="app-titlebar-status relative block size-[18px] shrink-0 overflow-hidden rounded-full bg-primary"
          data-status={serviceStatus ?? "unknown"}
          role="img"
          title={statusLabel}
          style={{ backgroundColor: serviceStatus === "running" ? undefined
            : serviceStatus === "starting" || serviceStatus === "stopping" ? "var(--warning)"
              : serviceStatus === "error" ? "var(--destructive)" : "var(--muted-foreground)" }}
        />
      </div>

      <div
        className={cn(
          "app-titlebar-core flex min-w-0 items-center gap-1.5",
          navigation ? "shrink-0 pr-5" : "flex-1",
          isMac ? "justify-center px-3" : "px-1",
        )}
      >
        {brand ?? (coreHostRef ? (
          <div data-app-region="no-drag" ref={coreHostRef} />
        ) : (
          <div className="flex flex-col gap-0.5">
            <span className={cn("retro-title truncate leading-none", retro ? "text-lg" : "text-base")}>MaiBot OK</span>
            <span className="retro-value text-[9px] leading-none text-primary" title="一键包版本">v{appVersion}</span>
          </div>
        ))}
      </div>

      {navigation ? (
        <div className="app-titlebar-navigation ml-2 flex min-w-0 self-end pt-1" data-app-region="no-drag">
          {navigation}
        </div>
      ) : null}
      <div className="app-titlebar-toolbar flex min-w-0 flex-1">{toolbar ?? (navigation ? <div className="min-w-4 flex-1" /> : null)}</div>

      {/* Right cluster */}
      {actions ? (
        <div className="retro-titlebar-actions flex shrink-0 items-center px-2" data-app-region="no-drag">
          {actions}
        </div>
      ) : null}

      {!isMac ? <WinControls isMaximized={state.isMaximized} miniMode={state.isMiniMode} retro={retro} /> : null}
    </div>
  );
}
