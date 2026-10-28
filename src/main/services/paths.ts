import { applyRuntimeResourcePaths, readStoredResourcePaths } from "./runtime-resource-paths";
export { applyRuntimeResourcePaths, LEGACY_RESOURCE_LOCATION_FILE, RESOURCE_PATHS_FILE } from "./runtime-resource-paths";
import { app } from "electron";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { InstanceRegistry, readInstallerInstanceRoot } from "./instance-registry";
import { configureDevelopmentInstances, INSTANCE_RELAUNCH_ARG } from "./development-instances";
import { DEV_RESUME_INSTANCE_ENV } from "../../shared/development-restart";
import { readSharedProtocols } from "./shared-protocols";
import { dirname, join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";
import { DEV_MODE_ENV, DEV_SOURCE_ENV, LOCAL_DASHBOARD_DEV_ENV, developmentInstanceRoot, developmentRuntimeProfile, resolvePythonEnvironmentRoot } from "./service-startup-defaults";

function resolveInstallRoot(): string {
  return app.isPackaged ? dirname(process.execPath) : process.cwd();
}

function resolvePayloadRoot(installRoot: string): string {
  return app.isPackaged ? process.resourcesPath : installRoot;
}

function createInstallScope(installRoot: string): string {
  return createHash("sha256").update(installRoot).digest("hex").slice(0, 12);
}

export function configureRuntimePaths(): RuntimePaths {
  const installRoot = resolveInstallRoot();
  const payloadRoot = resolvePayloadRoot(installRoot);
  const installScope = createInstallScope(installRoot);
  let profile = developmentRuntimeProfile(installRoot, app.isPackaged);
  let instancePythonRoot: string | undefined;
  const testRoot = developmentInstanceRoot(installRoot, app.getPath("appData"), app.isPackaged);
  const legacyRoot = join(app.getPath("appData"), "MaiBotOneKeyDesktop", `${installScope}${profile.settingsSuffix}`);
  let userDataRoot = legacyRoot;
  let defaultResourceRoot = app.isPackaged ? userDataRoot : profile.resourceRoot ?? installRoot;
  let defaults = {
    maibot: profile.sourceRoot ?? join(defaultResourceRoot, "modules", "MaiBot"),
    napcat: join(defaultResourceRoot, "modules", "napcat"),
    snowluma: join(defaultResourceRoot, "modules", "SnowLuma"),
  };
  let instanceRegistryRoot: string | undefined, activeInstanceId: string | undefined, activeInstanceName: string | undefined;
  // Opt-in development uses a separate registry and never discovers production profiles.
  if (app.isPackaged || testRoot) {
    instanceRegistryRoot = testRoot ? join(testRoot, "launcher") : join(app.getPath("appData"), "MaiBotOneKeyDesktop", "launcher");
    const seed = testRoot ? undefined : readInstallerInstanceRoot(installRoot);
    const registry = new InstanceRegistry(instanceRegistryRoot);
    const state = registry.initialize(testRoot ? join(testRoot, "legacy") : legacyRoot, testRoot ? join(testRoot, "default-instance") : defaultResourceRoot, seed, !testRoot, [installRoot]);
    const active = state.instances.find(item => item.id === state.activeId)!;
    userDataRoot = active.settingsRoot;
    defaultResourceRoot = active.resourceRoot;
    defaults = active.paths;
    activeInstanceId = active.id;
    activeInstanceName = active.name;
  } else {
    const { registry, active } = configureDevelopmentInstances(installRoot, app.getPath("appData"), process.env, process.argv.includes(INSTANCE_RELAUNCH_ARG) || process.env[DEV_RESUME_INSTANCE_ENV] === "1");
    instanceRegistryRoot = registry.root;
    activeInstanceId = active.id;
    activeInstanceName = active.name;
    userDataRoot = active.settingsRoot;
    defaultResourceRoot = active.resourceRoot;
    defaults = active.paths;
    const mode = active.development?.mode ?? "pypi";
    process.env[DEV_MODE_ENV] = mode;
    process.env[LOCAL_DASHBOARD_DEV_ENV] = active.development?.localDashboard ? "1" : "0";
    if (mode === "source") process.env[DEV_SOURCE_ENV] = active.paths.maibot;
    else delete process.env[DEV_SOURCE_ENV];
    profile = developmentRuntimeProfile(installRoot, false);
    instancePythonRoot = active.development?.pythonRoot;
  }
  const sharedProtocols = instanceRegistryRoot ? readSharedProtocols(instanceRegistryRoot) : undefined;
  if (sharedProtocols) defaults = { ...defaults, ...sharedProtocols.defaults };
  const stored = { ...readStoredResourcePaths(userDataRoot), ...sharedProtocols?.paths };
  const bundledModulesRoot = join(payloadRoot, "modules");

  // Share the launcher OS lock across instances; keep browser state isolated per profile.
  app.setPath("userData", instanceRegistryRoot ?? userDataRoot);
  if (instanceRegistryRoot) {
    mkdirSync(userDataRoot, { recursive: true });
    app.setPath("sessionData", userDataRoot);
  }

  const paths: RuntimePaths = {
    protocolSettingsRoot: sharedProtocols?.settingsRoot,
    instanceRegistryRoot,
    activeInstanceId,
    activeInstanceName,
    maibotDevMode: profile.mode,
    installRoot,
    userDataRoot,
    defaultResourceRoot,
    resourceRoot: defaultResourceRoot,
    modulesRoot: join(defaultResourceRoot, "modules"),
    defaultMaibotRoot: defaults.maibot,
    maibotRoot: defaults.maibot,
    defaultNapcatRoot: defaults.napcat,
    napcatRoot: defaults.napcat,
    defaultSnowlumaRoot: defaults.snowluma,
    snowlumaRoot: defaults.snowluma,
    bundledModulesRoot,
    runtimeRoot: join(payloadRoot, "runtime"),
    pythonEnvRoot: instancePythonRoot ?? resolvePythonEnvironmentRoot(installRoot, defaultResourceRoot, app.isPackaged),
    logsRoot: join(userDataRoot, "logs"),
  };
  applyRuntimeResourcePaths(paths, profile.mode === "source" ? { ...stored, maibot: profile.sourceRoot } : stored);
  return paths;
}
