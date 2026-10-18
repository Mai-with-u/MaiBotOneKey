import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  max = 100,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { variant?: "default" | "framed" }) {
  const limit = Number.isFinite(max) && max > 0 ? max : 100
  const progress = typeof value === "number" && Number.isFinite(value)
    ? Math.min(limit, Math.max(0, value)) : null
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-progress-variant={variant}
      value={progress}
      max={limit}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-primary transition-all"
        style={progress === null ? undefined : { transform: `translateX(-${100 - progress / limit * 100}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
