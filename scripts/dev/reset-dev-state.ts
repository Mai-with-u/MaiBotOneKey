import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { homedir, platform } from "node:os";

const RESOURCE_PATHS_FILE = "resource-paths.json";
const LEGACY_RESOURCE_LOCATION_FILE = "resource-location.json";

interface StoredResourcePathsFile {
  version: 1;
  paths?: {
    maibot?: string;
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

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const installRoot = resolve(process.cwd());
  const installScope = createInstallScope(installRoot);
  const userDataRoot = join(appDataRoot(), "MaiBotOneKeyDesktop", installScope);
  const defaultMaiBotRoot = join(installRoot, "modules", "MaiBot");
  const maibotRoot = readStoredMaiBotRoot(userDataRoot) ?? defaultMaiBotRoot;
  const maibotConfigDir = join(maibotRoot, "config");
  const maibotDataDir = join(maibotRoot, "data");

  assertNotFilesystemRoot(userDataRoot, "Launcher userData");
  assertNotFilesystemRoot(maibotConfigDir, "MaiBot config");
  assertNotFilesystemRoot(maibotDataDir, "MaiBot data");
  assertInside(join(appDataRoot(), "MaiBotOneKeyDesktop"), userDataRoot, "Launcher userData");
  assertLooksLikeMaiBotRoot(maibotRoot);
  assertInside(maibotRoot, maibotConfigDir, "MaiBot config");
  assertInside(maibotRoot, maibotDataDir, "MaiBot data");

  console.log("[reset-dev-state] Targets:");
  console.log(`  Launcher userData: ${userDataRoot}`);
  console.log(`  MaiBot config:      ${maibotConfigDir}`);
  console.log(`  MaiBot data:        ${maibotDataDir}`);

  await removePath(userDataRoot, "Launcher userData", dryRun);
  await removePath(maibotConfigDir, "MaiBot config", dryRun);
  await removePath(maibotDataDir, "MaiBot data", dryRun);

  if (!dryRun) {
    await mkdir(dirname(userDataRoot), { recursive: true });
  }

  console.log(dryRun ? "[reset-dev-state] Dry run complete." : "[reset-dev-state] Done.");
}

main().catch((error) => {
  console.error("[reset-dev-state] Failed:", error);
  process.exitCode = 1;
});
