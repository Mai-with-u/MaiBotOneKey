import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { MAIBOT_DEPLOYMENT_FILE, readMaiBotDeployment } from "../../src/main/services/maibot-deployment-state";

const RESOURCE_PATHS_FILE = "resource-paths.json";

interface StoredResourcePathsFile {
  version: 1;
  paths?: {
    maibot?: string;
    napcat?: string;
    snowluma?: string;
  };
}

function appDataRoot(): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error("APPDATA is not set; cannot resolve Electron appData path.");
    }
    return appData;
  }

  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }

  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function createInstallScope(installRoot: string): string {
  return createHash("sha256").update(installRoot).digest("hex").slice(0, 12);
}

function normalizePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) throw new Error("Component paths must be non-empty absolute paths.");
  return resolve(value.trim());
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`[reset-dev-state] Failed to read ${path}: ${String(error)}`);
  }
}

interface StoredComponentRoots {
  maibot?: string;
  napcat?: string;
  snowluma?: string;
}

export function readStoredComponentRoots(userDataRoot: string): StoredComponentRoots {
  const resourcePaths = readJsonFile<StoredResourcePathsFile>(join(userDataRoot, RESOURCE_PATHS_FILE));
  if (resourcePaths !== undefined && (!resourcePaths || resourcePaths.version !== 1 || !resourcePaths.paths || typeof resourcePaths.paths !== "object" || Array.isArray(resourcePaths.paths))) {
    throw new Error("Invalid resource-paths.json; fix it before resetting development state.");
  }
  return {
    maibot: normalizePath(resourcePaths?.paths?.maibot),
    napcat: normalizePath(resourcePaths?.paths?.napcat),
    snowluma: normalizePath(resourcePaths?.paths?.snowluma),
  };

}

function assertNotFilesystemRoot(target: string, label: string): void {
  const parsed = parse(target);
  if (resolve(target) === resolve(parsed.root)) {
    throw new Error(`${label} resolved to a filesystem root: ${target}`);
  }
}

function assertInside(parent: string, child: string, label: string): void {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  const diff = relative(normalizedParent, normalizedChild);
  if (diff.startsWith("..") || resolve(diff) === diff) {
    throw new Error(`${label} is outside expected root.\n  root: ${parent}\n  target: ${child}`);
  }
}

export function assertLooksLikeMaiBotRoot(maibotRoot: string, defaultMaiBotRoot: string): void {
  assertNotFilesystemRoot(maibotRoot, "MaiBot instance");
  if (readMaiBotDeployment(maibotRoot)) return;
  // A fresh default instance may contain only bundled plugins, or may not
  // exist yet. It does not acquire a deployment record until PyPI installation.
  if (resolve(maibotRoot) === resolve(defaultMaiBotRoot)) {
    if (!existsSync(maibotRoot)) return;
    const entry = lstatSync(maibotRoot);
    if (entry.isDirectory() && !entry.isSymbolicLink()) return;
    throw new Error(`Default MaiBot root is not a regular directory: ${maibotRoot}`);
  }
  throw new Error(`Custom MaiBot directory is not a PyPI instance: ${maibotRoot}`);
}

