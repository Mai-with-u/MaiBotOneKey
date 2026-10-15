import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { DEV_MODE_ENV, DEV_SOURCE_ENV, LOCAL_DASHBOARD_DEV_ENV, developmentRuntimeProfile, resolvePythonEnvironmentRoot } from "../../src/main/services/service-startup-defaults";
import { assertSourceCheckout, parseDevLaunchOptions } from "./dev-launch-options";
import { prepareDevPythonEnvironment } from "./prepare-python-environment";

async function main(): Promise<void> {
  const workspaceRoot = resolve(import.meta.dir, "../..");
  const options = parseDevLaunchOptions(process.argv.slice(2), workspaceRoot);
  if (options.help) {
    console.log("bun run dev:pypi [--dry-run]\nbun run dev:source [--source <源码目录>] [--dry-run]\nbun run dev:source:webui [--source <源码目录>] [--dry-run]");
    return;
  }
  const env = { ...process.env, [DEV_MODE_ENV]: options.mode };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env[DEV_SOURCE_ENV];
  env[LOCAL_DASHBOARD_DEV_ENV] = "0";
  if (options.mode === "source") {
    options.sourceRoot = assertSourceCheckout(options.sourceRoot);
    env[DEV_SOURCE_ENV] = options.sourceRoot;
    if (options.localDashboard) {
      if (!existsSync(join(options.sourceRoot, "dashboard", "dist", "index.html"))) {
        throw new Error(`本地 Dashboard 尚未构建，请先运行 bun run dev:build --source "${options.sourceRoot}"`);
      }
      env[LOCAL_DASHBOARD_DEV_ENV] = "1";
    }
  }
  const profile = developmentRuntimeProfile(workspaceRoot, false, env);
  const pythonRoot = resolvePythonEnvironmentRoot(workspaceRoot, profile.resourceRoot ?? workspaceRoot, false, env);
  console.log(`[dev] MaiBot 模式：${options.mode === "source" ? "本地源码" : "PyPI 安装版"}`);
  console.log(profile.sourceRoot ? `[dev] MaiBot 源码目录：${profile.sourceRoot}`
    : `[dev] 默认 MaiBot 目录：${join(workspaceRoot, "modules", "MaiBot")}（已保存的实例目录设置优先）`);
  console.log(`[dev] Dashboard：${options.localDashboard ? "源码目录中的本地构建" : "已安装的 Dashboard 包（可在设置中调整）"}`);
  console.log(`[dev] Python 环境：${pythonRoot}${options.mode === "pypi" ? "（安装后使用实例绑定的独立环境）" : ""}`);
  if (options.mode === "source") console.log(`[dev] 源码模式使用独立设置和协议端目录：${profile.resourceRoot}`);
  if (options.dryRun) return;
  if (options.mode === "source") await prepareDevPythonEnvironment(join(workspaceRoot, "runtime", "python"), pythonRoot);
  const dev = Bun.spawn(["node", join(workspaceRoot, "node_modules", "electron-vite", "bin", "electron-vite.js"), "dev"], {
    cwd: workspaceRoot, env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const shutdown = () => dev.kill();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.exit(await dev.exited);
}

if (import.meta.main) main().catch((error) => { console.error(`[dev] ${String(error)}`); process.exitCode = 1; });
