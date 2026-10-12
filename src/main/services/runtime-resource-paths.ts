import { join } from "node:path";
import type { RuntimePaths, RuntimeResourcePathKey } from "../../shared/contracts";
type RuntimeResourcePathMap = Record<RuntimeResourcePathKey, string>;

export const RESOURCE_PATHS_FILE = "resource-paths.json";
export const LEGACY_RESOURCE_LOCATION_FILE = "resource-location.json";

export function applyRuntimeResourcePaths(paths: RuntimePaths, updates: Partial<RuntimeResourcePathMap>): void {
  if (updates.maibot) {
    paths.maibotRoot = updates.maibot;
  }
  if (updates.napcat) {
    paths.napcatRoot = updates.napcat;
  }
  if (updates.snowluma) {
    paths.snowlumaRoot = updates.snowluma;
  }
  paths.resourceRoot = paths.defaultResourceRoot;
  paths.modulesRoot = join(paths.defaultResourceRoot, "modules");
}
