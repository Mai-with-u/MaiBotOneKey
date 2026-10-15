import { expect, test } from "bun:test";
import { initializationStatus } from "../../src/renderer/src/lib/initialization-status";
import type { MaiBotModuleUpdateProgress, ServiceDescriptor } from "../../src/shared/contracts";

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
