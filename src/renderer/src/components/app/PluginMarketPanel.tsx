import { Store } from "lucide-react";

export function PluginMarketPanel(): React.JSX.Element {
  return (
    <div className="grid h-full place-items-center bg-background px-6 py-10">
      <div className="flex max-w-md flex-col items-center text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-primary/12 text-primary">
          <Store className="size-7" />
        </span>
        <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
          插件市场
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          敬请期待。
        </p>
      </div>
    </div>
  );
}
