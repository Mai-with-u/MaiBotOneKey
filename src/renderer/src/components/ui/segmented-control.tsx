import { RadioGroup } from "radix-ui";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: React.ReactNode; disabled?: boolean }[];
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  "aria-label": string;
}

/** Single-choice settings share Radix keyboard navigation and theme materials. */
export function SegmentedControl<T extends string>({ value, onValueChange, options, disabled, size = "sm", className, "aria-label": label }: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <RadioGroup.Root
      data-slot="segmented-control"
      className={cn("flex min-w-0 flex-wrap gap-1", className)}
      value={value}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next);
        if (option && !disabled && !option.disabled) onValueChange(option.value);
      }}
      disabled={disabled}
      orientation="horizontal"
      aria-label={label}
    >
      {options.map((option) => (
        <RadioGroup.Item key={option.value} asChild value={option.value} disabled={disabled || option.disabled}>
          <Button type="button" variant="outline" size={size} aria-pressed={value === option.value} className="min-w-0 flex-1">
            {option.label}
          </Button>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
