import type { LogEntry, ServiceDescriptor } from "@shared/contracts";
import { Card } from "@/components/ui/card";
import { LogPanel } from "@/components/ui/log-panel";
import { Progress } from "@/components/ui/progress";
import { StatusLight } from "@/components/ui/status-light";

function dependencyPreparationProgress(
  service: ServiceDescriptor | undefined,
  logs: LogEntry[],
): number {
  if (service?.status === "error") {
    return 100;
  }
  if (service?.status === "running" && service.health === "ready") {
    return 100;
  }
  if (service?.status === "running") {
    return 92;
  }

  const messages = logs.map((entry) => entry.message).join("\n");
  if (/dependency upgrade completed|依赖检查完成/iu.test(messages) || service?.detail?.includes("依赖检查完成")) {
    return 86;
  }
  if (/Installing collected packages|pip is writing|pip install using/iu.test(messages)) {
    return 68;
  }
  if (/dependency needs install|checking MaiBot dependencies|检查 MaiBot/iu.test(messages)) {
    return 46;
  }
  if (/copying bundled Python|portable Python ready|python-env/iu.test(messages)) {
    return 28;
  }
  return service?.status === "starting" ? 18 : 0;
}

function dependencyPreparationTitle(service: ServiceDescriptor | undefined): string {
  if (service?.status === "error") {
    return "MaiBot 依赖准备失败";
  }
  if (service?.status === "running") {
    return "MaiBot 依赖准备完成";
  }
  return "正在准备 MaiBot 启动环境";
}

export function DependencyPreparationNotice({ logs, service }: {
  logs: LogEntry[];
  service: ServiceDescriptor | undefined;
}): React.JSX.Element | null {
  const runStartedAt = service?.startedAt ?? (service?.status === "starting" ? Date.now() - 5 * 60 * 1000 : undefined);
  const scopedLogs = runStartedAt === undefined ? logs : logs.filter((entry) => entry.timestamp >= runStartedAt - 1000);
  const visible = service?.status === "starting" && (service.detail?.includes("依赖") || scopedLogs.length > 0);
  const failed = service?.status === "error" && (service.error?.includes("依赖") || service.detail?.includes("依赖") || scopedLogs.length > 0);
  if (!visible && !failed) return null;
  const progress = dependencyPreparationProgress(service, scopedLogs);
  return <Card variant="flat" className="fixed bottom-5 right-5 z-40 grid w-[min(420px,calc(100vw-2.5rem))] gap-3 p-4" aria-label="MaiBot 启动进度">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold" role="status">
        <StatusLight status={failed ? "error" : "mixed"} decorative />
        <span className="truncate">{dependencyPreparationTitle(service)}</span>
      </h2>
      <span className="shrink-0 font-mono text-xs tabular-nums">{Math.round(progress)}%</span>
    </div>
    <Progress aria-label="MaiBot 启动进度" variant="framed" value={progress} />
    <LogPanel aria-label="启动准备日志" className="h-28 overflow-x-hidden" entries={scopedLogs.slice(-200)} />
  </Card>;
}
