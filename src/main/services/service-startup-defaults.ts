import type { ServiceStartupSettings } from "../../shared/contracts";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const LOCAL_DASHBOARD_DEV_ENV = "MAIBOT_ONEKEY_DEV_LOCAL_DASHBOARD";
export const DEV_MODE_ENV = "MAIBOT_ONEKEY_DEV_MODE";
export const DEV_SOURCE_ENV = "MAIBOT_ONEKEY_DEV_SOURCE";
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
  return { mode, sourceRoot: resolve(sourceRoot), resourceRoot: join(installRoot, ".cache", "dev-source", scope), settingsSuffix: `-source-${scope}` };
}

export function isLocalDashboardDevLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LOCAL_DASHBOARD_DEV_ENV] === "1";
}

export function defaultServiceStartupSettings(): ServiceStartupSettings {
  return { useLocalDashboard: isLocalDashboardDevLaunch() };
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
