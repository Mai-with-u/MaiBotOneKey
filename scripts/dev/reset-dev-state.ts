import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { MAIBOT_DEPLOYMENT_FILE, readMaiBotDeployment } from "../../src/main/services/maibot-deployment-state";
import { DEV_MODE_ENV, DEV_SOURCE_ENV, STARTUP_AGREEMENT_FILE, developmentRuntimeProfile } from "../../src/main/services/service-startup-defaults";
import { resolveGitPath } from "../../src/main/services/git-runtime";
import { runProcess } from "../../src/main/services/runtime-file-utils";
import { acquireInstallInstanceLock } from "../../src/main/services/instance-lock";
import { isLockOwnerAlive } from "../../src/main/services/lock-owner";
import { assertSourceCheckout } from "./dev-launch-options";

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
const SOURCE_STATE_DIRECTORIES = [...COMPONENT_STATE_DIRECTORIES, "host", "bots"];

function assertUnlinked(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink() || relative(path, realpathSync(path))) {
      throw new Error(`源码重置目录不能指向其他位置：${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function resetSourceState(installRoot: string, settingsBase: string, dryRun: boolean, keepDeps = false): Promise<void> {
  const sourceRoot = join(installRoot, "modules", "MaiBot-source");
  assertUnlinked(sourceRoot);
  assertSourceCheckout(sourceRoot);
  const git = await resolveGitPath(join(installRoot, "runtime"));
  if (!git) throw new Error("未找到 Git，无法确认源码重置范围。");
  const gitRoot = await runProcess(git, ["rev-parse", "--show-toplevel"], sourceRoot);
  if (relative(sourceRoot, gitRoot)) throw new Error("MaiBot 源码目录必须是独立的 Git checkout。");
  const tracked = await runProcess(git, ["ls-files", "--", ...SOURCE_STATE_DIRECTORIES], sourceRoot);
  if (tracked) throw new Error(`源码重置范围内有 Git 跟踪的文件，已取消：\n${tracked}`);

  const profile = developmentRuntimeProfile(installRoot, false, { [DEV_MODE_ENV]: "source", [DEV_SOURCE_ENV]: sourceRoot });
  const userDataRoot = join(settingsBase, `${createInstallScope(installRoot)}${profile.settingsSuffix}`);
  const targets: Array<{ path: string; label: string }> = [];
  for (const name of SOURCE_STATE_DIRECTORIES) addTarget(targets, sourceRoot, name, `MaiBot 源码实例 ${name}`);
  if (!keepDeps) addTarget(targets, profile.resourceRoot!, "python-env", "MaiBot 源码实例 Python 环境");
  addTarget(targets, userDataRoot, STARTUP_AGREEMENT_FILE, "源码实例协议确认记录");
  for (const path of [profile.resourceRoot!, userDataRoot, ...targets.map((target) => target.path)]) assertUnlinked(path);

  const lock = dryRun ? undefined : acquireInstallInstanceLock({ installRoot, userDataRoot });
  if (lock && !lock.acquired) throw new Error("请先停止 MaiBot 并退出源码开发窗口，再重置。");
  try {
    if (!dryRun && isLockOwnerAlive(readJsonFile(join(sourceRoot, "resource.lock")))) {
      throw new Error("MaiBot 源码目录正在使用，请先停止服务并退出一键包。");
    }
    for (const target of targets) await removePath(target.path, target.label, dryRun);
  } finally {
    lock?.release();
  }
}

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
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("bun run dev:reset [--full | --source [--keep-deps]] [--dry-run]");
    return;
  }
  if (args.some((arg) => !["--full", "--source", "--keep-deps", "--dry-run"].includes(arg))) throw new Error(`未知重置参数：${args.join(" ")}`);
  const dryRun = args.includes("--dry-run");
  const full = args.includes("--full");
  const keepDeps = args.includes("--keep-deps");
  if (args.includes("--source")) {
    if (full) throw new Error("--source 和 --full 不能混用。");
    await resetSourceState(realpathSync(process.cwd()), join(appDataRoot(), "MaiBotOneKeyDesktop"), dryRun, keepDeps);
    return;
  }
  if (keepDeps) throw new Error("--keep-deps 需与 --source 一起使用。普通 dev:reset 已保留 PyPI 安装环境。");
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
