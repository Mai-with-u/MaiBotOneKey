import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-[90] bg-foreground/35 backdrop-blur-[3px]",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

const sizeStyles = {
  sm: "sm:max-w-[420px]",
  md: "sm:max-w-[520px]",
  lg: "sm:max-w-[720px]",
  xl: "sm:max-w-[960px]",
} as const;

export type DialogSize = keyof typeof sizeStyles;

export interface DialogContentProps
  extends React.ComponentProps<typeof DialogPrimitive.Content> {
  size?: DialogSize;
  showCloseButton?: boolean;
}

export function DialogContent({
  className,
  children,
  size = "md",
  showCloseButton = true,
  ...props
}: DialogContentProps): React.JSX.Element {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "!fixed top-1/2 left-1/2 z-[100] grid w-[calc(100%-2rem)] max-h-[calc(100vh-3rem)]",
          "-translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)_auto]",
          "retro-panel retro-panel-bare overflow-hidden text-card-foreground outline-none",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          sizeStyles[size],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute right-3 top-3 grid size-7 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <XIcon className="size-4" />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

interface DialogHeaderProps {
  icon?: React.ReactNode;
  tone?: "default" | "primary" | "warning" | "danger";
  title: React.ReactNode;
  description?: React.ReactNode;
  /** @deprecated Radix 现在自管理 id，传值会被忽略。 */
  titleId?: string;
  className?: string;
}

const headerTone = {
  default: "bg-muted text-foreground/70",
  primary: "bg-primary/15 text-primary",
  warning: "bg-warning/20 text-warning-foreground",
  danger: "bg-destructive/12 text-destructive",
} as const;

export function DialogHeader({
  icon,
  tone = "default",
  title,
  description,
  titleId: _titleId,
  className,
}: DialogHeaderProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-border px-5 py-4",
        className,
      )}
    >
      {icon ? (
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-sm border border-current/20",
            headerTone[tone],
          )}
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 pr-8">
        <DialogPrimitive.Title className="text-base font-semibold leading-tight">
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
    </div>
  );
}

export function DialogBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("min-h-0 overflow-y-auto px-5 py-5", className)}>
      {children}
    </div>
  );
}

export function DialogFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/40 px-5 py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

// Re-export Title/Description for advanced usage
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
