import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function buildLocalDashboard(sourceRoot: string, dryRun: boolean, syncDependencies = false): Promise<void> {
  const dashboardRoot = resolve(sourceRoot, "dashboard");
  console.log(`[dev] 构建本地 MaiBot Dashboard：${dashboardRoot}`);
  if (dryRun) return;
  if (!existsSync(resolve(dashboardRoot, "package.json"))) throw new Error(`本地 Dashboard 源码不存在：${dashboardRoot}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (syncDependencies || !existsSync(resolve(dashboardRoot, "node_modules"))) {
    console.log("[dev] 准备 Dashboard 依赖…");
    const install = Bun.spawn([process.execPath, "install", ...(existsSync(resolve(dashboardRoot, "bun.lock")) ? ["--frozen-lockfile"] : [])], {
      cwd: dashboardRoot, env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    if (await install.exited !== 0) throw new Error("Dashboard 依赖安装失败");
  }
  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: dashboardRoot,
    env,
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  if (await build.exited !== 0) throw new Error("Dashboard 构建失败");
}
