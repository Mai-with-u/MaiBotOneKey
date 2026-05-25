import type * as React from "react";
import { cn } from "@/lib/utils";
import { formatShortcut, usePlatform } from "@/lib/platform";

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Shortcut spec using "Mod" for ⌘/Ctrl, e.g. "Mod+Shift+S". */
  keys: string;
  compact?: boolean;
  size?: "xs" | "sm";
  tone?: "default" | "muted" | "inverse";
}

const toneStyles: Record<NonNullable<KbdProps["tone"]>, string> = {
  default:
    "border-border bg-card text-foreground/80 shadow-[0_1px_0_0_oklch(0_0_0_/_0.04)]",
  muted: "border-border bg-muted text-muted-foreground",
  inverse: "border-white/10 bg-white/5 text-white/85",
};

const sizeStyles: Record<NonNullable<KbdProps["size"]>, string> = {
  xs: "h-4 min-w-[16px] px-1 text-[10px]",
  sm: "h-5 min-w-[20px] px-1.5 text-[10.5px]",
};

export function Kbd({
  keys,
  compact = false,
  size = "sm",
  tone = "default",
  className,
  ...props
}: KbdProps): React.JSX.Element {
  const platform = usePlatform();
  const tokens = formatShortcut(keys, platform);

  return (
    <kbd
      aria-label={tokens.join(" + ")}
      className={cn("inline-flex items-center gap-0.5 align-middle font-mono", className)}
      {...props}
    >
      {(compact ? [tokens.join("+")] : tokens).map((token, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
          key={`${token}-${index}`}
          className={cn(
            "inline-flex items-center justify-center rounded border font-medium leading-none tabular-nums",
            sizeStyles[size],
            toneStyles[tone],
          )}
        >
          {token}
        </span>
      ))}
    </kbd>
  );
}
