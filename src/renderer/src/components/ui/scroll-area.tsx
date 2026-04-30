import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "min-h-0 overflow-y-auto overscroll-contain [scrollbar-color:theme(colors.border)_transparent] [scrollbar-width:thin]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
