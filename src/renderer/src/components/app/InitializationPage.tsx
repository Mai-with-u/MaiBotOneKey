import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { LogPanel } from "@/components/ui/log-panel";
import { Progress } from "@/components/ui/progress";
import { StatusLight } from "@/components/ui/status-light";
import { MillenniumComputer } from "./MillenniumStatusPanel";
import "@/styles/initialization-page.css";
import "@/styles/startup-transition.css";

export interface InitializationPageProps {
  status: string;
  progress: number;
  active: boolean;
  error?: string | null;
  sourceSelector: ReactNode;
  logs: readonly { id: string; message: string }[];
  actions?: ReactNode;
}

/** A full startup page: the shell owns its titlebar; this owns preparation only. */
export function InitializationPage({ status, progress, active, error, sourceSelector, logs, actions }: InitializationPageProps): React.JSX.Element {
  return (
    <main className="initialization-page flex min-h-0 flex-1 overflow-y-auto p-5" aria-labelledby="initialization-title">
      <div className="m-auto grid w-full max-w-xl gap-5 py-5">
        <div className="initialization-computer mil-launch mx-auto w-full">
          <MillenniumComputer phase={error ? "error" : progress >= 90 ? "linking" : "booting"} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <h1 id="initialization-title" className="text-xl font-semibold">准备麦麦运行环境</h1>
          {sourceSelector ? <div className="startup-source shrink-0">{sourceSelector}</div> : null}
        </div>
        <section aria-label="运行环境准备进度" className="grid gap-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2" role="status" aria-live="polite">
              <StatusLight decorative status={error ? "error" : active ? "mixed" : "off"} />
              <span className="truncate" title={status}>{error ? "准备失败" : status}</span>
            </div>
            <span className="shrink-0 font-mono tabular-nums">{Math.round(progress)}%</span>
          </div>
          <Progress aria-label="运行环境准备进度" variant="framed" value={progress} />
        </section>
        <LogPanel aria-label="安装日志" entries={logs} />
        {error ? <div role="alert" className="flex items-start gap-2 text-xs leading-relaxed text-destructive"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" /><span className="break-words">{error}</span></div> : null}
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </main>
  );
}
