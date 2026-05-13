import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RuntimePaths, RuntimeResourcePathKey } from "../../shared/contracts";

export const RESOURCE_PATHS_FILE = "resource-paths.json";
export const LEGACY_RESOURCE_LOCATION_FILE = "resource-location.json";

type RuntimeResourcePathMap = Record<RuntimeResourcePathKey, string>;

interface StoredResourcePathsFile {
  version: 1;
  paths?: Partial<RuntimeResourcePathMap>;
}

interface LegacyStoredResourceLocationFile {
  version: 1;
  resourceRoot?: string;
}

function resolveInstallRoot(): string {
  return app.isPackaged ? dirname(process.execPath) : process.cwd();
}

function resolvePayloadRoot(installRoot: string): string {
  return app.isPackaged ? process.resourcesPath : installRoot;
}

function createInstallScope(installRoot: string): string {
  return createHash("sha256").update(installRoot).digest("hex").slice(0, 12);
}

function normalizePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : undefined;
}

function defaultResourcePaths(defaultResourceRoot: string): RuntimeResourcePathMap {
  return {
    maibot: join(defaultResourceRoot, "modules", "MaiBot"),
    napcat: join(defaultResourceRoot, "modules", "napcat"),
    pythonOverrides: join(defaultResourceRoot, "python-overrides"),
  };
}

function readStoredResourcePaths(userDataRoot: string, defaultResourceRoot: string): Partial<RuntimeResourcePathMap> {
  const storePath = join(userDataRoot, RESOURCE_PATHS_FILE);
  if (existsSync(storePath)) {
    try {
      const raw = JSON.parse(readFileSync(storePath, "utf8")) as StoredResourcePathsFile;
      return {
        maibot: normalizePath(raw.paths?.maibot),
        napcat: normalizePath(raw.paths?.napcat),
        pythonOverrides: normalizePath(raw.paths?.pythonOverrides),
      };
    } catch {
      return {};
    }
  }

  const legacyStorePath = join(userDataRoot, LEGACY_RESOURCE_LOCATION_FILE);
  if (!existsSync(legacyStorePath)) {
    return {};
  }

  try {
    const raw = JSON.parse(readFileSync(legacyStorePath, "utf8")) as LegacyStoredResourceLocationFile;
    const resourceRoot = normalizePath(raw.resourceRoot);
    return resourceRoot ? defaultResourcePaths(resourceRoot) : {};
  } catch {
    return {};
  }
}

export function applyRuntimeResourcePaths(paths: RuntimePaths, updates: Partial<RuntimeResourcePathMap>): void {
  if (updates.maibot) {
    paths.maibotRoot = updates.maibot;
  }
  if (updates.napcat) {
    paths.napcatRoot = updates.napcat;
  }
  if (updates.pythonOverrides) {
    paths.pythonOverridesRoot = updates.pythonOverrides;
  }
  paths.resourceRoot = paths.defaultResourceRoot;
  paths.modulesRoot = join(paths.defaultResourceRoot, "modules");
}

export function configureRuntimePaths(): RuntimePaths {
  const installRoot = resolveInstallRoot();
  const payloadRoot = resolvePayloadRoot(installRoot);
  const installScope = createInstallScope(installRoot);
  const userDataRoot = join(app.getPath("appData"), "MaiBotOneKeyDesktop", installScope);
  const defaultResourceRoot = app.isPackaged ? userDataRoot : installRoot;
  const defaults = defaultResourcePaths(defaultResourceRoot);
  const stored = readStoredResourcePaths(userDataRoot, defaultResourceRoot);
  const bundledModulesRoot = join(payloadRoot, "modules");

  app.setPath("userData", userDataRoot);

  const paths: RuntimePaths = {
    installRoot,
    userDataRoot,
    defaultResourceRoot,
    resourceRoot: defaultResourceRoot,
    modulesRoot: join(defaultResourceRoot, "modules"),
    defaultMaibotRoot: defaults.maibot,
    maibotRoot: defaults.maibot,
    defaultNapcatRoot: defaults.napcat,
    napcatRoot: defaults.napcat,
    bundledModulesRoot,
    runtimeRoot: join(payloadRoot, "runtime"),
    defaultPythonOverridesRoot: defaults.pythonOverrides,
    pythonOverridesRoot: defaults.pythonOverrides,
    logsRoot: join(userDataRoot, "logs"),
  };
  applyRuntimeResourcePaths(paths, stored);
  return paths;
}
