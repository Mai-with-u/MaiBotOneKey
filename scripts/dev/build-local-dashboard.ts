import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertSourceCheckout, parseDevLaunchOptions } from "./dev-launch-options";

async function main(): Promise<void> {
  const options = parseDevLaunchOptions(process.argv.slice(2), resolve(import.meta.dir, "../.."), "source");
  if (options.help) { console.log("bun run dev:build [--source <MaiBot 源码目录>]"); return; }
  const dashboardRoot = resolve(assertSourceCheckout(options.sourceRoot), "dashboard");
  if (!existsSync(resolve(dashboardRoot, "package.json"))) {
    throw new Error(`本地 Dashboard 源码不存在：${dashboardRoot}`);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log("[dev:build] 构建本地 MaiBot Dashboard…");
  if (options.dryRun) { console.log(`[dev:build] ${dashboardRoot}`); return; }
  if (!existsSync(resolve(dashboardRoot, "node_modules"))) {
    console.log("[dev:build] 首次安装 Dashboard 依赖…");
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
  process.exit(await build.exited);
}

if (import.meta.main) await main();
