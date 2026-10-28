import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LauncherInstance } from "../../shared/contracts";
import { readStoredResourcePaths } from "./runtime-resource-paths";

export const SHARED_PROTOCOLS_FILE = "shared-protocols.json";
export interface SharedProtocols {
  version: 1;
  settingsRoot: string;
  paths: { napcat: string; snowluma: string };
  defaults: { napcat: string; snowluma: string };
}
export function readSharedProtocols(root: string): SharedProtocols | undefined {
  const file = join(root, SHARED_PROTOCOLS_FILE);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as SharedProtocols;
  if (value.version !== 1 || !isAbsolute(value.settingsRoot) || [value.paths?.napcat, value.paths?.snowluma, value.defaults?.napcat, value.defaults?.snowluma].some(path => typeof path !== "string" || !isAbsolute(path))) throw new Error(`共享协议端配置无效：${file}`);
  return value;
}
/** Adopt the active legacy binding once, keeping all other component directories intact. */
export function ensureSharedProtocols(root: string, active: LauncherInstance): SharedProtocols {
  const existing = readSharedProtocols(root);
  if (existing) return existing;
  const overrides = readStoredResourcePaths(active.settingsRoot);
  const paths = { napcat: overrides.napcat ?? active.paths.napcat, snowluma: overrides.snowluma ?? active.paths.snowluma };
  const settingsRoot = join(root, "protocol-settings");
  mkdirSync(settingsRoot, { recursive: true });
  for (const name of ["qq-backend.json", "message-platform.json", "snowluma-webui-credential.json", "qq-component-upgrade-state.json", "service-commands.json"]) {
    const source = join(active.settingsRoot, name), target = join(settingsRoot, name);
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  const index = join(root, "instances.json"), backup = join(root, "instances-before-shared-protocols.json");
  if (existsSync(index) && !existsSync(backup)) copyFileSync(index, backup, constants.COPYFILE_EXCL);
  const value: SharedProtocols = { version: 1, settingsRoot, paths, defaults: { ...paths } };
  const file = join(root, SHARED_PROTOCOLS_FILE), temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx" }); renameSync(temporary, file);
  return value;
}
