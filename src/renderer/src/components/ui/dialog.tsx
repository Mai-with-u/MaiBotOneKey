import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const sizeStyles = {
  sm: "max-w-[420px]",
  md: "max-w-[520px]",
  lg: "max-w-[720px]",
  xl: "max-w-[960px]",
} as const;

export type DialogSize = keyof typeof sizeStyles;

interface DialogProps {
  open: boolean;
  onClose?: () => void;
  size?: DialogSize;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  closeOnBackdrop?: boolean;
  showCloseButton?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Lightweight modal scaffold: backdrop + centered card.
 * Renders inline (no portal) so it relies on z-index stacking.
 */
export function Dialog({
  open,
  onClose,
  size = "md",
  ariaLabel,
  ariaLabelledBy,
  closeOnBackdrop = true,
  showCloseButton = false,
  className,
  children,
}: DialogProps): React.JSX.Element | null {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    cardRef.current?.focus();
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) {
          onClose?.();
        }
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        className={cn(
          "relative w-full rounded-2xl border border-border/80 bg-elevated shadow-2xl outline-none",
          sizeStyles[size],
          className,
        )}
      >
        {showCloseButton && onClose ? (
          <Button
            aria-label="关闭"
            className="absolute right-3 top-3 z-10"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X />
          </Button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({
  icon,
  tone = "default",
  title,
  description,
  titleId,
  align = "start",
}: {
  icon?: ReactNode;
  tone?: "default" | "warning" | "danger" | "primary";
  title: ReactNode;
  description?: ReactNode;
  titleId?: string;
  align?: "start" | "center";
}): React.JSX.Element {
  const iconTone = {
    default: "bg-muted text-foreground/70",
    primary: "bg-primary/12 text-primary",
    warning: "bg-amber-500/15 text-amber-700",
    danger: "bg-destructive/12 text-destructive",
  }[tone];

  return (
    <div
      className={cn(
        "flex gap-3 border-b border-border px-5 py-4",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      {icon ? (
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", iconTone)}>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-base font-semibold leading-tight tracking-tight">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

export function DialogBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return <div className={cn("px-5 py-5", className)}>{children}</div>;
}

export function DialogFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/35 px-5 py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