async function removePath(path: string, label: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] ${label}: ${path}`);
    return;
  }

  await rm(path, { recursive: true, force: true });
  console.log(`[removed] ${label}: ${path}`);
}

const COMPONENT_STATE_DIRECTORIES = ["config", "data", "logs", "cache", "temp", "tmp"] as const;

export function fullResetTargets(maibotRoot: string): Array<{ path: string; label: string }> {
  assertNotFilesystemRoot(maibotRoot, "MaiBot full reset root");
  if (existsSync(maibotRoot) && lstatSync(maibotRoot).isSymbolicLink()) {
    throw new Error(`MaiBot full reset root must not be a symbolic link: ${maibotRoot}`);
  }
  const targets: Array<{ path: string; label: string }> = [];
  for (const name of [".onekey", MAIBOT_DEPLOYMENT_FILE, ...COMPONENT_STATE_DIRECTORIES]) {
    const target = join(maibotRoot, name);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`MaiBot full reset target must not be a symbolic link: ${target}`);
    }
    addTarget(targets, maibotRoot, name, `MaiBot ${name}`);
  }
  return targets;
}

function addTarget(
  targets: Array<{ path: string; label: string }>,
  root: string,
  relativePath: string,
  label: string,
): void {
  const target = join(root, relativePath);
  assertNotFilesystemRoot(target, label);
  assertInside(root, target, label);
  targets.push({ path: target, label });
}

async function addNapCatVersionTargets(
  targets: Array<{ path: string; label: string }>,
  napcatRoot: string,
): Promise<void> {
  const versionsRoot = join(napcatRoot, "versions");
  if (!existsSync(versionsRoot)) {
    return;
  }

  for (const entry of await readdir(versionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const versionNapCatRoot = join("versions", entry.name, "resources", "app", "napcat");
    for (const stateDirectory of COMPONENT_STATE_DIRECTORIES) {
      addTarget(
        targets,
        napcatRoot,
        join(versionNapCatRoot, stateDirectory),
        `NapCat ${entry.name} ${stateDirectory}`,
      );
    }
  }
}

async function addAdapterConfigTargets(
  targets: Array<{ path: string; label: string }>,
  maibotRoot: string,
  adapterDirectory: string,
  label: string,
): Promise<void> {
  const adapterRoot = join(maibotRoot, "plugins", adapterDirectory);
  addTarget(targets, maibotRoot, join("plugins", adapterDirectory, "config.toml"), `${label} config.toml`);
  addTarget(targets, maibotRoot, join("plugins", adapterDirectory, "config.toml.back"), `${label} config.toml.back`);
  addTarget(targets, maibotRoot, join("plugins", adapterDirectory, "config.toml.backup"), `${label} config.toml.backup`);
  addTarget(targets, maibotRoot, join("plugins", adapterDirectory, "config_back"), `${label} config backups`);

  if (!existsSync(adapterRoot)) {
    return;
  }

  for (const entry of await readdir(adapterRoot, { withFileTypes: true })) {
    if (entry.isFile() && /^config\.toml\.backup\./iu.test(entry.name)) {
      addTarget(
        targets,
        maibotRoot,
        join("plugins", adapterDirectory, entry.name),
        `${label} ${entry.name}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const full = process.argv.includes("--full");
  const installRoot = resolve(process.cwd());
  const installScope = createInstallScope(installRoot);
  const userDataRoot = join(appDataRoot(), "MaiBotOneKeyDesktop", installScope);
  const storedComponentRoots = readStoredComponentRoots(userDataRoot);
  const defaultMaiBotRoot = join(installRoot, "modules", "MaiBot");
  const defaultNapcatRoot = join(installRoot, "modules", "napcat");
  const defaultSnowlumaRoot = join(installRoot, "modules", "SnowLuma");
  const maibotRoot = storedComponentRoots.maibot ?? defaultMaiBotRoot;
  const napcatRoot = storedComponentRoots.napcat ?? defaultNapcatRoot;
  const snowlumaRoot = storedComponentRoots.snowluma ?? defaultSnowlumaRoot;
  const maibotConfigDir = join(maibotRoot, "config");
  const maibotDataDir = join(maibotRoot, "data");

  assertNotFilesystemRoot(userDataRoot, "Launcher userData");
  assertNotFilesystemRoot(maibotConfigDir, "MaiBot config");
  assertNotFilesystemRoot(maibotDataDir, "MaiBot data");
  assertInside(join(appDataRoot(), "MaiBotOneKeyDesktop"), userDataRoot, "Launcher userData");
  assertLooksLikeMaiBotRoot(maibotRoot, defaultMaiBotRoot);
  assertInside(maibotRoot, maibotConfigDir, "MaiBot config");
  assertInside(maibotRoot, maibotDataDir, "MaiBot data");

  const targets: Array<{ path: string; label: string }> = [
    { path: userDataRoot, label: "Launcher userData" },
    { path: maibotConfigDir, label: "MaiBot config" },
    { path: maibotDataDir, label: "MaiBot data" },
  ];
  if (full) {
    // Resetting launcher settings selects the default instance next time, even
    // when the current instance was customized. Neither may retain an install.
    for (const root of new Set([maibotRoot, defaultMaiBotRoot])) {
      assertLooksLikeMaiBotRoot(root, defaultMaiBotRoot);
      targets.push(...fullResetTargets(root));
    }
  }
  assertNotFilesystemRoot(napcatRoot, "NapCat root");
  assertNotFilesystemRoot(snowlumaRoot, "SnowLuma root");

  for (const stateDirectory of COMPONENT_STATE_DIRECTORIES) {
    addTarget(targets, napcatRoot, stateDirectory, `NapCat ${stateDirectory}`);
    addTarget(targets, napcatRoot, join("napcat", stateDirectory), `NapCat runtime ${stateDirectory}`);
    addTarget(targets, snowlumaRoot, stateDirectory, `SnowLuma ${stateDirectory}`);
  }
  await addNapCatVersionTargets(targets, napcatRoot);
  await addAdapterConfigTargets(targets, maibotRoot, "qq_official_adapter", "QQ 官方适配器");
  await addAdapterConfigTargets(targets, maibotRoot, "snowluma-adapter", "SnowLuma 适配器");

  if (platform() === "darwin") {
    const qqContainer = process.env.NAPCAT_QQ_CONTAINER?.trim()
      ? resolve(process.env.NAPCAT_QQ_CONTAINER.trim())
      : join(homedir(), "Library", "Containers", "com.tencent.qq", "Data");
    addTarget(
      targets,
      qqContainer,
      join("Documents", "napcat", "config"),
      "NapCat QQ runtime config",
    );
  }

  const uniqueTargets = [...new Map(targets.map((target) => [resolve(target.path), target])).values()];
  console.log(`[reset-dev-state] ${full ? "Full reset" : "State reset"} targets:`);
  for (const target of uniqueTargets) {
    console.log(`  ${target.label}: ${target.path}`);
  }

  for (const target of uniqueTargets) {
    await removePath(target.path, target.label, dryRun);
  }

  if (!dryRun) {
    await mkdir(dirname(userDataRoot), { recursive: true });
  }

  console.log(dryRun ? "[reset-dev-state] Dry run complete." : "[reset-dev-state] Done.");
}

if (import.meta.main) main().catch((error) => {
  console.error("[reset-dev-state] Failed:", error);
  process.exitCode = 1;
});
