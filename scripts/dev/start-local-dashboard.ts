import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { LOCAL_DASHBOARD_DEV_ENV, resolvePythonEnvironmentRoot } from "../../src/main/services/service-startup-defaults";
import { prepareDevPythonEnvironment } from "./prepare-python-environment";

const workspaceRoot = resolve(import.meta.dir, "../..");
const dashboardRoot = resolve(workspaceRoot, "modules/MaiBot/dashboard");

async function main(): Promise<void> {
  if (!existsSync(resolve(dashboardRoot, "dist/index.html"))) {
    throw new Error("本地 Dashboard 尚未构建，请先运行 bun run dev:build，再运行 bun run dev:dev。");
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log("[dev:dev] 使用已有的本地 MaiBot Dashboard 构建。");

  const devEnv = { ...env, [LOCAL_DASHBOARD_DEV_ENV]: "1" };
  const pythonRoot = resolvePythonEnvironmentRoot(workspaceRoot, workspaceRoot, false, devEnv);
  console.log(`[dev:dev] 准备可复用测试环境：${pythonRoot}`);
  const preparation = await prepareDevPythonEnvironment(resolve(workspaceRoot, "python-env"), pythonRoot);
  console.log(preparation === "seeded"
    ? "[dev:dev] 已从现有 Python 环境复制依赖，后续启动直接复用。"
    : preparation === "reused"
      ? "[dev:dev] 复用已安装的测试依赖。"
      : "[dev:dev] 测试环境将在初始化时创建并安装依赖，后续启动复用。");

  console.log("[dev:dev] 启动一键包，默认使用本地 Dashboard（重置后也保持开启）。");
  const dev = Bun.spawn([process.execPath, "run", "dev"], {
    cwd: workspaceRoot,
    env: devEnv,
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const shutdown = () => dev.kill();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.exit(await dev.exited);
}

if (import.meta.main) await main();
