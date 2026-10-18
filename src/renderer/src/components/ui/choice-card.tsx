import type * as React from "react";
import { cn } from "@/lib/utils";

export interface ChoiceCardProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  selected: boolean;
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  layout?: "row" | "stack";
}

export function ChoiceCard({ selected, icon, title, description, badge, layout = "row", className, type = "button", ...props }: ChoiceCardProps): React.JSX.Element {
  return (
    <button
      type={type}
      data-slot="choice-card"
      data-layout={layout}
      aria-pressed={selected}
      className={cn("flex min-w-0 items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50", layout === "stack" && "flex-col items-start justify-start", className)}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-3">
        {icon ? <span data-slot="choice-card-icon" className="grid size-8 shrink-0 place-items-center [&_svg]:size-4">{icon}</span> : null}
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          {description ? <span className={cn("mt-0.5 block opacity-70", layout === "row" ? "truncate font-mono text-[10px]" : "text-xs leading-relaxed")}>{description}</span> : null}
        </span>
      </span>
      {badge}
    </button>
  );
}
