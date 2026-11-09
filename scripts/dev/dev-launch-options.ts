import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DevelopmentMode } from "../../src/main/services/service-startup-defaults";

export interface DevLaunchOptions {
  mode: DevelopmentMode;
  sourceRoot: string;
  localDashboard: boolean;
  buildDashboard?: boolean;
  update?: boolean;
  resume?: string;
  instances?: boolean;
  sourceSpecified?: boolean;
  dryRun: boolean;
  help: boolean;
}

export function parseDevLaunchOptions(args: string[], workspaceRoot: string, defaultMode: DevelopmentMode = "pypi"): DevLaunchOptions {
  const options: DevLaunchOptions = { mode: defaultMode, sourceRoot: join(workspaceRoot, "modules", "MaiBot-source"), localDashboard: false, dryRun: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--local-dashboard") options.localDashboard = true;
    else if (arg === "--build-dashboard") options.buildDashboard = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--instances") options.instances = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--mode" || arg === "--source" || arg === "--resume") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少参数`);
      if (arg === "--mode") {
        if (value !== "pypi" && value !== "source") throw new Error(`未知模式：${value}，请选择 pypi 或 source`);
        options.mode = value;
      } else if (arg === "--source") {
        options.sourceRoot = resolve(workspaceRoot, value);
        options.sourceSpecified = true;
      } else {
        if (!/^run-[a-z0-9]+$/iu.test(value)) throw new Error("--resume 需要测试目录名，例如 run-PThaum。");
        options.resume = value;
      }
    } else throw new Error(`未知开发参数：${arg}`);
  }
  if (options.mode === "pypi" && (options.sourceSpecified || options.localDashboard || options.buildDashboard || options.resume || options.update)) {
    throw new Error("这些参数需要源码模式：bun run dev:source");
  }
  if (options.mode === "source" && options.instances) throw new Error("多实例测试请使用 bun run dev --instances。");
  if (options.resume && options.sourceSpecified) throw new Error("--resume 和 --source 不能混用。");
  options.localDashboard = options.mode === "source";
  return options;
}

export function assertSourceCheckout(root: string): string {
  if (!existsSync(root) || !statSync(root).isDirectory()
    || !existsSync(join(root, "bot.py")) || !statSync(join(root, "bot.py")).isFile()
    || !existsSync(join(root, "src")) || !statSync(join(root, "src")).isDirectory()
    || !existsSync(join(root, "pyproject.toml"))) {
    throw new Error(`MaiBot 源码目录无效：${root}。请使用有效的 --source 目录。`);
  }
  if (existsSync(join(root, ".onekey-deployment.json"))) throw new Error("该目录已用于 PyPI 部署，请选择独立的 MaiBot 源码 checkout，避免混用安装环境");
  return realpathSync(root);
}
