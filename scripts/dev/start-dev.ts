import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { DEV_RESTART_FILE_ENV, DEV_RESUME_INSTANCE_ENV } from "../../src/shared/development-restart";
import { runDevelopmentSession } from "./development-session";
import { resolve, join, relative, dirname } from "node:path";
import { DEV_FRESH_ROOT_ENV, DEV_INSTANCES_ENV, DEV_MODE_ENV, DEV_SOURCE_ENV, LOCAL_DASHBOARD_DEV_ENV, developmentRuntimeProfile, resolvePythonEnvironmentRoot } from "../../src/main/services/service-startup-defaults";
import { assertSourceCheckout, parseDevLaunchOptions } from "./dev-launch-options";
import { prepareMaiBotSource, updateMaiBotSource } from "./init-maibot-source";
import { buildLocalDashboard } from "./build-local-dashboard";

async function main(): Promise<void> {
  const workspaceRoot = await realpath(resolve(import.meta.dir, "../.."));
  const options = parseDevLaunchOptions(process.argv.slice(2), workspaceRoot);
  if (options.help) {
    console.log("bun run dev [--instances] [--dry-run]\nbun run dev:source [--source <源码目录> | --resume <旧测试目录名>] [--update] [--build-dashboard] [--dry-run]");
    return;
  }
  const env = { ...process.env, [DEV_MODE_ENV]: options.mode };
  delete env[DEV_RESUME_INSTANCE_ENV];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env[DEV_SOURCE_ENV];
  delete env[DEV_FRESH_ROOT_ENV];
  delete env[DEV_INSTANCES_ENV];
  if (options.instances) env[DEV_INSTANCES_ENV] = "1";
  env[LOCAL_DASHBOARD_DEV_ENV] = options.localDashboard ? "1" : "0";
  if (options.mode === "source") {
    const freshParent = join(workspaceRoot, ".cache", "dev-fresh");
    if (options.resume) {
      if (existsSync(freshParent) && relative(freshParent, await realpath(freshParent))) {
        throw new Error(`隔离测试目录不能指向其他位置：${freshParent}`);
      }
      const root = join(freshParent, options.resume);
      if (!existsSync(root) || relative(root, await realpath(root))) {
        throw new Error(`找不到独立测试目录或目录已被重定向：${root}`);
      }
      options.sourceRoot = join(root, "MaiBot");
      env[DEV_FRESH_ROOT_ENV] = root;
      if (process.platform === "darwin") {
        env.NAPCAT_QQ_APP = join(root, "QQ.app");
        env.NAPCAT_QQ_CONTAINER = join(root, "qq-container");
      }
      console.log(`[dev] 继续旧的隔离测试：${root}`);
      console.log(`[dev] QQ 配置：${join(root, "launcher", "protocol-settings")}`);
    }
    const sourceExists = existsSync(options.sourceRoot);
    if (!options.resume && !options.sourceSpecified) {
      await prepareMaiBotSource(workspaceRoot, options.sourceRoot, options.dryRun);
    }
    if (options.sourceSpecified || options.resume || !options.dryRun || existsSync(options.sourceRoot)) {
      const source = assertSourceCheckout(options.sourceRoot);
      if (env[DEV_FRESH_ROOT_ENV] && relative(options.sourceRoot, source)) throw new Error("隔离测试的源码目录不能指向其他位置。");
      if (!env[DEV_FRESH_ROOT_ENV]) {
        if (!relative(freshParent, dirname(dirname(source)))) throw new Error("请用 --resume 继续隔离测试，以复用原有 Python 环境和 QQ 配置。");
        options.sourceRoot = source;
      }
    }
    if (options.update && sourceExists) await updateMaiBotSource(workspaceRoot, options.sourceRoot, options.dryRun);
    const dashboardExists = existsSync(join(options.sourceRoot, "dashboard", "dist", "index.html"));
    if (options.buildDashboard || !dashboardExists || options.update) {
      await buildLocalDashboard(options.sourceRoot, options.dryRun, options.update);
      if (options.buildDashboard) return;
    }
    env[DEV_SOURCE_ENV] = options.sourceRoot;
  }
  const profile = developmentRuntimeProfile(workspaceRoot, false, env);
  const pythonRoot = resolvePythonEnvironmentRoot(workspaceRoot, profile.resourceRoot ?? workspaceRoot, false, env);
  console.log(`[dev] MaiBot 模式：${options.mode === "source" ? "本地源码" : "PyPI 安装版"}`);
  console.log(options.instances ? "[dev] 多实例测试：使用 AppData/MaiBotOneKeyDesktop/dev-instances 下的独立配置与默认实例，不导入正式版或普通开发模式数据。" : profile.sourceRoot ? `[dev] MaiBot 源码目录：${profile.sourceRoot}`
    : `[dev] 默认 MaiBot 目录：${join(workspaceRoot, "modules", "MaiBot")}（已保存的实例目录设置优先）`);
  console.log(`[dev] Dashboard：${options.localDashboard ? "源码目录中的本地构建" : "已安装的 Dashboard 包（可在设置中调整）"}`);
  console.log(options.instances ? "[dev] Python 环境：跟随测试实例，在初始化时准备。" : `[dev] Python 环境：${pythonRoot}${options.mode === "pypi" ? "（安装后使用实例绑定的独立环境）" : ""}`);
  if (options.dryRun) return;
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
