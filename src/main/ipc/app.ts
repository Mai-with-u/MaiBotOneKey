import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CloseAction,
  AppIconId,
  AppIconSettings,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
  LauncherUpdateApplyResult,
  LauncherUpdateInfo,
  LauncherResetResult,
  LogEntry,
  Live2dModelImportResult,
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatMessageEvent,
  LocalChatSendRequest,
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  MaiBotInstalledPlugin,
  MaiBotPluginBlueprint,
  MaiBotPluginBlueprintCreateRequest,
  MaiBotPluginBlueprintCreateResult,
  MaiBotPluginBlueprintParseResult,
  MaiBotPluginBuilderBlueprintExportRequest,
  MaiBotPluginBuilderBlueprintExportResult,
  MaiBotPluginBuilderBlueprintImportResult,
  MaiBotPluginBuilderLibraryDeleteResult,
  MaiBotPluginBuilderLibraryListResult,
  MaiBotPluginBuilderLibraryLoadResult,
  MaiBotPluginBuilderLibrarySaveRequest,
  MaiBotPluginBuilderLibrarySaveResult,
  MaiBotPluginConfigSaveResult,
  MaiBotPluginConfigState,
  MaiBotPluginConfigValue,
  MaiBotPluginListOptions,
  MaiBotPluginListResult,
  MaiBotPluginDownloadResult,
  MaiBotPluginOperationRequest,
  MaiBotPluginOperationResult,
  MaiBotPluginRatingResult,
  MaiBotPluginReadmeResult,
  MaiBotPluginStats,
  MaiBotPluginUserState,
  MaiBotPluginUserStates,
  MaiBotPluginVoteResult,
  MaiBotStatisticSummary,
  ManagedPythonPackageName,
  ModuleBranchOption,
  ModuleRuntimeVersions,
  ModuleUpdateResult,
  NetworkProxySettings,
  OpenCodeSettings,
  ModuleSourceConfig,
  ModuleSourceUpdate,
  ModuleTagOption,
  ModuleUpdateTarget,
  PythonOverridesState,
  PythonPackageSourcePreset,
  PythonRuntimeCandidate,
  PythonPackageInstallRequest,
  PythonPackageInstallResult,
  PythonPackageVersionList,
  QqBackend,
  QqAccountSetupRequest,
  RuntimePaths,
  RuntimePathConfig,
  RuntimePathKey,
  RuntimePathUpdate,
  RuntimeResourcePathChangeResult,
  RuntimeResourcePathKey,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceId,
  SnowLumaResetResult,
  StartupAgreementConfirmResult,
  StartupAgreementState,
  TerminalSettings,
  WindowResizeEdge,
  WindowState,
} from "../../shared/contracts";
import {
  buildMaiBotPluginBlueprintFiles,
  defaultMaiBotPluginFolderName,
  validateMaiBotPluginBlueprint,
} from "../../shared/plugin-blueprint";
import { InitManager } from "../services/init-manager";
import type { AppIconManager } from "../services/app-icon-manager";
import { LogStore } from "../services/log-store";
import { LocalChatAdapter } from "../services/local-chat-adapter";
import { MaiBotPluginClient } from "../services/maibot-plugin-client";
import { ModuleUpdater } from "../services/module-updater";
import { NetworkProxyManager } from "../services/network-proxy-manager";
import { OpenCodeSettingsManager } from "../services/opencode-settings-manager";
import { PluginBuilderLibrary } from "../services/plugin-builder-library";
import { PythonDependencyManager } from "../services/python-dependency-manager";
import { ResourceLocationManager } from "../services/resource-location-manager";
import { ServiceManager } from "../services/service-manager";
import { getWindowWorkAreaBounds, isWindowVisuallyMaximized } from "../window-state";

const LAUNCHER_SETTING_FILES = [
  "resource-paths.json",
  "resource-location.json",
  "service-commands.json",
  "runtime-paths.json",
  "terminal-settings.json",
  "qq-backend.json",
  "message-platform.json",
  "module-sources.json",
  "python-dependency-source.json",
  "network-proxy.json",
  "opencode-settings.json",
  "app-icon-settings.json",
];
const LAUNCHER_RUNTIME_DIRECTORIES = ["modules", "python-overrides", "live2d", "logs"];
const RETIRED_ENTRY_DIRECTORY = ".reset-pending-delete";
const REMOVE_RETRY_OPTIONS = { recursive: true, force: true, maxRetries: 8, retryDelay: 250 } as const;
const NORMAL_MINIMUM_SIZE = { width: 1080, height: 720 };
const NORMAL_DEFAULT_SIZE = { width: 1280, height: 820 };
const NORMAL_RESTORE_MARGIN = 48;
const FLOATING_BALL_SIZE = { width: 96, height: 96 };
const FLOATING_PANEL_SIZE = { width: 380, height: 520 };
const FLOATING_STRIP_SIZE = { width: 28, height: 112 };
const FLOATING_EDGE_SNAP_DISTANCE = 18;
const WINDOW_RESIZE_EDGES = new Set<WindowResizeEdge>([
  "top",
  "right",
  "bottom",
  "left",
  "top-left",
  "top-right",
  "bottom-right",
  "bottom-left",
]);
const ONEKEY_REPOSITORY_URL = "https://github.com/DrSmoothl/MaiBotOneKey.git";
const ONEKEY_TAGS_API_URL = "https://api.github.com/repos/DrSmoothl/MaiBotOneKey/tags?per_page=100";
const ONEKEY_LATEST_RELEASE_API_URL = "https://api.github.com/repos/DrSmoothl/MaiBotOneKey/releases/latest";
const ONEKEY_RELEASES_API_URL = "https://api.github.com/repos/DrSmoothl/MaiBotOneKey/releases?per_page=100";
const ONEKEY_RELEASE_SOURCE = "DrSmoothl/MaiBotOneKey";

interface GitHubReleaseAsset {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
}

interface GitHubReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  body?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  assets?: unknown;
}

interface LauncherUpdateInternalInfo extends LauncherUpdateInfo {
  downloadUrl?: string;
}

interface RegisterAppIpcOptions {
  paths: RuntimePaths;
  initManager: InitManager;
  moduleUpdater: ModuleUpdater;
  networkProxyManager: NetworkProxyManager;
  openCodeSettingsManager: OpenCodeSettingsManager;
  pythonDependencyManager: PythonDependencyManager;
  resourceLocationManager: ResourceLocationManager;
  serviceManager: ServiceManager;
  logStore: LogStore;
  appIconManager: AppIconManager;
  applyAppIcon: () => void;
  getMainWindow: () => BrowserWindow | null;
  requestQuit: () => void;
  showMainWindow: () => void;
}

interface WindowResizeState {
  edge: WindowResizeEdge;
  startScreenX: number;
  startScreenY: number;
  bounds: Electron.Rectangle;
}

export interface RegisteredAppIpcDisposables {
  localChatAdapter: LocalChatAdapter;
  dispose: () => void;
}

function readWindowState(
  window: BrowserWindow | null,
  isFloating = false,
  floatingEdgeSide: "left" | "right" | null = null,
  isShellMaximized = false,
): WindowState {
  if (!window || window.isDestroyed()) {
    return {
      isMaximized: false,
      isFullScreen: false,
      isFocused: false,
      isFloating,
      isFloatingCollapsed: Boolean(floatingEdgeSide),
      floatingEdge: floatingEdgeSide ?? undefined,
    };
  }

  return {
    isMaximized: isShellMaximized || isWindowVisuallyMaximized(window),
    isFullScreen: window.isFullScreen(),
    isFocused: window.isFocused(),
    isFloating,
    isFloatingCollapsed: Boolean(floatingEdgeSide),
    floatingEdge: floatingEdgeSide ?? undefined,
  };
}

function runProcess(file: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(`${stdout}${stderr}`.trim() || undefined);
      },
    );
  });
}

function isRuntimeBusy(service: ServiceDescriptor): boolean {
  return service.status === "starting" || service.status === "running" || service.status === "stopping";
}

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const diff = relative(resolvedParent, resolvedChild);
  return Boolean(diff) && diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isBusyFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

async function removePathWithRetry(path: string): Promise<void> {
  try {
    await rm(path, REMOVE_RETRY_OPTIONS);
    return;
  } catch (error) {
    if (!isBusyFsError(error)) {
      throw error;
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(500 + attempt * 500);
    try {
      await rm(path, REMOVE_RETRY_OPTIONS);
      return;
    } catch (error) {
      if (!isBusyFsError(error) || attempt === 4) {
        throw error;
      }
    }
  }
}

async function retireAndRemovePath(path: string, root: string): Promise<void> {
  try {
    await removePathWithRetry(path);
    return;
  } catch (error) {
    if (!isBusyFsError(error)) {
      throw error;
    }
  }

  const retiredRoot = join(root, RETIRED_ENTRY_DIRECTORY);
  await mkdir(retiredRoot, { recursive: true });
  const retiredPath = join(retiredRoot, `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  try {
    await rename(path, retiredPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  void removePathWithRetry(retiredPath).catch(() => undefined);
}

async function removeExistingPath(path: string): Promise<string[]> {
  if (!existsSync(path)) {
    return [];
  }
  await removePathWithRetry(path);
  return [path];
}

async function clearDirectoryContents(root: string, entryNames?: string[]): Promise<string[]> {
  if (!existsSync(root)) {
    await mkdir(root, { recursive: true });
    return [];
  }

  const entries = entryNames ?? (await readdir(root));
  const removedEntries = entries.map((entry) => join(root, entry));
  await Promise.all(removedEntries.map((entryPath) => retireAndRemovePath(entryPath, root)));
  await mkdir(root, { recursive: true });
  return removedEntries;
}

function isLive2dModelPath(path: string): boolean {
  const cleanPath = path.toLowerCase().split(/[?#]/u)[0];
  return cleanPath.endsWith(".model3.json") || cleanPath.endsWith(".model.json");
}

function sanitizeLive2dFolderName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  return sanitized || "live2d-model";
}

async function nextAvailableLive2dDirectory(root: string, preferredName: string): Promise<string> {
  const safeName = sanitizeLive2dFolderName(preferredName);
  for (let index = 0; index < 100; index += 1) {
    const candidate = join(root, index === 0 ? safeName : `${safeName}-${index + 1}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  return join(root, `${safeName}-${Date.now()}`);
}

function live2dAssetUrlFromPath(paths: RuntimePaths, modelPath: string): string {
  const root = resolve(paths.live2dRoot);
  const target = resolve(modelPath);
  if (!isPathInside(root, target)) {
    throw new Error("Live2D model must be inside the launcher Live2D library.");
  }

  const relativePath = relative(root, target);
  const encodedPath = relativePath.split(/[\\/]+/u).map(encodeURIComponent).join("/");
  return `maibot-live2d://assets/${encodedPath}`;
}

async function importLive2dModel(paths: RuntimePaths, sourcePath: string): Promise<Live2dModelImportResult> {
  const sourceModelPath = resolve(sourcePath);
  const sourceStat = await stat(sourceModelPath);
  if (!sourceStat.isFile()) {
    throw new Error("Please choose a Live2D model JSON file.");
  }
  if (!isLive2dModelPath(sourceModelPath)) {
    throw new Error("Please choose a .model3.json or .model.json model file.");
  }

  const libraryRoot = resolve(paths.live2dRoot);
  const sourceDir = dirname(sourceModelPath);
  await mkdir(libraryRoot, { recursive: true });

  let modelPath = sourceModelPath;
  let copied = false;
  if (!samePath(libraryRoot, sourceDir) && !isPathInside(libraryRoot, sourceModelPath)) {
    const targetDir = await nextAvailableLive2dDirectory(libraryRoot, basename(sourceDir) || basename(sourceModelPath));
    await cp(sourceDir, targetDir, {
      recursive: true,
      dereference: true,
      errorOnExist: false,
      force: true,
    });
    modelPath = resolve(targetDir, relative(sourceDir, sourceModelPath));
    copied = true;
  }

  return {
    sourcePath: sourceModelPath,
    modelPath,
    modelUrl: live2dAssetUrlFromPath(paths, modelPath),
    libraryRoot,
    copied,
  };
}

interface ParsedVersionTag {
  tag: string;
  parts: number[];
  prerelease: boolean;
}

async function readPyprojectVersion(path: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path, "utf8");
    return content.match(/^\s*version\s*=\s*["']([^"']+)["']/mu)?.[1];
  } catch {
    return undefined;
  }
}

function normalizePythonPackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

function normalizePythonVersion(version: string): number[] {
  const clean = version.trim().toLowerCase().replace(/^v/u, "").split(/[+-]/u, 1)[0];
  return clean.split(/[._-]/u).map((part) => {
    const value = part.match(/^\d+/u)?.[0];
    return value ? Number(value) : 0;
  });
}

function comparePythonVersions(left: string, right: string): number {
  const leftParts = normalizePythonVersion(left);
  const rightParts = normalizePythonVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.localeCompare(right, "en-US", { numeric: true, sensitivity: "base" });
}

async function readPythonDistInfoVersion(root: string, packageName: string): Promise<string | undefined> {
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const expectedName = normalizePythonPackageName(packageName);
    const versions: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) {
        continue;
      }
      const metadata = await readFile(join(root, entry.name, "METADATA"), "utf8").catch(() => undefined);
      if (!metadata) {
        continue;
      }
      const name = metadata.match(/^Name:\s*(.+)$/imu)?.[1]?.trim();
      if (!name || normalizePythonPackageName(name) !== expectedName) {
        continue;
      }
      const version = metadata.match(/^Version:\s*(.+)$/imu)?.[1]?.trim();
      if (version) {
        versions.push(version);
      }
    }
    return versions.sort(comparePythonVersions).at(-1);
  } catch {
    return undefined;
  }
}

function parseVersionTag(tag: string): ParsedVersionTag | undefined {
  const normalized = tag.replace(/^v/iu, "");
  const match = normalized.match(/^(\d+(?:\.\d+){0,3})(?:[-._]?([a-z]+)\.?(\d*)?)?$/iu);
  if (!match) {
    return undefined;
  }

  return {
    tag,
    parts: match[1].split(".").map((part) => Number(part)),
    prerelease: Boolean(match[2]),
  };
}

function compareParsedTags(left: ParsedVersionTag, right: ParsedVersionTag): number {
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index++) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.tag.localeCompare(right.tag, "en-US", { numeric: true, sensitivity: "base" });
}

function pickLatestTags(
  rawTags: string[],
): Pick<ModuleRuntimeVersions, "maibotLatestStableTag" | "maibotLatestPrereleaseTag"> {
  const parsed = rawTags.map(parseVersionTag).filter((tag): tag is ParsedVersionTag => Boolean(tag));
  const stable = parsed.filter((tag) => !tag.prerelease).sort(compareParsedTags).at(-1)?.tag;
  const prerelease = parsed.filter((tag) => tag.prerelease).sort(compareParsedTags).at(-1)?.tag;
  return {
    maibotLatestStableTag: stable,
    maibotLatestPrereleaseTag: prerelease,
  };
}

function pickLatestVersionTag(rawTags: string[]): string | undefined {
  return rawTags
    .map(parseVersionTag)
    .filter((tag): tag is ParsedVersionTag => Boolean(tag))
    .sort(compareParsedTags)
    .at(-1)?.tag;
}

function compareVersionTags(left: string | undefined, right: string | undefined): number {
  const parsedLeft = left ? parseVersionTag(left) : undefined;
  const parsedRight = right ? parseVersionTag(right) : undefined;
  if (parsedLeft && parsedRight) {
    return compareParsedTags(parsedLeft, parsedRight);
  }
  return (left ?? "").localeCompare(right ?? "", "en-US", { numeric: true, sensitivity: "base" });
}

function releaseTagToVersion(tag: string | undefined): string | undefined {
  return tag?.trim().replace(/^v/iu, "") || undefined;
}

function sanitizeDownloadFileName(value: string): string {
  const sanitized = basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  return sanitized || "MaiBot-OneKey-update.exe";
}

function selectLauncherUpdateAsset(rawAssets: unknown): GitHubReleaseAsset | undefined {
  const assets = Array.isArray(rawAssets) ? rawAssets.filter((item): item is GitHubReleaseAsset => {
    return Boolean(item && typeof item === "object");
  }) : [];
  const executableAssets = assets.filter((asset) => {
    const name = typeof asset.name === "string" ? asset.name.toLowerCase() : "";
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
    return name.endsWith(".exe") && !name.includes("uninstaller") && Boolean(url);
  });
  return executableAssets.find((asset) => String(asset.name ?? "").toLowerCase().includes("win"))
    ?? executableAssets[0];
}

async function fetchLauncherReleaseNotesInRange(currentTag: string, latestTag: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(ONEKEY_RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub Releases returned HTTP ${response.status}`);
    }

    const releases = (await response.json()) as unknown;
    if (!Array.isArray(releases)) {
      return undefined;
    }

    const notes = releases
      .filter((release): release is GitHubReleasePayload => {
        if (!release || typeof release !== "object") {
          return false;
        }
        const tag = release.tag_name;
        return (
          release.draft !== true
          && typeof tag === "string"
          && compareVersionTags(tag, currentTag) > 0
          && compareVersionTags(tag, latestTag) <= 0
        );
      })
      .sort((left, right) => compareVersionTags(String(right.tag_name), String(left.tag_name)))
      .map((release) => {
        const tag = String(release.tag_name);
        const title = typeof release.name === "string" && release.name.trim() ? release.name.trim() : tag;
        const body = typeof release.body === "string" && release.body.trim()
          ? release.body.trim()
          : "此版本没有填写更新说明。";
        return `## ${title}\n\n${body}`;
      });

    return notes.length > 1 ? notes.join("\n\n---\n\n") : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLauncherUpdateInfo(currentVersion: string): Promise<LauncherUpdateInternalInfo> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(ONEKEY_LATEST_RELEASE_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub Releases returned HTTP ${response.status}`);
    }

    const release = (await response.json()) as GitHubReleasePayload;
    if (release.draft === true || typeof release.tag_name !== "string") {
      throw new Error("Latest release metadata is incomplete");
    }

    const asset = selectLauncherUpdateAsset(release.assets);
    const latestTag = release.tag_name;
    const currentTag = `v${currentVersion}`;
    const available = compareVersionTags(latestTag, currentTag) > 0;
    const latestReleaseNotes = typeof release.body === "string" ? release.body : undefined;
    const releaseNotes = available
      ? await fetchLauncherReleaseNotesInRange(currentTag, latestTag).catch(() => latestReleaseNotes)
      : latestReleaseNotes;
    return {
      currentVersion,
      latestTag,
      latestVersion: releaseTagToVersion(latestTag),
      releaseName: typeof release.name === "string" ? release.name : latestTag,
      releaseUrl: typeof release.html_url === "string" ? release.html_url : "https://github.com/DrSmoothl/MaiBotOneKey/releases",
      releaseNotes,
      assetName: typeof asset?.name === "string" ? asset.name : undefined,
      assetSize: typeof asset?.size === "number" ? asset.size : undefined,
      available,
      checkedAt: Date.now(),
      source: ONEKEY_RELEASE_SOURCE,
      downloadUrl: typeof asset?.browser_download_url === "string" ? asset.browser_download_url : undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function publicLauncherUpdateInfo(update: LauncherUpdateInternalInfo): LauncherUpdateInfo {
  const { downloadUrl: _downloadUrl, ...publicUpdate } = update;
  return publicUpdate;
}

async function downloadLauncherUpdate(paths: RuntimePaths, update: LauncherUpdateInternalInfo): Promise<string> {
  if (!update.downloadUrl || !update.assetName) {
    throw new Error("最新版本没有可下载的 Windows 安装包");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(update.downloadUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`安装包下载失败: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (update.assetSize && buffer.length !== update.assetSize) {
      throw new Error(`安装包大小校验失败: ${buffer.length} / ${update.assetSize}`);
    }

    const updatesRoot = join(paths.userDataRoot, "updates");
    await mkdir(updatesRoot, { recursive: true });
    const installerPath = join(updatesRoot, sanitizeDownloadFileName(update.assetName));
    await writeFile(installerPath, buffer);
    return installerPath;
  } finally {
    clearTimeout(timeout);
  }
}

function parsePackageVersion(version: string): ParsedVersionTag | undefined {
  const normalized = version.replace(/^v/iu, "");
  const match = normalized.match(/^(\d+(?:\.\d+){0,3})(?:(?:[-._]?(?:dev|a|alpha|b|beta|rc|pre|preview))\d*)?/iu);
  if (!match) {
    return undefined;
  }

  return {
    tag: version,
    parts: match[1].split(".").map((part) => Number(part)),
    prerelease: /(?:^|[._+-])(?:dev|a|alpha|b|beta|rc|pre|preview)\d*/iu.test(version),
  };
}

