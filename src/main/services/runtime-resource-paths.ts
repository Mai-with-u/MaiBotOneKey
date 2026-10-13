import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { RuntimePaths, RuntimeResourcePathKey } from "../../shared/contracts";
type RuntimeResourcePathMap = Record<RuntimeResourcePathKey, string>;

export const RESOURCE_PATHS_FILE = "resource-paths.json";
export const LEGACY_RESOURCE_LOCATION_FILE = "resource-location.json";

function readStore(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`无法读取组件目录配置 ${path}：${String(error)}`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是对象");
    const record = value as Record<string, unknown>;
    if (record.version !== 1) throw new Error("不支持的配置版本");
    return record;
  } catch (error) {
    throw new Error(`组件目录配置无效 ${path}：${String(error)}。请修复配置后重新打开启动器。`, { cause: error });
  }
}

function storedPath(value: unknown, storePath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
    throw new Error(`组件目录配置无效 ${storePath}：目录必须是非空绝对路径。`);
  }
  return resolve(value.trim());
}

export function readStoredResourcePaths(userDataRoot: string): Partial<RuntimeResourcePathMap> {
  const storePath = join(userDataRoot, RESOURCE_PATHS_FILE);
  const current = readStore(storePath);
  if (current) {
    const value = current.paths;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`组件目录配置无效 ${storePath}：缺少 paths 对象。`);
    }
    const paths = value as Record<string, unknown>;
    return {
      maibot: storedPath(paths.maibot, storePath),
      napcat: storedPath(paths.napcat, storePath),
      snowluma: storedPath(paths.snowluma, storePath),
    };
  }
  const legacyPath = join(userDataRoot, LEGACY_RESOURCE_LOCATION_FILE);
  const legacy = readStore(legacyPath);
  if (!legacy) return {};
  const root = storedPath(legacy.resourceRoot, legacyPath);
  if (!root) throw new Error(`组件目录配置无效 ${legacyPath}：缺少 resourceRoot。`);
  return {
    maibot: join(root, "modules", "MaiBot"),
    napcat: join(root, "modules", "napcat"),
    snowluma: join(root, "modules", "SnowLuma"),
  };
}

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
