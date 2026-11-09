import type { ReactNode } from "react";
import { Copy, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { LogPanel } from "@/components/ui/log-panel";
import { Progress } from "@/components/ui/progress";
import { StatusLight } from "@/components/ui/status-light";
import type { StartupDownloadProgress } from "@/lib/initialization-status";
import { MillenniumComputer } from "./MillenniumStatusPanel";
import "@/styles/initialization-page.css";
import "@/styles/startup-transition.css";

export interface InitializationPageProps {
  status: string;
  progress: number;
  download?: StartupDownloadProgress;
  active: boolean;
  error?: string | null;
  sourceSelector: ReactNode;
  logs: readonly { id: string; message: string }[];
  actions?: ReactNode;
}

/** A full startup page: the shell owns its titlebar; this owns preparation only. */
export function InitializationPage({ status, progress, download, active, error, sourceSelector, logs, actions }: InitializationPageProps): React.JSX.Element {
  const barValue = download ? download.percent : Math.round(progress);
  const progressLabel = download ? "当前文件下载进度" : "运行环境准备进度";
  return (
    <main className="initialization-page flex min-h-0 min-w-0 flex-1 overflow-y-auto p-5" aria-labelledby="initialization-title" data-preparation-failed={Boolean(error)}>
      <div className="m-auto grid w-full min-w-0 max-w-xl grid-cols-1 gap-5 py-5">
        <div className="initialization-computer mil-launch mx-auto w-full">
          <MillenniumComputer phase={error ? "error" : progress >= 90 ? "linking" : "booting"} />
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <h1 id="initialization-title" className="shrink-0 text-lg font-semibold">准备麦麦运行环境</h1>
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs" role="status" aria-live="polite">
            <StatusLight decorative status={error ? "error" : active ? "mixed" : "off"} />
            <span className="truncate" title={status}>{error ? "准备失败" : status}</span>
          </div>
          {sourceSelector ? <div className="startup-source shrink-0">{sourceSelector}</div> : null}
        </div>
        <div className="flex items-center gap-3">
          <Progress aria-label={progressLabel} variant="framed" value={barValue} />
          <span className="shrink-0 font-mono text-sm tabular-nums" title={download?.label}>
            {barValue === null ? download?.label : `${download ? "文件 " : ""}${barValue}%`}
          </span>
        </div>
        <LogPanel aria-label="安装日志" className="h-40 [@media(max-height:650px)]:h-36" entries={logs} />
        {error ? (
          <section aria-labelledby="initialization-error-title" className="min-w-0 border border-destructive/30 bg-destructive/5 text-destructive">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-destructive/30 px-3 py-2">
              <h2 id="initialization-error-title" role="alert" className="flex items-center gap-2 text-sm font-semibold">
                <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
                错误详情
              </h2>
              <Button type="button" variant="outline" size="sm" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(error);
                  toast.success("已复制错误详情");
                } catch {
                  toast.error("复制失败，可选中错误详情手动复制");
                }
              }}>
                <Copy />复制错误
              </Button>
            </div>
            <pre tabIndex={0} aria-label="完整错误信息" className="max-h-[min(8rem,20vh)] overflow-auto overscroll-contain whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
              {error}
            </pre>
          </section>
        ) : null}
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </main>
  );
}
