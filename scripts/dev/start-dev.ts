import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEV_RESTART_FILE_ENV, DEV_RESUME_INSTANCE_ENV } from "../../src/shared/development-restart";
import { runDevelopmentSession } from "./development-session";
import { resolve, join } from "node:path";
import { DEV_INSTANCES_ENV, DEV_MODE_ENV, DEV_SOURCE_ENV, LOCAL_DASHBOARD_DEV_ENV, developmentRuntimeProfile, resolvePythonEnvironmentRoot } from "../../src/main/services/service-startup-defaults";
import { assertSourceCheckout, parseDevLaunchOptions } from "./dev-launch-options";
import { prepareDevPythonEnvironment } from "./prepare-python-environment";

async function main(): Promise<void> {
  const workspaceRoot = resolve(import.meta.dir, "../..");
  const options = parseDevLaunchOptions(process.argv.slice(2), workspaceRoot);
  const instances = process.env[DEV_INSTANCES_ENV] === "1";
  if (instances && options.mode !== "pypi") throw new Error("多实例测试仅支持 PyPI 启动模式。");
  if (options.help) {
    console.log("bun run dev:pypi [--dry-run]\nbun run dev:source [--source <源码目录>] [--dry-run]\nbun run dev:source:webui [--source <源码目录>] [--dry-run]");
    return;
  }
  const env = { ...process.env, [DEV_MODE_ENV]: options.mode };
  delete env[DEV_RESUME_INSTANCE_ENV];
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
  console.log(instances ? "[dev] 多实例测试：使用 AppData/MaiBotOneKeyDesktop/dev-instances 下的独立配置与默认实例，不导入正式版或普通开发模式数据。" : profile.sourceRoot ? `[dev] MaiBot 源码目录：${profile.sourceRoot}`
    : `[dev] 默认 MaiBot 目录：${join(workspaceRoot, "modules", "MaiBot")}（已保存的实例目录设置优先）`);
  console.log(`[dev] Dashboard：${options.localDashboard ? "源码目录中的本地构建" : "已安装的 Dashboard 包（可在设置中调整）"}`);
  console.log(instances ? "[dev] Python 环境：跟随测试实例，在初始化时准备。" : `[dev] Python 环境：${pythonRoot}${options.mode === "pypi" ? "（安装后使用实例绑定的独立环境）" : ""}`);
  if (options.mode === "source") console.log(`[dev] 源码实例使用独立运行环境：${profile.resourceRoot}；协议端由启动器共用。`);
  if (options.dryRun) return;
  if (options.mode === "source") await prepareDevPythonEnvironment(join(workspaceRoot, "runtime", "python"), pythonRoot);
  const sessionRoot = mkdtempSync(join(tmpdir(), "maibot-dev-session-"));
  const restartFile = join(sessionRoot, "restart");
  env[DEV_RESTART_FILE_ENV] = restartFile;
  let dev: ReturnType<typeof Bun.spawn> | undefined;
  let stopped = false;
  const shutdown = () => { stopped = true; dev?.kill(); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    process.exitCode = await runDevelopmentSession(async (sessionEnv) => {
      dev = Bun.spawn(["node", join(workspaceRoot, "node_modules", "electron-vite", "bin", "electron-vite.js"), "dev"], {
        cwd: workspaceRoot, env: sessionEnv, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      });
      return await dev.exited;
    }, env, restartFile, () => stopped);
  } finally {
    process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
    if (existsSync(restartFile)) unlinkSync(restartFile);
    rmdirSync(sessionRoot);
  }
}

if (import.meta.main) main().catch((error) => { console.error(`[dev] ${String(error)}`); process.exitCode = 1; });
