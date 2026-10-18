import { Slot } from "@radix-ui/react-slot";
import type * as React from "react";
import { cn } from "@/lib/utils";

type SurfaceProps = React.HTMLAttributes<HTMLDivElement> & { asChild?: boolean };

/** Theme-owned settings surface; layout stays with the caller. */
export function SettingsSection({ asChild = false, className, ...props }: SurfaceProps): React.JSX.Element {
  const Comp = asChild ? Slot : "div";
  return <Comp data-slot="settings-section" className={cn("settings-section min-w-0 p-3", className)} {...props} />;
}

/** Inset data area, shared by version details, diagnostics and logs. */
export function DataPanel({ asChild = false, className, padding = "default", tone = "default", ...props }: SurfaceProps & {
  padding?: "default" | "none";
  tone?: "default" | "terminal";
}): React.JSX.Element {
  const Comp = asChild ? Slot : "div";
  return <Comp data-slot="data-panel" data-padding={padding} data-tone={tone} className={cn("min-w-0", className)} {...props} />;
}
