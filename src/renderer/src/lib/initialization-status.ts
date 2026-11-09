import type { LogEntry, MaiBotModuleUpdateProgress, ServiceDescriptor } from "@shared/contracts";

export interface StartupDownloadProgress {
  percent: number | null;
  label: string;
}

export function startupDownloadProgress(logs: readonly LogEntry[], startedAt: number): StartupDownloadProgress | undefined {
  for (let index = logs.length - 1; index >= 0; index--) {
    const { message, timestamp } = logs[index];
    if (timestamp < startedAt) break;
    if (/^(?:start failed:|startup dependency upgrade completed:)/u.test(message)) return;

    const pip = /^(?:startup dependency upgrade|MaiBot preparation):\s*(.*)$/u.exec(message)?.[1];
    if (!pip) continue;
    const progress = /^下载进度 (.+)（(\d+)%）$/u.exec(pip);
    if (progress) return { percent: Number(progress[2]), label: progress[1] };
    if (pip.startsWith("已下载 ")) return { percent: null, label: pip.slice("已下载 ".length) };
    if (pip.startsWith("Downloading ")) return { percent: null, label: "下载中" };
    if (/^(?:Collecting |Using cached |Installing |Successfully installed|WARNING: Retrying|ERROR:|失败原因：|pip install |checking MaiBot dependencies|验证包与 Python 环境)/u.test(pip)) return;
  }
}

export function canRestartDependencyDownload(
  service: ServiceDescriptor | undefined,
  preparation: MaiBotModuleUpdateProgress | null,
): boolean {
  return service?.status === "starting"
    && (preparation?.phase === "installing" || preparation?.phase === "installing-dependencies");
}

export function initializationStatus(
  service: ServiceDescriptor | undefined,
  busy: boolean,
  preparation?: MaiBotModuleUpdateProgress | null,
): { progress: number; detail: string } {
  if (service?.status === "running") {
    return service.health === "ready"
      ? { progress: 100, detail: "MaiCore 已启动，正在进入首次配置" }
      : { progress: 90, detail: "正在等待 MaiBot WebUI 就绪" };
  }
  if (service?.status === "error") return { progress: 0, detail: service.error ?? service.detail ?? "MaiBot 启动失败" };
  if (preparation && (busy || service?.status === "starting")) {
    return {
      // Installation is only part of startup; reaching WebUI readiness owns 100%.
      progress: 18 + Math.max(0, Math.min(100, preparation.percent)) * 0.6,
      detail: preparation.phase === "completed"
        ? (service?.status === "starting" ? service.detail : undefined) ?? "正在准备启动 MaiBot Core"
        : preparation.label,
    };
  }
  if (service?.status === "starting") return { progress: 42, detail: service.detail ?? "正在启动 MaiBot Core" };
  return { progress: busy ? 18 : 0, detail: busy ? "正在准备运行环境" : "正在读取依赖源并准备自动初始化" };
}
