import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DevelopmentMode } from "../../src/main/services/service-startup-defaults";

export interface DevLaunchOptions {
  mode: DevelopmentMode;
  sourceRoot: string;
  localDashboard: boolean;
  dryRun: boolean;
  help: boolean;
}

export function parseDevLaunchOptions(args: string[], workspaceRoot: string, defaultMode: DevelopmentMode = "pypi"): DevLaunchOptions {
  const options: DevLaunchOptions = { mode: defaultMode, sourceRoot: join(workspaceRoot, "modules", "MaiBot-source"), localDashboard: false, dryRun: false, help: false };
  let sourceSpecified = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--local-dashboard") options.localDashboard = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--mode" || arg === "--source") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少参数`);
      if (arg === "--mode") {
        if (value !== "pypi" && value !== "source") throw new Error(`未知模式：${value}，请选择 pypi 或 source`);
        options.mode = value;
      } else { options.sourceRoot = resolve(workspaceRoot, value); sourceSpecified = true; }
    } else throw new Error(`未知开发参数：${arg}`);
  }
  if (options.mode === "pypi" && (sourceSpecified || options.localDashboard)) throw new Error("--source 和 --local-dashboard 请配合源码模式使用：bun run dev:source");
  return options;
}

export function assertSourceCheckout(root: string): string {
  if (!existsSync(root) || !statSync(root).isDirectory()
    || !existsSync(join(root, "bot.py")) || !statSync(join(root, "bot.py")).isFile()
    || !existsSync(join(root, "src")) || !statSync(join(root, "src")).isDirectory()
    || !existsSync(join(root, "pyproject.toml"))) {
    throw new Error(`MaiBot 源码目录无效：${root}。请先运行 bun run dev:source:init，或使用 bun run dev:source --source <源码目录>。`);
  }
  if (existsSync(join(root, ".onekey-deployment.json"))) throw new Error("该目录已用于 PyPI 部署，请选择独立的 MaiBot 源码 checkout，避免混用安装环境");
  return realpathSync(root);
}
