import type { ServiceStartupSettings } from "../../shared/contracts";
import { join } from "node:path";

export const LOCAL_DASHBOARD_DEV_ENV = "MAIBOT_ONEKEY_DEV_LOCAL_DASHBOARD";

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
  return !isPackaged && isLocalDashboardDevLaunch(env)
    ? join(installRoot, ".cache", "dev-python-env")
    : join(resourceRoot, "python-env");
}
