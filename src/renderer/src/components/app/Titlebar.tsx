import {
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  Minus,
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
  /** Width of the embedded WebUI sidebar, so the brand column lines up with it. */
  brandColumnWidth?: number;
  /** Shows the three-light mark and the nameplate as one home button. */
  brandHome?: boolean;
  /** Returns to the MaiBot home page; omitted while a tutorial locks navigation. */
  onBrandClick?: () => void;
  /** The embedded WebUI sidebar collapse key, moved up from the sidebar. */
  sidebarToggle?: { collapsed: boolean; onToggle: () => void };
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

/** Window key glyphs share one 24-unit grid so every theme can set one stroke width for all three. */
function WindowIcon({ path }: { path: string }): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d={path} />
    </svg>
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
        <WindowIcon path="M5 12h14" />
      </button>
      <button
        aria-label={miniMode ? "退出迷你模式" : isMaximized ? "还原" : "最大化"}
        className={baseBtn}
        onClick={() => bridge?.toggleMaximize()}
        type="button"
      >
        <WindowIcon path={isMaximized ? "M8 9h10v10H8zM6 15V5h10" : "M5 5h14v14H5z"} />
      </button>
      <button
        aria-label="关闭"
        className="grid h-7 w-8 place-items-center text-primary transition-colors hover:bg-primary hover:text-primary-foreground focus:outline-none"
        onClick={() => bridge?.close()}
        type="button"
      >
        <WindowIcon path="M6 6l12 12M18 6L6 18" />
      </button>
    </div>
  );
}

function SidebarToggleKey({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }): React.JSX.Element {
  const label = collapsed ? "展开侧栏" : "收起侧栏";
  return (
    <button
      aria-expanded={!collapsed}
      aria-label={label}
      className="app-titlebar-sidebar-key"
      data-app-region="no-drag"
      onClick={onToggle}
      title={label}
      type="button"
    >
      {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
    </button>
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
  brandColumnWidth,
  brandHome = false,
  onBrandClick,
  sidebarToggle,
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
      <div
        className={cn("app-titlebar-brand-column flex min-w-0 shrink-0 items-stretch", brandColumnWidth && "overflow-hidden")}
        data-aligned={brandColumnWidth ? "true" : undefined}
        data-collapsed={sidebarToggle?.collapsed ? "true" : undefined}
        data-has-key={sidebarToggle ? "true" : undefined}
        style={brandColumnWidth ? { width: brandColumnWidth } : undefined}
      >
      {isMac ? <MacTrafficLights /> : null}

      {brandHome ? (
        // The mark and the nameplate are one button: they highlight and click together.
        <button
          aria-disabled={onBrandClick ? undefined : true}
          aria-label={onBrandClick ? `回到 MaiBot 首页 · ${statusLabel}` : `${statusLabel} · 引导进行中，暂时不能回首页`}
          className={cn("app-titlebar-home flex min-w-0 items-center gap-2.5 pl-[18px]", brandColumnWidth ? "flex-1 pr-3" : "pr-5")}
          data-app-region="no-drag"
          onClick={onBrandClick}
          title={onBrandClick ? "回到 MaiBot 首页" : "引导进行中，暂时不能回首页"}
          type="button"
        >
          <span className="app-titlebar-home-face flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="app-titlebar-mark" data-status={serviceStatus ?? "unknown"}>
            <span />
            <span />
            <span />
          </span>
          <span className="app-titlebar-core flex min-w-0 items-center">
            {brand ?? (coreHostRef ? (
              <div data-app-region="no-drag" ref={coreHostRef} />
            ) : (
              <div className="flex flex-col gap-0.5">
                <span className={cn("retro-title truncate leading-none", retro ? "text-lg" : "text-base")}>MaiBot OK</span>
                <span className="retro-value text-[9px] leading-none text-primary" title="一键包版本">v{appVersion}</span>
              </div>
            ))}
          </span>
          </span>
        </button>
      ) : (
        <>
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
          brandColumnWidth ? "flex-1 pr-3" : navigation ? "shrink-0 pr-5" : "flex-1",
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
        </>
      )}
      </div>
      {/* One key that slides between the column's right end and just outside it, so collapsing never remounts it. */}
      {sidebarToggle ? (
        <SidebarToggleKey collapsed={sidebarToggle.collapsed} onToggle={sidebarToggle.onToggle} />
      ) : null}

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
