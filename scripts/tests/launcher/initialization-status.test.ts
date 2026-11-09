import { expect, test } from "bun:test";
import { canRestartDependencyDownload, initializationStatus, startupDownloadProgress } from "../../../src/renderer/src/lib/initialization-status";
import type { LogEntry, MaiBotModuleUpdateProgress, ServiceDescriptor } from "../../../src/shared/contracts";

function progress(phase: MaiBotModuleUpdateProgress["phase"], label: string, percent: number): MaiBotModuleUpdateProgress {
  return { phase, label, percent, updatedAt: Date.now() };
}

test("initialization displays preparation stages even before the service starts", () => {
  const core = initializationStatus(undefined, true, progress("installing", "正在安装 MaiBot", 30));
  const dependencies = initializationStatus(undefined, true, progress("installing-dependencies", "正在安装依赖", 50));
  expect(core.detail).toBe("正在安装 MaiBot");
  expect(dependencies.detail).toBe("正在安装依赖");
  expect(dependencies.progress).toBeGreaterThan(core.progress);
});

test("completed installation does not claim that WebUI is ready", () => {
  const installed = initializationStatus({ status: "stopped", detail: "已停止" } as ServiceDescriptor, true, progress("completed", "安装完成", 100));
  expect(installed.detail).toBe("正在准备启动 MaiBot Core");
  expect(installed.progress).toBeLessThan(100);
  const waiting = initializationStatus({ status: "running", health: "checking" } as ServiceDescriptor, true, progress("completed", "安装完成", 100));
  expect(waiting.detail).toBe("正在等待 MaiBot WebUI 就绪");
  expect(waiting.progress).toBeGreaterThan(installed.progress);
  expect(initializationStatus({ status: "running", health: "ready" } as ServiceDescriptor, true).progress).toBe(100);
});

test("service errors and actual startup details take precedence over stale installation text", () => {
  const old = progress("installing", "正在安装 MaiBot", 30);
  expect(initializationStatus({ status: "error", error: "启动失败" } as ServiceDescriptor, true, old).detail).toBe("启动失败");
  expect(initializationStatus({ status: "starting", detail: "正在检查依赖" } as ServiceDescriptor, true).detail).toBe("正在检查依赖");
  expect(initializationStatus(undefined, false, old).progress).toBe(0);
});

test("restart download disappears before Core startup even while service remains starting", () => {
  const starting = { status: "starting" } as ServiceDescriptor;
  expect(canRestartDependencyDownload(starting, null)).toBe(false);
  for (const phase of ["installing", "installing-dependencies"] as const) {
    expect(canRestartDependencyDownload(starting, progress(phase, "安装中", 40))).toBe(true);
  }
  for (const phase of ["preparing", "validating", "switching", "completed", "failed"] as const) {
    expect(canRestartDependencyDownload(starting, progress(phase, "准备启动 Core", 100))).toBe(false);
  }
  for (const status of ["stopped", "running", "error"] as const) {
    expect(canRestartDependencyDownload({ status } as ServiceDescriptor, progress("installing", "旧安装进度", 30))).toBe(false);
  }
});

test("download progress follows the current file and survives a wait for pip output", () => {
  const logs: LogEntry[] = [
    "startup dependency upgrade: 下载进度 3.7 MB / 19.2 MB（19%）",
    "依赖检查已 30 秒没有新输出，仍在等待 pip 响应。",
    "MaiBot preparation:   Downloading second.whl",
    "MaiBot preparation: 已下载 1.2 MB",
    "MaiBot preparation: Installing collected packages: second",
  ].map((message, timestamp) => ({ id: String(timestamp), source: "maibot", stream: "system", message, timestamp }));

  expect(startupDownloadProgress(logs.slice(0, 2), 0)).toEqual({ percent: 19, label: "3.7 MB / 19.2 MB" });
  expect(startupDownloadProgress(logs.slice(0, 2), 1)).toBeUndefined();
  expect(startupDownloadProgress(logs.slice(0, 3), 0)).toEqual({ percent: null, label: "下载中" });
  expect(startupDownloadProgress(logs.slice(0, 4), 0)).toEqual({ percent: null, label: "1.2 MB" });
  expect(startupDownloadProgress(logs, 0)).toBeUndefined();
});
