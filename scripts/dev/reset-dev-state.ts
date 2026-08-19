import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { homedir, platform } from "node:os";

const RESOURCE_PATHS_FILE = "resource-paths.json";
const LEGACY_RESOURCE_LOCATION_FILE = "resource-location.json";

interface StoredResourcePathsFile {
  version: 1;
  paths?: {
    maibot?: string;
    napcat?: string;
    snowluma?: string;
  };
}

interface LegacyStoredResourceLocationFile {
  version: 1;
  resourceRoot?: string;
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

function normalizePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : undefined;
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    console.warn(`[reset-dev-state] Failed to read ${path}:`, error);
    return undefined;
  }
}

function readStoredMaiBotRoot(userDataRoot: string): string | undefined {
  const resourcePaths = readJsonFile<StoredResourcePathsFile>(join(userDataRoot, RESOURCE_PATHS_FILE));
  const maibotRoot = normalizePath(resourcePaths?.paths?.maibot);
  if (maibotRoot) {
    return maibotRoot;
  }

  const legacyLocation = readJsonFile<LegacyStoredResourceLocationFile>(
    join(userDataRoot, LEGACY_RESOURCE_LOCATION_FILE),
  );
  const resourceRoot = normalizePath(legacyLocation?.resourceRoot);
  return resourceRoot ? join(resourceRoot, "modules", "MaiBot") : undefined;
}

interface StoredComponentRoots {
  maibot?: string;
  napcat?: string;
  snowluma?: string;
}

function readStoredComponentRoots(userDataRoot: string): StoredComponentRoots {
  const resourcePaths = readJsonFile<StoredResourcePathsFile>(join(userDataRoot, RESOURCE_PATHS_FILE));
  const stored: StoredComponentRoots = {
    maibot: normalizePath(resourcePaths?.paths?.maibot),
    napcat: normalizePath(resourcePaths?.paths?.napcat),
    snowluma: normalizePath(resourcePaths?.paths?.snowluma),
  };

  const legacyLocation = readJsonFile<LegacyStoredResourceLocationFile>(
    join(userDataRoot, LEGACY_RESOURCE_LOCATION_FILE),
  );
  const resourceRoot = normalizePath(legacyLocation?.resourceRoot);
  if (resourceRoot) {
    stored.maibot ??= join(resourceRoot, "modules", "MaiBot");
    stored.napcat ??= join(resourceRoot, "modules", "napcat");
    stored.snowluma ??= join(resourceRoot, "modules", "SnowLuma");
  }

  return stored;
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

function assertLooksLikeMaiBotRoot(maibotRoot: string): void {
  const markers = [join(maibotRoot, "bot.py"), join(maibotRoot, "src"), join(maibotRoot, "dashboard")];
  if (!markers.every((marker) => existsSync(marker))) {
    throw new Error(`MaiBot root does not look valid: ${maibotRoot}`);
  }
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
  const installRoot = resolve(process.cwd());
  const installScope = createInstallScope(installRoot);
  const userDataRoot = join(appDataRoot(), "MaiBotOneKeyDesktop", installScope);
  const storedComponentRoots = readStoredComponentRoots(userDataRoot);
  const defaultMaiBotRoot = join(installRoot, "modules", "MaiBot");
  const defaultNapcatRoot = join(installRoot, "modules", "napcat");
  const defaultSnowlumaRoot = join(installRoot, "modules", "SnowLuma");
  const maibotRoot = storedComponentRoots.maibot ?? readStoredMaiBotRoot(userDataRoot) ?? defaultMaiBotRoot;
  const napcatRoot = storedComponentRoots.napcat ?? defaultNapcatRoot;
  const snowlumaRoot = storedComponentRoots.snowluma ?? defaultSnowlumaRoot;
  const maibotConfigDir = join(maibotRoot, "config");
  const maibotDataDir = join(maibotRoot, "data");

  assertNotFilesystemRoot(userDataRoot, "Launcher userData");
  assertNotFilesystemRoot(maibotConfigDir, "MaiBot config");
  assertNotFilesystemRoot(maibotDataDir, "MaiBot data");
  assertInside(join(appDataRoot(), "MaiBotOneKeyDesktop"), userDataRoot, "Launcher userData");
  assertLooksLikeMaiBotRoot(maibotRoot);
  assertInside(maibotRoot, maibotConfigDir, "MaiBot config");
  assertInside(maibotRoot, maibotDataDir, "MaiBot data");

  const targets: Array<{ path: string; label: string }> = [
    { path: userDataRoot, label: "Launcher userData" },
    { path: maibotConfigDir, label: "MaiBot config" },
    { path: maibotDataDir, label: "MaiBot data" },
  ];
  assertNotFilesystemRoot(napcatRoot, "NapCat root");
  assertNotFilesystemRoot(snowlumaRoot, "SnowLuma root");

  for (const stateDirectory of COMPONENT_STATE_DIRECTORIES) {
    addTarget(targets, napcatRoot, stateDirectory, `NapCat ${stateDirectory}`);
    addTarget(targets, napcatRoot, join("napcat", stateDirectory), `NapCat runtime ${stateDirectory}`);
    addTarget(targets, snowlumaRoot, stateDirectory, `SnowLuma ${stateDirectory}`);
  }
  await addNapCatVersionTargets(targets, napcatRoot);
  await addAdapterConfigTargets(targets, maibotRoot, "napcat-adapter", "NapCat 适配器");
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

  console.log("[reset-dev-state] Targets:");
  for (const target of targets) {
    console.log(`  ${target.label}: ${target.path}`);
  }

  for (const target of targets) {
    await removePath(target.path, target.label, dryRun);
  }

  if (!dryRun) {
    await mkdir(dirname(userDataRoot), { recursive: true });
  }

  console.log(dryRun ? "[reset-dev-state] Dry run complete." : "[reset-dev-state] Done.");
}

main().catch((error) => {
  console.error("[reset-dev-state] Failed:", error);
  process.exitCode = 1;
});
