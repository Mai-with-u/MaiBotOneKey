import {
  Bot,
  Maximize2,
  Minus,
  MonitorCog,
  Moon,
  Square,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { WindowState } from "@shared/contracts";
import { cn } from "@/lib/utils";
import { usePlatform } from "@/lib/platform";
import { useShortcut } from "@/lib/use-shortcut";
import type { ThemeApi } from "@/lib/use-theme";

interface TitlebarProps {
  appVersion: string;
  liquidGlass?: boolean;
  theme: ThemeApi;
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
    const off = bridge.onState((next) => setState(next));
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
      className="flex items-center gap-2 px-3"
      data-app-region="no-drag"
      aria-label="窗口控制"
    >
      <button
        aria-label="关闭"
        className="group grid size-3 place-items-center rounded-full bg-[#ff5f57] text-[#4d0000] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.18)] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => bridge?.close()}
        type="button"
      >
        <X className="size-2 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={3} />
      </button>
      <button
        aria-label="最小化"
        className="group grid size-3 place-items-center rounded-full bg-[#febc2e] text-[#5a3a00] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.18)] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => bridge?.minimize()}
        type="button"
      >
        <Minus className="size-2 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={3} />
      </button>
      <button
        aria-label="最大化"
        className="group grid size-3 place-items-center rounded-full bg-[#28c840] text-[#003d00] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.18)] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => bridge?.toggleMaximize()}
        type="button"
      >
        <Maximize2 className="size-1.5 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={3} />
      </button>
    </div>
  );
}

function WinControls({ isMaximized }: { isMaximized: boolean }): React.JSX.Element {
  const bridge = window.maibotDesktop?.window;
  const baseBtn =
    "grid h-full w-12 place-items-center text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus:outline-none";
  return (
    <div className="flex h-full items-stretch" data-app-region="no-drag">
      <button
        aria-label="最小化"
        className={baseBtn}
        onClick={() => bridge?.minimize()}
        type="button"
      >
        <Minus className="size-3.5" strokeWidth={2} />
      </button>
      <button
        aria-label={isMaximized ? "还原" : "最大化"}
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
        className="grid h-full w-12 place-items-center text-foreground/70 transition-colors hover:bg-[#e81123] hover:text-white focus:outline-none"
        onClick={() => bridge?.close()}
        type="button"
      >
        <X className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

const themeLabel = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
} as const;

const titlebarBtn =
  "inline-grid h-7 place-items-center rounded-md px-1.5 text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

export function Titlebar({
  appVersion,
  liquidGlass = false,
  theme,
}: TitlebarProps): React.JSX.Element {
  const platform = usePlatform();
  const state = useWindowState();
  const isMac = platform === "darwin";
  const bridge = window.maibotDesktop?.window;

  useShortcut("Mod+M", () => bridge?.minimize());
  useShortcut("Mod+Shift+M", () => bridge?.toggleMaximize());

  const ThemeIcon =
    theme.preference === "system" ? MonitorCog : theme.resolved === "dark" ? Moon : Sun;
  const themeTitle = `主题: ${themeLabel[theme.preference]} (点击切换)`;

  return (
    <div
      className={cn(
        "relative z-40 flex h-9 shrink-0 items-stretch border-b border-border",
        liquidGlass ? "bg-transparent" : "bg-card",
        !state.isFocused && "opacity-90",
      )}
      data-app-region="drag"
      data-liquid-titlebar={liquidGlass ? "true" : undefined}
    >
      {isMac ? <MacTrafficLights /> : null}

      {/* Brand */}
      <div className="flex items-center gap-2 px-2" data-app-region="no-drag">
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
          <Bot className="size-3" strokeWidth={2} />
        </span>
      </div>

      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          isMac ? "justify-center px-3" : "px-1",
        )}
      >
        <span className="truncate text-[12px] font-semibold tracking-tight">
          MaiBot OneKey
        </span>
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-1 px-1.5" data-app-region="no-drag">
        <span className="hidden font-mono text-[10px] text-muted-foreground md:inline-block">
          v{appVersion}
        </span>
        <button
          aria-label={themeTitle}
          className={titlebarBtn}
          onClick={theme.cycle}
          title={themeTitle}
          type="button"
        >
          <ThemeIcon className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>

      {!isMac ? <WinControls isMaximized={state.isMaximized} /> : null}
    </div>
  );
}
