import { applyRuntimeResourcePaths, readStoredResourcePaths } from "./runtime-resource-paths";
export { applyRuntimeResourcePaths, LEGACY_RESOURCE_LOCATION_FILE, RESOURCE_PATHS_FILE } from "./runtime-resource-paths";
import { app } from "electron";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";
import { developmentRuntimeProfile, resolvePythonEnvironmentRoot } from "./service-startup-defaults";

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
  const profile = developmentRuntimeProfile(installRoot, app.isPackaged);
  const userDataRoot = join(app.getPath("appData"), "MaiBotOneKeyDesktop", `${installScope}${profile.settingsSuffix}`);
  const defaultResourceRoot = app.isPackaged ? userDataRoot : profile.resourceRoot ?? installRoot;
  const defaults = {
    maibot: profile.sourceRoot ?? join(defaultResourceRoot, "modules", "MaiBot"),
    napcat: join(defaultResourceRoot, "modules", "napcat"),
    snowluma: join(defaultResourceRoot, "modules", "SnowLuma"),
  };
  const stored = readStoredResourcePaths(userDataRoot);
  const bundledModulesRoot = join(payloadRoot, "modules");

  app.setPath("userData", userDataRoot);

  const paths: RuntimePaths = {
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
    pythonEnvRoot: resolvePythonEnvironmentRoot(installRoot, defaultResourceRoot, app.isPackaged),
    logsRoot: join(userDataRoot, "logs"),
  };
  applyRuntimeResourcePaths(paths, profile.mode === "source" ? { ...stored, maibot: profile.sourceRoot } : stored);
  return paths;
}
