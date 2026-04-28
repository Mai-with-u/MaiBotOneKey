import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none tracking-wide whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-border bg-muted text-foreground/80",
        outline: "border-border bg-transparent text-muted-foreground",
        success: "border-emerald-200/70 bg-emerald-50 text-emerald-700",
        warning: "border-amber-200/70 bg-amber-50 text-amber-700",
        danger: "border-red-200/70 bg-red-50 text-red-700",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

const dotColor: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "bg-primary",
  secondary: "bg-muted-foreground/60",
  outline: "bg-muted-foreground/60",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

export function Badge({
  className,
  variant,
  dot = false,
  children,
  ...props
}: BadgeProps): React.JSX.Element {
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props}>
      {dot ? (
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", dotColor[variant ?? "default"])}
        />
      ) : null}
      {children}
    </span>
  );
}