async function fetchPypiVersionSummary(
  packageName: string,
): Promise<Pick<ModuleRuntimeVersions, "dashboardLatestPypi" | "dashboardLatestStablePypi" | "dashboardLatestPrereleasePypi">> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://pypi.org/pypi/${packageName}/json`, { signal: controller.signal });
    if (!response.ok) {
      return {};
    }
    const data = (await response.json()) as { info?: { version?: unknown }; releases?: Record<string, unknown> };
    const latestPypi = typeof data.info?.version === "string" ? data.info.version : undefined;
    const parsed = Object.keys(data.releases ?? {})
      .map(parsePackageVersion)
      .filter((version): version is ParsedVersionTag => Boolean(version));
    const stable = parsed.filter((version) => !version.prerelease).sort(compareParsedTags).at(-1)?.tag;
    const prerelease = parsed.filter((version) => version.prerelease).sort(compareParsedTags).at(-1)?.tag;
    return {
      dashboardLatestPypi: latestPypi ?? stable,
      dashboardLatestStablePypi: stable,
      dashboardLatestPrereleasePypi: prerelease,
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

function decodeStatisticText(content: string): string {
  return content
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6]|section|article)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&yen;/giu, "Yen")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\r\n?/gu, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readStatisticField(text: string, label: string): string | undefined {
  const inlineValue = text.match(new RegExp(`${escapeRegExp(label)}\\s*[:\\uFF1A]\\s*([^\\n]+)`, "u"))?.[1]?.trim();
  if (inlineValue) {
    return inlineValue;
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const labelIndex = lines.findIndex((line) => line === label);
  const nextLine = labelIndex >= 0 ? lines[labelIndex + 1] : undefined;
  return nextLine && !nextLine.endsWith(":") && !nextLine.endsWith("\uFF1A") ? nextLine : undefined;
}

function readStatisticCount(text: string, label: string): number | undefined {
  const raw = readStatisticField(text, label);
  const value = raw?.match(/[\d,]+/u)?.[0]?.replace(/,/gu, "");
  return value ? Number(value) : undefined;
}

function isStatisticStyleLine(line: string): boolean {
  return /^[a-z][\w-]*\s*:\s*[-\w.%#()'",\s]+$/iu.test(line);
}

function isChatStatisticHeading(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return (
    line.includes("\u804A\u5929\u6D88\u606F\u7EDF\u8BA1") ||
    /^(?:chat\s+)?message\s+statistics$/iu.test(normalized) ||
    /^chat\s+statistics$/iu.test(normalized)
  );
}

function isChatStatisticBoundary(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return (
    line.includes("\u7EDF\u8BA1\u65F6\u6BB5") ||
    line.includes("\u6309\u6A21\u578B\u5206\u7C7B\u7EDF\u8BA1") ||
    line.includes("\u6309\u6A21\u5757\u5206\u7C7B\u7EDF\u8BA1") ||
    line.includes("\u6309\u8BF7\u6C42\u7C7B\u578B\u5206\u7C7B\u7EDF\u8BA1") ||
    line.includes("\u6570\u636E\u5206\u5E03\u56FE\u8868") ||
    line.includes("\u6307\u6807\u8D8B\u52BF") ||
    /^(?:statistics\s+period|model\s+statistics|module\s+statistics|request\s+type\s+statistics|data\s+distribution|metrics\s+trend|charts?)$/iu.test(normalized)
  );
}

function parseChatStatistics(text: string): MaiBotStatisticSummary["chatStats"] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const startIndex = lines.findIndex(isChatStatisticHeading);
  if (startIndex < 0) {
    return [];
  }

  const stats: MaiBotStatisticSummary["chatStats"] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (isStatisticStyleLine(line)) {
      continue;
    }
    if (isChatStatisticBoundary(line)) {
      break;
    }
    if (line.startsWith("-") || line.includes("Token/") || line.toLowerCase().includes("cost")) {
      break;
    }
    if (
      line.includes("\u8054\u7CFB\u4EBA") ||
      line.includes("\u7FA4\u7EC4\u540D\u79F0") ||
      line.includes("\u6D88\u606F\u6570\u91CF") ||
      line.toLowerCase().includes("total") ||
      line.toLowerCase().includes("online") ||
      line.toLowerCase().includes("reply")
    ) {
      continue;
    }
    const match = line.match(/^(.+?)\s+(\d+)$/u);
    if (!match) {
      continue;
    }
    const name = match[1].trim();
    if (name.endsWith(":")) {
      continue;
    }
    stats.push({ name, messageCount: Number(match[2]) });
  }
  return stats;
}

