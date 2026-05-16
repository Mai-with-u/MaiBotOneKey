import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ScrollArea(
  { className, children, ...props },
  ref,
): React.JSX.Element {
  return (
    <div
      className={cn(
        "min-h-0 overflow-y-auto overscroll-contain [scrollbar-color:theme(colors.border)_transparent] [scrollbar-width:thin]",
        className,
      )}
      ref={ref}
      {...props}
    >
      {children}
    </div>
  );
});
