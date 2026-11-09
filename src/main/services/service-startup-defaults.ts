import type { ServiceStartupSettings } from "../../shared/contracts";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const LOCAL_DASHBOARD_DEV_ENV = "MAIBOT_ONEKEY_DEV_LOCAL_DASHBOARD";
export const DEV_MODE_ENV = "MAIBOT_ONEKEY_DEV_MODE";
export const DEV_SOURCE_ENV = "MAIBOT_ONEKEY_DEV_SOURCE";
export const DEV_INSTANCES_ENV = "MAIBOT_ONEKEY_DEV_INSTANCES";
export const DEV_FRESH_ROOT_ENV = "MAIBOT_ONEKEY_DEV_FRESH_ROOT";
export const STARTUP_AGREEMENT_FILE = "agreement.json";

export function developmentFreshRoot(installRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  const root = env[DEV_FRESH_ROOT_ENV];
  if (!root) return undefined;
  if (!isAbsolute(root) || dirname(resolve(root)) !== join(installRoot, ".cache", "dev-fresh")
    || env[DEV_MODE_ENV] !== "source" || env[DEV_SOURCE_ENV] !== join(root, "MaiBot")) {
    throw new Error("独立源码测试目录无效，请使用 bun run dev:source --resume。");
  }
  return resolve(root);
}
export function developmentInstanceRoot(installRoot: string, appDataRoot: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isPackaged || env[DEV_INSTANCES_ENV] !== "1") return undefined;
  if (env[DEV_MODE_ENV] === "source") throw new Error("多实例测试请使用 bun run dev --instances，不要与固定源码模式混用。");
  const scope = createHash("sha256").update(installRoot).digest("hex").slice(0, 12);
  return join(appDataRoot, "MaiBotOneKeyDesktop", "dev-instances", scope);
}
export type DevelopmentMode = "pypi" | "source";

export function developmentRuntimeProfile(installRoot: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): {
  mode?: DevelopmentMode; sourceRoot?: string; resourceRoot?: string; settingsSuffix: string;
} {
  if (isPackaged || !env[DEV_MODE_ENV]) return { settingsSuffix: "" };
  const mode = env[DEV_MODE_ENV];
  if (mode === "pypi") return { mode, settingsSuffix: "" };
  if (mode !== "source") throw new Error(`未知开发运行模式：${mode}`);
  const sourceRoot = env[DEV_SOURCE_ENV] || join(installRoot, "modules", "MaiBot-source");
  if (!isAbsolute(sourceRoot)) throw new Error("源码开发目录必须是绝对路径");
  const scope = createHash("sha256").update(resolve(sourceRoot)).digest("hex").slice(0, 12);
  return { mode, sourceRoot: resolve(sourceRoot), resourceRoot: developmentFreshRoot(installRoot, env) ?? join(installRoot, ".cache", "dev-source", scope), settingsSuffix: `-source-${scope}` };
}

export function isLocalDashboardDevLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOCAL_DASHBOARD_DEV_ENV] === "1";
}

export function defaultServiceStartupSettings(): ServiceStartupSettings {
  return { useLocalDashboard: isLocalDashboardDevLaunch(), autoStartServices: false };
}

export function resolvePythonEnvironmentRoot(
  installRoot: string,
  resourceRoot: string,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const profile = developmentRuntimeProfile(installRoot, isPackaged, env);
  if (profile.mode === "source") return join(profile.resourceRoot!, "python-env");
  return !isPackaged && isLocalDashboardDevLaunch(env)
    ? join(installRoot, ".cache", "dev-python-env")
    : join(resourceRoot, "python-env");
}
