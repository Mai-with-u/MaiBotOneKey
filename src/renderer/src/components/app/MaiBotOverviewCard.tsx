import { cn } from "@/lib/utils";

export function MaiBotOverviewCard({
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
        <span className="text-xs font-semibold leading-none" title="MaiBot 版本">{localVersion || "—"}</span>
        <span className="text-[9px] leading-none" title="一键包版本">v{launcherVersion}</span>
      </div>
    </div>
  );
}
