import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>): React.JSX.Element {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex h-9 items-stretch gap-0 bg-transparent p-0 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "relative inline-flex h-full flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-none border-0 px-3 text-sm font-semibold leading-none transition-colors",
        "after:absolute after:bottom-3 after:right-0 after:top-3 after:w-px after:bg-border/70 last:after:hidden",
        "text-muted-foreground hover:text-foreground/90",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground",
        "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-current",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>): React.JSX.Element {
  return (
    <TabsPrimitive.Content
      className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}
      {...props}
    />
  );
}
