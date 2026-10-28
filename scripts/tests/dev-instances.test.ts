import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { developmentInstanceRoot, DEV_INSTANCES_ENV, DEV_MODE_ENV } from "../../src/main/services/service-startup-defaults";

test("multi-instance development is opt-in, workspace-scoped and separate from production", () => {
  const workspace = resolve("workspace-a"), appData = resolve("test-appdata");
  const env = { [DEV_INSTANCES_ENV]: "1", [DEV_MODE_ENV]: "pypi" };
  expect(developmentInstanceRoot(workspace, appData, false, {})).toBeUndefined();
  expect(developmentInstanceRoot(workspace, appData, true, env)).toBeUndefined();
  const root = developmentInstanceRoot(workspace, appData, false, env)!;
  expect(root.startsWith(join(appData, "MaiBotOneKeyDesktop", "dev-instances"))).toBe(true);
  expect(root).not.toBe(developmentInstanceRoot(resolve("workspace-b"), appData, false, env));
  expect(() => developmentInstanceRoot(workspace, appData, false, { ...env, [DEV_MODE_ENV]: "source" })).toThrow("不要与固定源码模式混用");
});

test("dedicated test command forwards dry-run without launching Electron", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/dev/start-instances.ts", "--dry-run"], { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(output).toContain("多实例测试");
  expect(output).toContain("不导入正式版");
  expect(output).not.toContain("默认 MaiBot 目录");
});
