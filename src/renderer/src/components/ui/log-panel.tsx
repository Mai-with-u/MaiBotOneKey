import { useCallback, useLayoutEffect, useRef } from "react";
import { DataPanel } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

export function LogPanel({ entries, className, "aria-label": label = "日志" }: {
  entries: readonly { id: string; message: string }[];
  className?: string;
  "aria-label"?: string;
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const followLatest = useCallback(() => {
    const element = viewport.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, []);

  useLayoutEffect(followLatest, [entries, followLatest]);
  useLayoutEffect(() => {
    // Reflow and window resizing should keep the last line visible as well.
    const observer = new ResizeObserver(followLatest);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [followLatest]);

  return <DataPanel asChild tone="terminal" className={cn("h-32 overflow-auto overscroll-contain [overflow-anchor:none] focus-visible:outline-2 focus-visible:outline-ring", className)}>
    <div ref={viewport} role="log" aria-label={label} aria-live="off" tabIndex={0} onScroll={(event) => {
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 16;
    }}>
      <div ref={content}>
        {entries.map((entry) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-6" key={entry.id}><span aria-hidden="true">› </span>{entry.message}</p>)}
      </div>
    </div>
  </DataPanel>;
}
