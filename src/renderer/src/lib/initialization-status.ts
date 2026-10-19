import type { MaiBotModuleUpdateProgress, ServiceDescriptor } from "@shared/contracts";

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