async function readMaiBotStatistics(paths: RuntimePaths): Promise<MaiBotStatisticSummary> {
  const candidates = [
    join(paths.maibotRoot, "maibot_statistics.html"),
    join(paths.maibotRoot, "data", "maibot_statistics.html"),
    join(paths.maibotRoot, "logs", "maibot_statistics.html"),
  ];
  const sourcePath = candidates.find((path) => existsSync(path));
  if (!sourcePath) {
    return { available: false, updatedAt: Date.now(), chatStats: [] };
  }

  const [content, fileStat] = await Promise.all([readFile(sourcePath, "utf8"), stat(sourcePath)]);
  const text = decodeStatisticText(content);
  const periodLabel = text.match(/(\u6700\u8FD1[^\s(\uFF08]*\u7EDF\u8BA1\u6570\u636E|period[^\s(]*)/iu)?.[1];
  const startedAt = text.match(/(?:\u81EA\s*([^,\uFF0C)\uFF09]+)\u5F00\u59CB|started\s*[:\uFF1A]\s*([^\n]+))/iu)?.slice(1).find(Boolean)?.trim();

  return {
    available: true,
    updatedAt: fileStat.mtimeMs,
    sourcePath,
    periodLabel,
    startedAt,
    totalOnlineTime: readStatisticField(text, "\u603B\u5728\u7EBF\u65F6\u95F4"),
    totalMessages: readStatisticCount(text, "总消息数"),
    totalReplies: readStatisticCount(text, "总回复数"),
    totalRequests: readStatisticCount(text, "总请求数"),
    totalTokens: readStatisticCount(text, "Token"),
    totalCost: readStatisticField(text, "\u603B\u82B1\u8D39"),
    costPerMessage: readStatisticField(text, "花费/消息数量"),
    costPerReceivedMessage: readStatisticField(text, "\u82B1\u8D39/\u63A5\u53D7\u6D88\u606F\u6570\u91CF"),
    costPerReply: readStatisticField(text, "花费/回复数量"),
    costPerHour: readStatisticField(text, "\u82B1\u8D39/\u65F6\u95F4"),
    tokensPerHour: readStatisticField(text, "Token/\u65F6\u95F4"),
    chatStats: parseChatStatistics(text),
  };
}

export function registerAppIpc({
  paths,
  initManager,
  moduleUpdater,
  networkProxyManager,
  openCodeSettingsManager,
  pythonDependencyManager,
  resourceLocationManager,
  serviceManager,
  logStore,
  appIconManager,
  applyAppIcon,
  getMainWindow,
  requestQuit,
  showMainWindow,
}: RegisterAppIpcOptions): RegisteredAppIpcDisposables {
  let remoteModuleVersionsCache: ModuleRuntimeVersions = {};
  let remoteAppVersionCache: Pick<DesktopSnapshot, "appLatestTag" | "appLatestSource"> = {};
  let remoteModuleVersionsRefreshPromise: Promise<void> | null = null;
  let initDependencyRefreshPromise: Promise<void> | null = null;
  let floatingMode = false;
  let floatingPanelExpanded = false;
  let floatingEdgeSide: "left" | "right" | null = null;
  let normalBounds: Electron.Rectangle | null = null;
  let shellMaximized = false;
  let shellRestoreBounds: Electron.Rectangle | null = null;
  let resizeState: WindowResizeState | null = null;

  const readManagedWindowState = (window: BrowserWindow | null): WindowState =>
    readWindowState(window, floatingMode, floatingEdgeSide, shellMaximized);

  const sendWindowState = (window: BrowserWindow | null): WindowState => {
    const state = readManagedWindowState(window);
    window?.webContents.send("desktop:window-state", state);
    return state;
  };

  const clampFloatingBounds = (bounds: Electron.Rectangle): Electron.Rectangle => {
    const display = screen.getDisplayMatching(bounds);
    const workArea = display.workArea;
    return {
      x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width),
      y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height),
      width: bounds.width,
      height: bounds.height,
    };
  };

  const floatingBounds = (
    window: BrowserWindow,
    size: { width: number; height: number },
  ): Electron.Rectangle => {
    const display = screen.getDisplayMatching(window.getBounds());
    return {
      x: Math.round(display.workArea.x + display.workArea.width - size.width - 18),
      y: Math.round(display.workArea.y + display.workArea.height - size.height - 18),
      width: size.width,
      height: size.height,
    };
  };

  const activeFloatingSize = (): { width: number; height: number } =>
    floatingEdgeSide
      ? FLOATING_STRIP_SIZE
      : floatingPanelExpanded
        ? FLOATING_PANEL_SIZE
        : FLOATING_BALL_SIZE;

  const withActiveFloatingSize = (bounds: Electron.Rectangle): Electron.Rectangle => {
    const size = activeFloatingSize();
    return {
      x: bounds.x,
      y: bounds.y,
      width: size.width,
      height: size.height,
    };
  };

  const restoreNormalWindowChrome = (window: BrowserWindow): void => {
    window.setResizable(false);
    window.setMaximizable(true);
    window.setMinimumSize(NORMAL_MINIMUM_SIZE.width, NORMAL_MINIMUM_SIZE.height);
  };

  const clampNormalBounds = (bounds: Electron.Rectangle): Electron.Rectangle => {
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(Math.max(bounds.width, NORMAL_MINIMUM_SIZE.width), workArea.width);
    const height = Math.min(Math.max(bounds.height, NORMAL_MINIMUM_SIZE.height), workArea.height);
    return {
      x: Math.round(Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)),
      y: Math.round(Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)),
      width: Math.round(width),
      height: Math.round(height),
    };
  };

  const fallbackNormalBounds = (window: BrowserWindow): Electron.Rectangle => {
    const workArea = getWindowWorkAreaBounds(window);
    const width = Math.min(
      Math.max(NORMAL_MINIMUM_SIZE.width, Math.min(NORMAL_DEFAULT_SIZE.width, workArea.width - NORMAL_RESTORE_MARGIN * 2)),
      workArea.width,
    );
    const height = Math.min(
      Math.max(NORMAL_MINIMUM_SIZE.height, Math.min(NORMAL_DEFAULT_SIZE.height, workArea.height - NORMAL_RESTORE_MARGIN * 2)),
      workArea.height,
    );
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width: Math.round(width),
      height: Math.round(height),
    };
  };

  const isShellWindowMaximized = (window: BrowserWindow): boolean =>
    shellMaximized || isWindowVisuallyMaximized(window);

  const rememberShellRestoreBounds = (window: BrowserWindow): void => {
    if (!isShellWindowMaximized(window)) {
      shellRestoreBounds = clampNormalBounds(window.getBounds());
    }
  };

  const getShellRestoreBounds = (window: BrowserWindow): Electron.Rectangle => {
    if (shellRestoreBounds) {
      return clampNormalBounds(shellRestoreBounds);
    }
    if (window.isMaximized()) {
      return clampNormalBounds(window.getNormalBounds());
    }
    return fallbackNormalBounds(window);
  };

  const maximizeShellWindow = (window: BrowserWindow): WindowState => {
    resizeState = null;
    rememberShellRestoreBounds(window);
    restoreNormalWindowChrome(window);
    shellMaximized = true;
    window.setBounds(getWindowWorkAreaBounds(window), true);
    window.show();
    return sendWindowState(window);
  };

  const restoreShellWindow = (window: BrowserWindow): WindowState => {
    resizeState = null;
    const restoreBounds = getShellRestoreBounds(window);
    shellMaximized = false;
    shellRestoreBounds = null;
    if (window.isMaximized()) {
      window.unmaximize();
    }
    restoreNormalWindowChrome(window);
    window.setBounds(restoreBounds, true);
    window.show();
    return sendWindowState(window);
  };

  const startWindowResize = (
    edge: WindowResizeEdge,
    screenX: number,
    screenY: number,
  ): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readManagedWindowState(window);
    }
    if (floatingMode || isShellWindowMaximized(window) || window.isFullScreen() || !WINDOW_RESIZE_EDGES.has(edge)) {
      return sendWindowState(window);
    }

    restoreNormalWindowChrome(window);
    resizeState = {
      edge,
      startScreenX: Math.round(screenX),
      startScreenY: Math.round(screenY),
      bounds: window.getBounds(),
    };
    return sendWindowState(window);
  };

  const resizeWindowTo = (screenX: number, screenY: number): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      resizeState = null;
      return readManagedWindowState(window);
    }
    if (!resizeState || floatingMode || isShellWindowMaximized(window) || window.isFullScreen()) {
      return sendWindowState(window);
    }

    const deltaX = Math.round(screenX) - resizeState.startScreenX;
    const deltaY = Math.round(screenY) - resizeState.startScreenY;
    const { edge, bounds } = resizeState;
    const minWidth = NORMAL_MINIMUM_SIZE.width;
    const minHeight = NORMAL_MINIMUM_SIZE.height;
    let x = bounds.x;
    let y = bounds.y;
    let width = bounds.width;
    let height = bounds.height;

    if (edge === "right" || edge.endsWith("-right")) {
      width = Math.max(minWidth, bounds.width + deltaX);
    }
    if (edge === "left" || edge.endsWith("-left")) {
      width = Math.max(minWidth, bounds.width - deltaX);
      x = bounds.x + bounds.width - width;
    }
    if (edge === "bottom" || edge.startsWith("bottom-")) {
      height = Math.max(minHeight, bounds.height + deltaY);
    }
    if (edge === "top" || edge.startsWith("top-")) {
      height = Math.max(minHeight, bounds.height - deltaY);
      y = bounds.y + bounds.height - height;
    }

    window.setBounds({ x, y, width, height }, false);
    return sendWindowState(window);
  };

  const finishWindowResize = (): WindowState => {
    resizeState = null;
    return sendWindowState(getMainWindow());
  };

  const applyFloatingMode = (enabled: boolean): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readManagedWindowState(window);
    }

    if (enabled && !floatingMode) {
      resizeState = null;
      normalBounds = isShellWindowMaximized(window)
        ? getShellRestoreBounds(window)
        : window.getBounds();
      shellMaximized = false;
      shellRestoreBounds = null;
      if (window.isMaximized()) {
        window.unmaximize();
      }
      floatingMode = true;
      floatingPanelExpanded = false;
      floatingEdgeSide = null;
      window.setMinimumSize(1, 1);
      window.setResizable(false);
      window.setAlwaysOnTop(true, "floating");
      window.setBounds(floatingBounds(window, FLOATING_BALL_SIZE), true);
      window.show();
      window.focus();
      return sendWindowState(window);
    }

    if (!enabled) {
      resizeState = null;
      const shouldRestoreBounds = floatingMode;
      floatingMode = false;
      floatingPanelExpanded = false;
      floatingEdgeSide = null;
      window.setAlwaysOnTop(false);
      restoreNormalWindowChrome(window);
      if (shouldRestoreBounds) {
        window.setBounds(normalBounds ?? { x: 80, y: 80, width: 1280, height: 820 }, true);
      }
      normalBounds = null;
      window.show();
      window.focus();
      return sendWindowState(window);
    }

    return sendWindowState(window);
  };

  const applyFloatingPanelExpanded = (expanded: boolean): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readManagedWindowState(window);
    }
    if (!floatingMode) {
      return sendWindowState(window);
    }
    if (floatingPanelExpanded === expanded && (expanded || !floatingEdgeSide)) {
      return sendWindowState(window);
    }
    floatingPanelExpanded = expanded;
    floatingEdgeSide = null;
    const currentBounds = window.getBounds();
    const nextSize = expanded ? FLOATING_PANEL_SIZE : FLOATING_BALL_SIZE;
    window.setBounds(
      clampFloatingBounds({
        x: currentBounds.x,
        y: currentBounds.y,
        width: nextSize.width,
        height: nextSize.height,
      }),
      true,
    );
    return sendWindowState(window);
  };

  const moveFloatingBy = (deltaX: number, deltaY: number): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readManagedWindowState(window);
    }
    if (!floatingMode) {
      return sendWindowState(window);
    }

    const currentBounds = window.getBounds();
    if (floatingEdgeSide) {
      const previousEdgeSide = floatingEdgeSide;
      floatingEdgeSide = null;
      const undockedBounds = {
        x: previousEdgeSide === "left" ? currentBounds.x : currentBounds.x + currentBounds.width - FLOATING_BALL_SIZE.width,
        y: currentBounds.y,
        width: FLOATING_BALL_SIZE.width,
        height: FLOATING_BALL_SIZE.height,
      };
      window.setBounds(clampFloatingBounds(undockedBounds), false);
    }

    const bounds = window.getBounds();
    window.setBounds(
      clampFloatingBounds({
        x: bounds.x + Math.round(deltaX),
        y: bounds.y + Math.round(deltaY),
        width: activeFloatingSize().width,
        height: activeFloatingSize().height,
      }),
      false,
    );
    return sendWindowState(window);
  };

  const moveFloatingTo = (offsetX: number, offsetY: number): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readManagedWindowState(window);
    }
    if (!floatingMode) {
      return sendWindowState(window);
    }

    const wasEdgeDocked = Boolean(floatingEdgeSide);
    if (floatingEdgeSide) {
      floatingEdgeSide = null;
      const currentBounds = window.getBounds();
      const nextSize = floatingPanelExpanded ? FLOATING_PANEL_SIZE : FLOATING_BALL_SIZE;
      window.setBounds(
        clampFloatingBounds({
          x: currentBounds.x,
          y: currentBounds.y,
          width: nextSize.width,
          height: nextSize.height,
        }),
        false,
      );
    }

    const size = activeFloatingSize();
    const cursorPoint = screen.getCursorScreenPoint();
    const safeOffsetX = wasEdgeDocked && !floatingPanelExpanded
      ? Math.round(FLOATING_BALL_SIZE.width / 2)
      : Math.min(Math.max(Math.round(offsetX), 0), size.width);
    const safeOffsetY = wasEdgeDocked && !floatingPanelExpanded
      ? Math.round(FLOATING_BALL_SIZE.height / 2)
      : Math.min(Math.max(Math.round(offsetY), 0), size.height);
    window.setBounds(
      clampFloatingBounds({
        x: Math.round(cursorPoint.x) - safeOffsetX,
        y: Math.round(cursorPoint.y) - safeOffsetY,
        width: size.width,
        height: size.height,
      }),
      false,
    );
    return sendWindowState(window);
  };

  const finishFloatingDrag = (): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readManagedWindowState(window);
    }
    if (!floatingMode) {
      return sendWindowState(window);
    }

    const currentBounds = withActiveFloatingSize(window.getBounds());
    const display = screen.getDisplayMatching(currentBounds);
    const workArea = display.workArea;
    const isNearLeft = currentBounds.x <= workArea.x + FLOATING_EDGE_SNAP_DISTANCE;
    const isNearRight =
      currentBounds.x + currentBounds.width >= workArea.x + workArea.width - FLOATING_EDGE_SNAP_DISTANCE;

    if (!floatingPanelExpanded && (isNearLeft || isNearRight)) {
      floatingEdgeSide = isNearLeft ? "left" : "right";
      const x = floatingEdgeSide === "left"
        ? workArea.x
        : workArea.x + workArea.width - FLOATING_STRIP_SIZE.width;
      window.setBounds(
        clampFloatingBounds({
          x,
          y: currentBounds.y,
          width: FLOATING_STRIP_SIZE.width,
          height: FLOATING_STRIP_SIZE.height,
        }),
        true,
      );
      return sendWindowState(window);
    }

    floatingEdgeSide = null;
    window.setBounds(clampFloatingBounds(withActiveFloatingSize(currentBounds)), true);
    return sendWindowState(window);
  };

  const readLocalModuleVersions = async (): Promise<ModuleRuntimeVersions> => {
    const versions: ModuleRuntimeVersions = {};
    const maibotRoot = paths.maibotRoot;

    const pyprojectVersion = await readPyprojectVersion(join(maibotRoot, "pyproject.toml"));
    if (pyprojectVersion) {
      versions.maibotLocal = pyprojectVersion;
      versions.maibotLocalSource = "pyproject";
    }

    const dashboardVersion = await readPythonDistInfoVersion(
      pythonDependencyManager.getOverridesRoot(),
      "maibot-dashboard",
    );
    if (dashboardVersion) {
      versions.dashboardOverride = dashboardVersion;
      versions.dashboardOverrideSource = "python-overrides";
    }

    return versions;
  };

  const readRemoteModuleVersions = async (): Promise<ModuleRuntimeVersions> => {
    const versions: ModuleRuntimeVersions = {};
    const gitPath = initManager.getGitPath();
    const sourceConfig = await moduleUpdater.getSourceConfig().catch(() => undefined);
    const tagRemoteUrls = [sourceConfig?.maibotUrl, "https://github.com/Mai-with-u/MaiBot.git"].filter(
      (url, index, urls): url is string => Boolean(url && urls.indexOf(url) === index),
    );
    if (existsSync(gitPath)) {
      for (const remoteUrl of tagRemoteUrls) {
        const tagsOutput = await runProcess(gitPath, ["ls-remote", "--tags", remoteUrl], paths.installRoot);
        if (!tagsOutput) {
          continue;
        }
        const tags = tagsOutput
          .split(/\r?\n/u)
          .map((line) => line.match(/refs\/tags\/(.+?)(?:\^\{\})?$/u)?.[1])
          .filter((tag): tag is string => Boolean(tag));
        Object.assign(versions, pickLatestTags(Array.from(new Set(tags))));
        versions.maibotRemoteSource = remoteUrl;
        break;
      }
    }

    const dashboardVersions = await fetchPypiVersionSummary("maibot-dashboard");
    if (
      dashboardVersions.dashboardLatestPypi
      || dashboardVersions.dashboardLatestStablePypi
      || dashboardVersions.dashboardLatestPrereleasePypi
    ) {
      Object.assign(versions, dashboardVersions);
      versions.dashboardPypiSource = "PyPI";
    }

    return versions;
  };

  const readRemoteAppVersion = async (): Promise<Pick<DesktopSnapshot, "appLatestTag" | "appLatestSource">> => {
    const gitPath = initManager.getGitPath();
    if (existsSync(gitPath)) {
      const tagsOutput = await runProcess(
        gitPath,
        ["ls-remote", "--tags", "--refs", ONEKEY_REPOSITORY_URL],
        paths.installRoot,
      );
      const tags = tagsOutput
        ?.split(/\r?\n/u)
        .map((line) => line.match(/refs\/tags\/(.+)$/u)?.[1])
        .filter((tag): tag is string => Boolean(tag)) ?? [];
      const latestTag = pickLatestVersionTag(Array.from(new Set(tags)));
      if (latestTag) {
        return {
          appLatestTag: latestTag,
          appLatestSource: ONEKEY_RELEASE_SOURCE,
        };
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(ONEKEY_TAGS_API_URL, { signal: controller.signal });
      if (!response.ok) {
        return {};
      }
      const data = (await response.json()) as Array<{ name?: unknown }>;
      const latestTag = pickLatestVersionTag(
        data.map((tag) => typeof tag.name === "string" ? tag.name : "").filter(Boolean),
      );
      return latestTag
        ? {
            appLatestTag: latestTag,
            appLatestSource: ONEKEY_RELEASE_SOURCE,
          }
        : {};
    } catch {
      return {};
    } finally {
      clearTimeout(timeout);
    }
  };

  const readModuleVersions = async (): Promise<ModuleRuntimeVersions> => ({
    ...remoteModuleVersionsCache,
    ...(await readLocalModuleVersions()),
  });

  const checkLauncherUpdate = async (): Promise<LauncherUpdateInternalInfo> => {
    const update = await fetchLauncherUpdateInfo(app.getVersion());
    remoteAppVersionCache = update.latestTag
      ? {
          appLatestTag: update.latestTag,
          appLatestSource: update.source,
        }
      : {};
    await broadcastSnapshot();
    return update;
  };

  const buildSnapshot = async (options: { refreshDependencies?: boolean } = {}): Promise<DesktopSnapshot> => ({
    paths,
    services: serviceManager.snapshot(),
    serviceCommands: await serviceManager.getCommandConfigs(),
    runtimePathConfigs: serviceManager.getRuntimePathConfigs(),
    runtimeResourcePathConfigs: resourceLocationManager.getPathConfigs(),
    terminalSettings: serviceManager.getTerminalSettings(),
    openCodeSettings: openCodeSettingsManager.getSettings(),
    appIconSettings: appIconManager.getSettings(),
    networkProxySettings: networkProxyManager.getSettings(),
    appVersion: app.getVersion(),
    appLatestTag: remoteAppVersionCache.appLatestTag,
    appLatestSource: remoteAppVersionCache.appLatestSource,
    moduleVersions: await readModuleVersions(),
    platform: process.platform,
    windowState: readManagedWindowState(getMainWindow()),
    initState: await initManager.getState({ refreshDependencies: options.refreshDependencies ?? false }),
    startupAgreement: await initManager.getAgreementState(),
    recentLogs: logStore.list(),
  });

  const broadcastSnapshot = async (): Promise<void> => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    window.webContents.send("desktop:snapshot", await buildSnapshot());
  };

  const scheduleRemoteModuleVersionsRefresh = (): void => {
    if (remoteModuleVersionsRefreshPromise) {
      return;
    }
    remoteModuleVersionsRefreshPromise = Promise.all([readRemoteModuleVersions(), readRemoteAppVersion()])
      .then(async ([versions, appVersion]) => {
        remoteModuleVersionsCache = versions;
        remoteAppVersionCache = appVersion;
        await broadcastSnapshot();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logStore.append("desktop", "system", `读取远端版本失败: ${message}`);
      })
      .finally(() => {
        remoteModuleVersionsRefreshPromise = null;
      });
  };

  const scheduleInitDependencyRefresh = (): void => {
    if (initDependencyRefreshPromise) {
      return;
    }
    initDependencyRefreshPromise = initManager.refreshDependencyChecks()
      .then(async () => {
        await broadcastSnapshot();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logStore.append("desktop", "system", `环境依赖检查失败: ${message}`);
      })
      .finally(() => {
        initDependencyRefreshPromise = null;
      });
  };

  const createMaibotPluginClient = (): MaiBotPluginClient =>
    new MaiBotPluginClient({
      maibotRoot: paths.maibotRoot,
      gitPath: initManager.getGitPath(),
      getModuleSourceConfig: () => moduleUpdater.getSourceConfig(),
    });
  let maibotPluginClient = createMaibotPluginClient();
  const pluginBuilderLibrary = new PluginBuilderLibrary(paths.pluginBuilderRoot);
  const localChatAdapter = new LocalChatAdapter(paths, initManager);

  const assertServicesStoppedForResourceMove = (): void => {
    const active = serviceManager
      .snapshot()
      .filter(
        (service) =>
          service.managed ||
          service.status === "starting" ||
          service.status === "running" ||
          service.status === "stopping",
    );
    if (active.length > 0) {
      throw new Error(`请先停止服务，再调整覆盖路径：${active.map((service) => service.name).join(", ")}`);
    }
  };

  const applyResourceMigrationResult = async (
    result: RuntimeResourcePathChangeResult,
  ): Promise<RuntimeResourcePathChangeResult> => {
    initManager.clearDependencyCache();
    serviceManager.reloadRuntimePaths();
    maibotPluginClient = createMaibotPluginClient();
    logStore.append(
      "desktop",
      "system",
      `运行时资源路径已更新: ${result.previousPath} -> ${result.path}`,
    );
    await broadcastSnapshot();
    return result;
  };

  const resetLauncherStores = async (): Promise<void> => {
    for (const service of serviceManager.snapshot()) {
      await serviceManager.resetCommandConfig(service.id);
    }
    await serviceManager.resetRuntimePathConfig("python");
    await serviceManager.resetRuntimePathConfig("git");
    await serviceManager.saveTerminalSettings({ ...serviceManager.getTerminalSettings(), useEmbeddedTerminal: true });
    await networkProxyManager.resetSettings();
    await openCodeSettingsManager.resetSettings();
    appIconManager.reset();
    applyAppIcon();

    for (const key of ["maibot", "napcat"] as const) {
      const config = resourceLocationManager.getPathConfigs().find((item) => item.key === key);
      if (config?.customized) {
        await resourceLocationManager.resetPath(key);
      }
    }

    initManager.clearDependencyCache();
    serviceManager.reloadRuntimePaths();
    maibotPluginClient = createMaibotPluginClient();
  };

  const resetLauncherSettings = async (): Promise<LauncherResetResult> => {
    assertServicesStoppedForResourceMove();
    await resetLauncherStores();

    const removedEntries: string[] = [];
    for (const fileName of LAUNCHER_SETTING_FILES) {
      removedEntries.push(...(await removeExistingPath(join(paths.userDataRoot, fileName))));
    }

    await mkdir(paths.userDataRoot, { recursive: true });
    await mkdir(paths.logsRoot, { recursive: true });
    logStore.append("desktop", "system", "Launcher settings reset.");
    await broadcastSnapshot();
    return {
      mode: "settings",
      root: paths.userDataRoot,
      removedEntries,
      resetAt: Date.now(),
    };
  };

  const resetLauncherAll = async (): Promise<LauncherResetResult> => {
    assertServicesStoppedForResourceMove();
    const root = paths.defaultResourceRoot;
    if (samePath(root, paths.installRoot) || isPathInside(root, paths.installRoot)) {
      throw new Error("Refusing to reset all because the target path contains the install root.");
    }
    if (!samePath(root, paths.userDataRoot) && !isPathInside(paths.userDataRoot, root)) {
      throw new Error("Refusing to reset all because the target path is outside the user data root.");
    }

    await resetLauncherStores();
    const resetEntries = samePath(root, paths.userDataRoot)
      ? [...LAUNCHER_RUNTIME_DIRECTORIES, ...LAUNCHER_SETTING_FILES]
      : undefined;
    const removedEntries = await clearDirectoryContents(root, resetEntries);
    await mkdir(paths.logsRoot, { recursive: true });
    initManager.clearDependencyCache();
    serviceManager.reloadRuntimePaths();
    maibotPluginClient = createMaibotPluginClient();
    logStore.append("desktop", "system", `运行时资源目录已清空: ${root}`);
    await broadcastSnapshot();
    return {
      mode: "all",
      root,
      removedEntries,
      resetAt: Date.now(),
    };
  };

  serviceManager.on("snapshot", (services: ServiceDescriptor[]) => {
    const window = getMainWindow();
    window?.webContents.send("services:snapshot", services);
    void broadcastSnapshot();
  });
  logStore.onEntry((entry) => {
    const window = getMainWindow();
    window?.webContents.send("logs:entry", entry);
  });
  localChatAdapter.onEvent((event) => {
    const window = getMainWindow();
    window?.webContents.send("localChat:event", event);
  });

  ipcMain.handle("desktop:getSnapshot", async (): Promise<DesktopSnapshot> => {
    await serviceManager.refresh();
    const snapshot = await buildSnapshot();
    scheduleInitDependencyRefresh();
    scheduleRemoteModuleVersionsRefresh();
    return snapshot;
  });

  ipcMain.handle("desktop:openExternal", async (_event, url: string): Promise<void> => {
    await shell.openExternal(url);
  });

  ipcMain.handle("desktop:openPath", async (_event, path: string): Promise<void> => {
    await shell.openPath(path);
  });

  ipcMain.handle("live2d:getLibraryRoot", async (): Promise<string> => {
    await mkdir(paths.live2dRoot, { recursive: true });
    return paths.live2dRoot;
  });

  ipcMain.handle("live2d:openLibrary", async (): Promise<void> => {
    await mkdir(paths.live2dRoot, { recursive: true });
    await shell.openPath(paths.live2dRoot);
  });

  ipcMain.handle(
    "live2d:importModel",
    async (_event, sourcePath?: string): Promise<Live2dModelImportResult | null> => {
      let nextSourcePath = sourcePath?.trim().replace(/^["']|["']$/gu, "");
      if (!nextSourcePath) {
        const mainWindow = getMainWindow();
        const dialogOptions: Electron.OpenDialogOptions = {
          title: "Select Live2D model",
          properties: ["openFile"],
          filters: [
            { name: "Live2D 模型 JSON", extensions: ["json"] },
            { name: "全部文件", extensions: ["*"] },
          ],
        };
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }
        nextSourcePath = result.filePaths[0];
      }

      const result = await importLive2dModel(paths, nextSourcePath);
      logStore.append(
        "desktop",
        "system",
        `Live2D 模型已导入: ${result.sourcePath} -> ${result.modelPath}`,
      );
      return result;
    },
  );

  ipcMain.handle("init:getState", async (): Promise<InitState> => {
    return initManager.getState({ refreshDependencies: true });
  });

  ipcMain.handle("init:repair", async (): Promise<InitRepairResult> => {
    const result = await initManager.repair();
    logStore.append("desktop", "system", `Initialization repair changed ${result.changedFiles.length} files.`);
    await broadcastSnapshot();
    return result;
  });

  ipcMain.handle("init:resetSnowLuma", async (): Promise<SnowLumaResetResult> => {
    await serviceManager.refresh();
    if (serviceManager.snapshot().some(isRuntimeBusy)) {
      throw new Error("Stop MaiBot Core and QQ backend before resetting SnowLuma.");
    }

    const result = await initManager.resetSnowLumaComponent();
    serviceManager.reloadRuntimePaths();
    logStore.append("desktop", "system", `SnowLuma 组件已重置: ${result.snowlumaRoot}`);
    await broadcastSnapshot();
    return result;
  });

  ipcMain.handle("init:setQqBackend", async (_event, backend: QqBackend): Promise<InitState> => {
    const currentInitState = await initManager.getState();
    if (backend !== "napcat" && backend !== "snowluma") {
      throw new Error("Unsupported QQ backend.");
    }
    if (backend !== currentInitState.qqBackend && serviceManager.snapshot().some(isRuntimeBusy)) {
      throw new Error("Stop MaiBot Core and QQ backend before switching QQ backend.");
    }
    await initManager.setQqBackend(backend);
    serviceManager.reloadRuntimePaths();
    const state = await initManager.getState();
    logStore.append("desktop", "system", `QQ 后端已切换为: ${backend === "snowluma" ? "SnowLuma" : "NapCat"}`);
    await broadcastSnapshot();
    return state;
  });

  ipcMain.handle(
    "init:setQqAccount",
    async (_event, request: QqAccountSetupRequest): Promise<InitState> => {
      const currentInitState = await initManager.getState();
      const requestedBackend = request.qqBackend ?? currentInitState.qqBackend;
      if (
        requestedBackend !== currentInitState.qqBackend &&
        serviceManager.snapshot().some(isRuntimeBusy)
      ) {
        throw new Error("Stop MaiBot Core and QQ backend before switching QQ backend.");
      }
      const state = await initManager.setQqAccount(
        request.qqAccount,
        request.websocketToken,
        request.chat,
        request.qqBackend,
      );
      serviceManager.reloadRuntimePaths();
      logStore.append("desktop", "system", `机器人 QQ 号已配置: ${request.qqAccount}`);
      await broadcastSnapshot();
      return state;
    },
  );

  ipcMain.handle("agreements:getState", async (): Promise<StartupAgreementState> => {
    return initManager.getAgreementState();
  });

  ipcMain.handle("agreements:confirm", async (): Promise<StartupAgreementConfirmResult> => {
    const result = await initManager.confirmAgreements();
    logStore.append("desktop", "system", `Startup agreements confirmed, changed ${result.changedFiles.length} files.`);
    await broadcastSnapshot();
    return result;
  });

  ipcMain.handle("modules:updateMaibot", async (_event, target?: ModuleUpdateTarget): Promise<ModuleUpdateResult> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping") {
      throw new Error("Stop MaiBot Core before updating MaiBot.");
    }

    logStore.append("desktop", "system", "Updating MaiBot module from Git.");
    const result = await moduleUpdater.updateMaiBot(target);
    logStore.append(
      "desktop",
      "system",
      `MaiBot update finished: ${result.before ?? "-"} -> ${result.after ?? "-"} (${result.changed ? "changed" : "unchanged"})`,
    );
    await broadcastSnapshot();
    return result;
  });

  ipcMain.handle("modules:listMaibotBranches", async (): Promise<ModuleBranchOption[]> => {
    return moduleUpdater.listMaiBotBranches();
  });

  ipcMain.handle("modules:listMaibotTags", async (): Promise<ModuleTagOption[]> => {
    return moduleUpdater.listMaiBotTags();
  });

  ipcMain.handle("modules:getSourceConfig", async (): Promise<ModuleSourceConfig> => {
    return moduleUpdater.getSourceConfig();
  });

  ipcMain.handle("modules:saveSourceConfig", async (_event, config: ModuleSourceUpdate): Promise<ModuleSourceConfig> => {
    const result = await moduleUpdater.saveSourceConfig(config);
    logStore.append("desktop", "system", `Module source saved: ${result.preset} (${result.maibotUrl})`);
    return result;
  });


  ipcMain.handle("data:importMaibotDb", async (): Promise<MaiBotDataImportResult | null> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping") {
      throw new Error("Stop MaiBot Core before importing the database.");
    }

    const mainWindow = getMainWindow();
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Import MaiBot database",
      properties: ["openFile"],
      filters: [
        { name: "MaiBot database", extensions: ["db"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const importResult = await initManager.importMaiBotDatabase(result.filePaths[0]);
    logStore.append(
      "desktop",
      "system",
      `MaiBot.db imported: ${importResult.sourcePath} -> ${importResult.destPath}`,
    );
    await broadcastSnapshot();
    return importResult;
  });

  ipcMain.handle(
    "data:importMaibotConfig",
    async (_event, fileName: MaiBotConfigFileName): Promise<MaiBotConfigImportResult | null> => {
      const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
      if (
        maibot?.managed ||
        maibot?.status === "starting" ||
        maibot?.status === "running" ||
        maibot?.status === "stopping"
      ) {
        throw new Error("Stop MaiBot Core before importing config files.");
      }

      if (fileName !== "bot_config.toml" && fileName !== "model_config.toml") {
        throw new Error(`Unsupported config file: ${fileName}`);
      }

      const mainWindow = getMainWindow();
      const dialogOptions: Electron.OpenDialogOptions = {
        title: `Import ${fileName}`,
        properties: ["openFile"],
        filters: [
          { name: "TOML files", extensions: ["toml"] },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      const importResult = await initManager.importMaiBotConfig(fileName, result.filePaths[0]);
      logStore.append(
        "desktop",
        "system",
        `MaiBot ${fileName} imported: ${importResult.sourcePath} -> ${importResult.destPath}`,
      );
      await broadcastSnapshot();
      return importResult;
    },
  );

  ipcMain.handle("data:resetMaibotData", async (): Promise<MaiBotDataResetResult> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping") {
      throw new Error("Stop MaiBot Core before resetting data.");
    }

    const resetResult = await initManager.resetMaiBotData();
    logStore.append(
      "desktop",
      "system",
      `MaiBot data reset (${resetResult.removedEntries.length} entries): ${resetResult.dataDir}`,
    );
    await broadcastSnapshot();
    return resetResult;
  });

  ipcMain.handle("launcher:resetSettings", async (): Promise<LauncherResetResult> => {
    return resetLauncherSettings();
  });

  ipcMain.handle("launcher:resetAll", async (): Promise<LauncherResetResult> => {
    return resetLauncherAll();
  });

  ipcMain.handle(
    "launcher:saveNetworkProxySettings",
    async (_event, settings: NetworkProxySettings): Promise<NetworkProxySettings> => {
      const result = await networkProxyManager.saveSettings(settings);
      logStore.append(
        "desktop",
        "system",
        result.enabled
          ? `\u7f51\u7edc\u4ee3\u7406\u5df2\u542f\u7528: 127.0.0.1:${result.port}`
          : "\u7f51\u7edc\u4ee3\u7406\u5df2\u5173\u95ed",
      );
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle(
    "launcher:saveOpenCodeSettings",
    async (_event, settings: OpenCodeSettings): Promise<OpenCodeSettings> => {
      const result = await openCodeSettingsManager.saveSettings(settings);
      logStore.append(
        "desktop",
        "system",
        result.useBundledPluginInstructions
          ? "OpenCode 已启用内置插件编写说明"
          : "OpenCode 已恢复项目默认说明",
      );
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle("launcher:selectAppIcon", async (_event, iconId: AppIconId): Promise<AppIconSettings> => {
    const result = await appIconManager.select(iconId);
    applyAppIcon();
    return result;
  });

  ipcMain.handle("launcher:checkUpdate", async (): Promise<LauncherUpdateInfo> => {
    return publicLauncherUpdateInfo(await checkLauncherUpdate());
  });

  ipcMain.handle("launcher:downloadAndInstallUpdate", async (): Promise<LauncherUpdateApplyResult> => {
    const update = await checkLauncherUpdate();
    if (!update.available) {
      throw new Error("当前启动器已经是最新版本");
    }

    const installerPath = await downloadLauncherUpdate(paths, update);
    const child = spawn(installerPath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    logStore.append("desktop", "system", `启动器更新安装器已启动: ${installerPath}`);
    setTimeout(() => requestQuit(), 800);
    return {
      update: publicLauncherUpdateInfo(update),
      installerPath,
      started: true,
      willQuit: true,
    };
  });

  ipcMain.handle("plugins:listMarket", async (
    _event,
    serviceUrl?: string,
    options?: MaiBotPluginListOptions,
  ): Promise<MaiBotPluginListResult> => {
    return maibotPluginClient.listMarket(serviceUrl, options);
  });

  ipcMain.handle("plugins:listInstalled", async (_event, serviceUrl?: string): Promise<MaiBotInstalledPlugin[]> => {
    return maibotPluginClient.listInstalled(serviceUrl);
  });

  ipcMain.handle(
    "plugins:install",
    async (_event, request: MaiBotPluginOperationRequest): Promise<MaiBotPluginOperationResult> => {
      if (!request.pluginId || !request.repositoryUrl) {
        throw new Error("Plugin id and repository url are required.");
      }
      const result = await maibotPluginClient.install(request.pluginId, request.repositoryUrl, request.branch);
      logStore.append("desktop", "system", `MaiBot plugin installed: ${request.pluginId}`);
      return result;
    },
  );

  ipcMain.handle(
    "plugins:update",
    async (_event, request: MaiBotPluginOperationRequest): Promise<MaiBotPluginOperationResult> => {
      if (!request.pluginId || !request.repositoryUrl) {
        throw new Error("Plugin id and repository url are required.");
      }
      const result = await maibotPluginClient.update(
        request.pluginId,
        request.repositoryUrl,
        request.branch,
        request.latestVersion,
      );
      logStore.append("desktop", "system", `MaiBot plugin updated: ${request.pluginId}`);
      return result;
    },
  );

  ipcMain.handle(
    "plugins:uninstall",
    async (_event, pluginId: string): Promise<MaiBotPluginOperationResult> => {
      if (!pluginId) {
        throw new Error("Plugin id is required.");
      }
      const result = await maibotPluginClient.uninstall(pluginId);
      logStore.append("desktop", "system", `MaiBot plugin uninstalled: ${pluginId}`);
      return result;
    },
  );

  ipcMain.handle(
    "plugins:createFromBlueprint",
    async (_event, request: MaiBotPluginBlueprintCreateRequest): Promise<MaiBotPluginBlueprintCreateResult> => {
      if (!request?.blueprint) {
        throw new Error("Plugin blueprint is required.");
      }
      const result = await maibotPluginClient.createFromBlueprint(request.blueprint, request.overwrite === true);
      logStore.append("desktop", "system", `MaiBot plugin generated from blueprint: ${result.pluginId}`);
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle("plugins:parseToBlueprint", async (_event, pluginId: string): Promise<MaiBotPluginBlueprintParseResult> => {
    if (!pluginId) {
      throw new Error("Plugin id is required.");
    }
    return maibotPluginClient.parseToBlueprint(pluginId);
  });

  ipcMain.handle("plugins:listBuilderLibrary", async (): Promise<MaiBotPluginBuilderLibraryListResult> => {
    return pluginBuilderLibrary.list();
  });

  ipcMain.handle(
    "plugins:saveBuilderLibrary",
    async (_event, request: MaiBotPluginBuilderLibrarySaveRequest): Promise<MaiBotPluginBuilderLibrarySaveResult> => {
      if (!request?.blueprint) {
        throw new Error("Plugin blueprint is required.");
      }
      const result = await pluginBuilderLibrary.save(request.blueprint, request.overwrite !== false);
      logStore.append("desktop", "system", `Builder plugin saved: ${result.item.pluginId}`);
      return result;
    },
  );

  ipcMain.handle(
    "plugins:loadBuilderLibrary",
    async (_event, pluginId: string): Promise<MaiBotPluginBuilderLibraryLoadResult> => {
      if (!pluginId) {
        throw new Error("Plugin id is required.");
      }
      return pluginBuilderLibrary.load(pluginId);
    },
  );

  ipcMain.handle(
    "plugins:deleteBuilderLibrary",
    async (_event, pluginId: string): Promise<MaiBotPluginBuilderLibraryDeleteResult> => {
      if (!pluginId) {
        throw new Error("Plugin id is required.");
      }
      const result = await pluginBuilderLibrary.delete(pluginId);
      logStore.append("desktop", "system", `Builder plugin deleted: ${result.pluginId}`);
      return result;
    },
  );

  ipcMain.handle(
    "plugins:exportBuilderBlueprint",
    async (
      _event,
      request: MaiBotPluginBuilderBlueprintExportRequest,
    ): Promise<MaiBotPluginBuilderBlueprintExportResult | null> => {
      if (!request?.blueprint) {
        throw new Error("Plugin blueprint is required.");
      }
      const errors = validateMaiBotPluginBlueprint(request.blueprint);
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }

      const pluginId = request.blueprint.manifest.pluginId.trim();
      const defaultPath = join(
        pluginBuilderLibrary.getRoot(),
        `${defaultMaiBotPluginFolderName(pluginId)}.maibot-plugin-blueprint.json`,
      );
      const mainWindow = getMainWindow();
      const dialogOptions: Electron.SaveDialogOptions = {
        title: "Export plugin blueprint",
        defaultPath,
        filters: [
          { name: "MaiBot 插件蓝图", extensions: ["maibot-plugin-blueprint.json", "json"] },
          { name: "JSON", extensions: ["json"] },
        ],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        return null;
      }

      const exportedAt = Date.now();
      const payload = {
        version: 1,
        exportedAt,
        blueprint: request.blueprint,
        files: buildMaiBotPluginBlueprintFiles(request.blueprint),
      };
      await mkdir(dirname(result.filePath), { recursive: true });
      await writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      logStore.append("desktop", "system", `Builder blueprint exported: ${pluginId} -> ${result.filePath}`);
      return {
        pluginId,
        filePath: result.filePath,
        exportedAt,
      };
    },
  );

  ipcMain.handle(
    "plugins:importBuilderBlueprint",
    async (_event, sourcePath?: string): Promise<MaiBotPluginBuilderBlueprintImportResult | null> => {
      let nextSourcePath = sourcePath?.trim().replace(/^["']|["']$/gu, "");
      if (!nextSourcePath) {
        const mainWindow = getMainWindow();
        const dialogOptions: Electron.OpenDialogOptions = {
          title: "Import plugin blueprint",
          properties: ["openFile"],
          filters: [
            { name: "MaiBot 插件蓝图", extensions: ["json"] },
            { name: "全部文件", extensions: ["*"] },
          ],
        };
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }
        nextSourcePath = result.filePaths[0];
      }

      const source = resolve(nextSourcePath);
      const raw = JSON.parse(await readFile(source, "utf8")) as {
        blueprint?: MaiBotPluginBlueprint;
        version?: number;
      } & Partial<MaiBotPluginBlueprint>;
      const blueprint = raw.blueprint ?? (raw.manifest && raw.components && raw.configFields ? raw as MaiBotPluginBlueprint : null);
      if (!blueprint?.manifest?.pluginId) {
        throw new Error("Not a valid MaiBot plugin blueprint file.");
      }
      const errors = validateMaiBotPluginBlueprint(blueprint);
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }

      const saveResult = await pluginBuilderLibrary.save(blueprint, true);
      logStore.append("desktop", "system", `Builder blueprint imported: ${source} -> ${saveResult.item.pluginId}`);
      return {
        item: saveResult.item,
        blueprint,
        files: saveResult.files,
        sourcePath: source,
        overwritten: saveResult.overwritten,
        importedAt: saveResult.savedAt,
      };
    },
  );

  ipcMain.handle("plugins:openBuilderLibrary", async (): Promise<void> => {
    await mkdir(pluginBuilderLibrary.getRoot(), { recursive: true });
    await shell.openPath(pluginBuilderLibrary.getRoot());
  });

  ipcMain.handle("plugins:getConfig", async (_event, pluginId: string, serviceUrl?: string): Promise<MaiBotPluginConfigState> => {
    return maibotPluginClient.getConfig(pluginId, serviceUrl);
  });

  ipcMain.handle(
    "plugins:saveConfig",
    async (
      _event,
      pluginId: string,
      config: Record<string, MaiBotPluginConfigValue>,
      serviceUrl?: string,
    ): Promise<MaiBotPluginConfigSaveResult> => {
      const result = await maibotPluginClient.saveConfig(pluginId, config, serviceUrl);
      logStore.append("desktop", "system", `MaiBot plugin config saved: ${pluginId}`);
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle("plugins:getReadme", async (_event, pluginId: string, repositoryUrl?: string): Promise<MaiBotPluginReadmeResult> => {
    return maibotPluginClient.getReadme(pluginId, repositoryUrl);
  });

  ipcMain.handle("plugins:getStats", async (_event, pluginId: string): Promise<MaiBotPluginStats | null> => {
    return maibotPluginClient.getStats(pluginId);
  });

  ipcMain.handle("plugins:getUserState", async (
    _event,
    pluginId: string,
    userId: string,
  ): Promise<MaiBotPluginUserState | null> => {
    return maibotPluginClient.getUserState(pluginId, userId);
  });

  ipcMain.handle("plugins:getUserStates", async (
    _event,
    userId: string,
  ): Promise<MaiBotPluginUserStates> => {
    return maibotPluginClient.getUserStates(userId);
  });

  ipcMain.handle("plugins:like", async (
    _event,
    pluginId: string,
    userId: string,
  ): Promise<MaiBotPluginVoteResult> => {
    return maibotPluginClient.likePlugin(pluginId, userId);
  });

  ipcMain.handle("plugins:dislike", async (
    _event,
    pluginId: string,
    userId: string,
  ): Promise<MaiBotPluginVoteResult> => {
    return maibotPluginClient.dislikePlugin(pluginId, userId);
  });

  ipcMain.handle("plugins:rate", async (
    _event,
    pluginId: string,
    rating: number | null | undefined,
    comment: string | null | undefined,
    userId: string,
  ): Promise<MaiBotPluginRatingResult> => {
    return maibotPluginClient.ratePlugin(pluginId, rating, comment, userId);
  });

  ipcMain.handle("plugins:recordDownload", async (
    _event,
    pluginId: string,
    userId?: string,
    fingerprint?: string,
  ): Promise<MaiBotPluginDownloadResult> => {
    return maibotPluginClient.recordDownload(pluginId, userId, fingerprint);
  });

  ipcMain.handle("statistics:getMaibot", async (): Promise<MaiBotStatisticSummary> => {
    return readMaiBotStatistics(paths);
  });

  ipcMain.handle("pythonDeps:getState", (): PythonOverridesState => {
    return pythonDependencyManager.getState();
  });

  ipcMain.handle("pythonDeps:saveSourcePreset", async (_event, preset: PythonPackageSourcePreset): Promise<PythonOverridesState> => {
    const state = await pythonDependencyManager.saveSourcePreset(preset);
    await broadcastSnapshot();
    return state;
  });

  ipcMain.handle("pythonDeps:listVersions", async (_event, packageName: ManagedPythonPackageName): Promise<PythonPackageVersionList> => {
    return pythonDependencyManager.listVersions(packageName);
  });

  ipcMain.handle("pythonDeps:installVersion", async (_event, request: PythonPackageInstallRequest): Promise<PythonPackageInstallResult> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping") {
      throw new Error("Stop MaiBot Core before updating Python dependencies.");
    }

    logStore.append("desktop", "system", `Installing Python dependency: ${request.packageName}==${request.version}`);
    const result = await pythonDependencyManager.installVersion(request);
    logStore.append(
      "desktop",
      "system",
      `Python dependency installed: ${result.packageName}==${result.version} -> ${result.targetDir}`,
    );
    await broadcastSnapshot();
    return result;
  });

  ipcMain.handle("services:start", async (_event, serviceId: ServiceId): Promise<ServiceDescriptor> => {
    const descriptor = await serviceManager.start(serviceId);
    await broadcastSnapshot();
    return descriptor;
  });

  ipcMain.handle("services:stop", async (_event, serviceId: ServiceId): Promise<ServiceDescriptor> => {
    const descriptor = await serviceManager.stop(serviceId);
    await broadcastSnapshot();
    return descriptor;
  });

  ipcMain.handle("services:restart", async (_event, serviceId: ServiceId): Promise<ServiceDescriptor> => {
    const descriptor = await serviceManager.restart(serviceId);
    await broadcastSnapshot();
    return descriptor;
  });

  ipcMain.handle("services:startAll", async (): Promise<ServiceDescriptor[]> => {
    const services = await serviceManager.startAll();
    await broadcastSnapshot();
    return services;
  });

  ipcMain.handle("services:stopAll", async (): Promise<ServiceDescriptor[]> => {
    const services = await serviceManager.stopAll();
    await broadcastSnapshot();
    return services;
  });

  ipcMain.handle("services:refresh", async (): Promise<ServiceDescriptor[]> => {
    const services = await serviceManager.refresh();
    await broadcastSnapshot();
    return services;
  });

  ipcMain.handle("services:saveCommandConfig", async (_event, config: ServiceCommandUpdate): Promise<DesktopSnapshot["serviceCommands"]> => {
    const configs = await serviceManager.saveCommandConfig(config);
    await broadcastSnapshot();
    return configs;
  });

  ipcMain.handle("services:resetCommandConfig", async (_event, serviceId: ServiceId): Promise<DesktopSnapshot["serviceCommands"]> => {
    const configs = await serviceManager.resetCommandConfig(serviceId);
    await broadcastSnapshot();
    return configs;
  });

  ipcMain.handle("services:saveRuntimePathConfig", async (_event, config: RuntimePathUpdate): Promise<RuntimePathConfig[]> => {
    const configs = await serviceManager.saveRuntimePathConfig(config);
    await broadcastSnapshot();
    return configs;
  });

  ipcMain.handle("services:resetRuntimePathConfig", async (_event, key: RuntimePathKey): Promise<RuntimePathConfig[]> => {
    const configs = await serviceManager.resetRuntimePathConfig(key);
    await broadcastSnapshot();
    return configs;
  });

  ipcMain.handle("services:listPythonRuntimeCandidates", async (): Promise<PythonRuntimeCandidate[]> => {
    return initManager.listSystemPythonRuntimeCandidates();
  });

  ipcMain.handle("services:selectPythonRuntimePath", async (): Promise<string | null> => {
    const mainWindow = getMainWindow();
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Select Python executable",
      properties: ["openFile"],
      filters: [
        { name: "Python", extensions: process.platform === "win32" ? ["exe"] : ["*"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("services:saveTerminalSettings", async (_event, settings: TerminalSettings): Promise<TerminalSettings> => {
    const config = await serviceManager.saveTerminalSettings(settings);
    await broadcastSnapshot();
    return config;
  });

  const chooseResourcePath = async (title: string): Promise<string | undefined> => {
    const mainWindow = getMainWindow();
    const dialogOptions: Electron.OpenDialogOptions = {
      title,
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
  };

  ipcMain.handle(
    "resources:migratePath",
    async (_event, key: RuntimeResourcePathKey): Promise<RuntimeResourcePathChangeResult | null> => {
      assertServicesStoppedForResourceMove();
      const targetPath = await chooseResourcePath("Select migration target directory");
      if (!targetPath) {
        return null;
      }

      const migration = await resourceLocationManager.migratePath(key, targetPath);
      return applyResourceMigrationResult(migration);
    },
  );

  ipcMain.handle(
    "resources:selectPath",
    async (_event, key: RuntimeResourcePathKey): Promise<RuntimeResourcePathChangeResult | null> => {
      assertServicesStoppedForResourceMove();
      const targetPath = await chooseResourcePath("Select existing directory");
      if (!targetPath) {
        return null;
      }

      const selection = await resourceLocationManager.selectPath(key, targetPath);
      return applyResourceMigrationResult(selection);
    },
  );

  ipcMain.handle(
    "resources:savePath",
    async (_event, key: RuntimeResourcePathKey, targetPath: string): Promise<RuntimeResourcePathChangeResult> => {
      assertServicesStoppedForResourceMove();
      const selection = await resourceLocationManager.selectPath(key, targetPath);
      return applyResourceMigrationResult(selection);
    },
  );

  ipcMain.handle("resources:resetPath", async (_event, key: RuntimeResourcePathKey): Promise<RuntimeResourcePathChangeResult> => {
    assertServicesStoppedForResourceMove();
    const migration = await resourceLocationManager.resetPath(key);
    return applyResourceMigrationResult(migration);
  });

  ipcMain.handle("logs:list", (): LogEntry[] => logStore.list());

  ipcMain.handle("logs:clear", (): void => {
    logStore.clear();
    void broadcastSnapshot();
  });

  ipcMain.handle("localChat:connect", async (_event, request?: LocalChatConnectRequest): Promise<LocalChatConnectionState> => {
    return localChatAdapter.connect(request);
  });

  ipcMain.handle("localChat:disconnect", async (): Promise<void> => {
    localChatAdapter.disconnect();
  });

  ipcMain.handle("localChat:send", async (_event, request: LocalChatSendRequest): Promise<LocalChatMessageEvent> => {
    return localChatAdapter.send(request);
  });

  ipcMain.handle("localChat:listMessages", async (): Promise<LocalChatMessageEvent[]> => {
    return localChatAdapter.listMessages();
  });

  ipcMain.handle("desktop:openLogsDirectory", async (): Promise<void> => {
    await mkdir(paths.logsRoot, { recursive: true });
    await shell.openPath(paths.logsRoot);
  });

  ipcMain.handle("desktop:chooseCloseAction", async (_event, action: CloseAction): Promise<void> => {
    const mainWindow = getMainWindow();

    if (action === "minimize") {
      mainWindow?.hide();
      return;
    }

    requestQuit();
  });

  ipcMain.handle("desktop:show", (): void => showMainWindow());

  ipcMain.handle("desktop:window:minimize", (): void => {
    getMainWindow()?.minimize();
  });

  ipcMain.handle("desktop:window:toggleMaximize", (): WindowState | void => {
    const window = getMainWindow();
    if (!window) return;
    return isShellWindowMaximized(window)
      ? restoreShellWindow(window)
      : maximizeShellWindow(window);
  });

  ipcMain.handle("desktop:window:close", (): void => {
    getMainWindow()?.close();
  });

  ipcMain.handle("desktop:window:setFloatingMode", (_event, enabled: boolean): WindowState => applyFloatingMode(enabled));

  ipcMain.handle("desktop:window:setFloatingPanelExpanded", (_event, expanded: boolean): WindowState =>
    applyFloatingPanelExpanded(expanded),
  );

  ipcMain.handle("desktop:window:moveFloatingBy", (_event, deltaX: number, deltaY: number): WindowState =>
    moveFloatingBy(deltaX, deltaY),
  );
  ipcMain.handle(
    "desktop:window:moveFloatingTo",
    (_event, offsetX: number, offsetY: number): WindowState =>
      moveFloatingTo(offsetX, offsetY),
  );

  ipcMain.handle("desktop:window:finishFloatingDrag", (): WindowState => finishFloatingDrag());

  ipcMain.handle(
    "desktop:window:startResize",
    (_event, edge: WindowResizeEdge, screenX: number, screenY: number): WindowState =>
      startWindowResize(edge, screenX, screenY),
  );

  ipcMain.handle("desktop:window:resizeTo", (_event, screenX: number, screenY: number): WindowState =>
    resizeWindowTo(screenX, screenY),
  );

  ipcMain.handle("desktop:window:finishResize", (): WindowState => finishWindowResize());

  ipcMain.handle("desktop:window:getState", (): WindowState =>
    readManagedWindowState(getMainWindow()),
  );

  return {
    localChatAdapter,
    dispose: () => {
      localChatAdapter.dispose();
    },
  };
}
