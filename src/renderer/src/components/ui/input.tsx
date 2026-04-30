import type * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  monospace?: boolean;
}

export function Input({
  className,
  invalid = false,
  monospace = false,
  type = "text",
  ...props
}: InputProps): React.JSX.Element {
  const ariaProps = invalid ? { "aria-invalid": "true" as const } : {};
  return (
    <input
      type={type}
      {...ariaProps}
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm leading-none text-foreground",
        "transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/70",
        "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30",
        monospace && "font-mono tracking-tight",
        className,
      )}
      {...props}
    />
  );
}
