import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LauncherInstance } from "../../shared/contracts";
import { componentDefaults, InstanceRegistry } from "./instance-registry";
import { developmentFreshRoot, developmentRuntimeProfile, DEV_MODE_ENV, DEV_SOURCE_ENV, LOCAL_DASHBOARD_DEV_ENV, resolvePythonEnvironmentRoot } from "./service-startup-defaults";

export const INSTANCE_RELAUNCH_ARG = "--onekey-instance-relaunch";
export function configureDevelopmentInstances(installRoot: string, appDataRoot: string, env: NodeJS.ProcessEnv, switching = false) {
  const freshRoot = developmentFreshRoot(installRoot, env);
  if (freshRoot) {
    const registry = new InstanceRegistry(join(freshRoot, "launcher"));
    const instance: LauncherInstance = {
      id: "dev-fresh", name: "MaiBot dev 临时测试",
      settingsRoot: join(freshRoot, "settings"), resourceRoot: freshRoot,
      paths: { ...componentDefaults(freshRoot), maibot: join(freshRoot, "MaiBot") },
      development: { mode: "source", pythonRoot: join(freshRoot, "python-env"), localDashboard: true },
    };
    return { registry, active: registry.initializeDevelopment([instance], instance.id).instances[0] };
  }
  const scope = createHash("sha256").update(installRoot).digest("hex").slice(0, 12);
  const base = join(appDataRoot, "MaiBotOneKeyDesktop");
  const registry = new InstanceRegistry(join(base, "development", scope, "launcher"));
  const pypiEnv = { ...env, [DEV_MODE_ENV]: "pypi", [LOCAL_DASHBOARD_DEV_ENV]: "0" };
  const defaults: LauncherInstance[] = [{
    id: "dev-pypi", name: "默认 PyPI 实例", settingsRoot: join(base, scope), resourceRoot: installRoot,
    paths: componentDefaults(installRoot),
    development: { mode: "pypi", pythonRoot: resolvePythonEnvironmentRoot(installRoot, installRoot, false, pypiEnv), localDashboard: false },
  }];
  const sourcePaths = new Set([join(installRoot, "modules", "MaiBot-source"), ...(env[DEV_SOURCE_ENV] ? [env[DEV_SOURCE_ENV]!] : [])]);
  let selectedSourceId = "";
  for (const sourceRoot of sourcePaths) {
    const sourceEnv = { ...env, [DEV_MODE_ENV]: "source", [DEV_SOURCE_ENV]: sourceRoot };
    const profile = developmentRuntimeProfile(installRoot, false, sourceEnv);
    const id = `dev${profile.settingsSuffix}`;
    selectedSourceId = id;
    defaults.push({ id, name: defaults.length === 1 ? "源码调试实例" : "自定义源码调试实例",
      settingsRoot: join(base, `${scope}${profile.settingsSuffix}`), resourceRoot: profile.resourceRoot!,
      paths: { ...componentDefaults(profile.resourceRoot!), maibot: profile.sourceRoot! },
      development: { mode: "source", pythonRoot: join(profile.resourceRoot!, "python-env"), localDashboard: true },
    });
  }
  const preferred = switching ? undefined : env[DEV_MODE_ENV] === "source" ? selectedSourceId : "dev-pypi";
  const state = registry.initializeDevelopment(defaults, preferred);
  return { registry, active: state.instances.find(item => item.id === state.activeId)! };
}
