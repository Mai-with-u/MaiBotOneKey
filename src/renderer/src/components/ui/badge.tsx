import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border border-transparent px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary",
        secondary: "bg-muted/70 text-foreground/75",
        outline: "border-border bg-background/45 text-muted-foreground",
        success: "border-primary/25 bg-primary/10 text-primary",
        warning: "border-warning/35 bg-warning/15 text-warning-foreground",
        danger: "border-destructive/30 bg-destructive/10 text-destructive",
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
  success: "bg-primary",
  warning: "bg-warning",
  danger: "bg-destructive",
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
