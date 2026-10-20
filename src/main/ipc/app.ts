import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  session,
  shell,
} from "electron";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { fetchMirrorManifest, isOfficialLauncherDownloadUrl, withDownloadFallback } from "../services/launcher-update-mirror";
import { resolveMaiBotUpdateTarget } from "../../shared/maibot-update-target";
import { isWindowsLongPathError } from "../../shared/windows-long-path";
import { enableWindowsLongPaths, windowsLongPathsEnabled } from "../services/windows-long-path";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  CloseAction,
  AppIconId,
  AppIconSettings,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
  LauncherUiSettings,
  LauncherUpdateApplyResult,
  LauncherUpdateDownloadProgress,
  LauncherUpdateInfo,
  LauncherResetResult,
  LogEntry,
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatMessageEvent,
  LocalChatSendRequest,
  MaiBotBackupExportResult,
  MaiBotBackupImportResult,
  MaiBotBackupProgress,
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  MaiBotStorageCleanupResult,
  MaiBotStorageCleanupTarget,
  MaiBotStorageStats,
  MaiBotUpdateInfo,
  MaiBotModuleUpdateProgress,
  ManagedPythonPackageName,
  ModuleRuntimeVersions,
  ModuleUpdateResult,
  NetworkProxySettings,
  ModuleTagOption,
  ModuleUpdateTarget,
  PythonEnvironmentState,
  PythonPackageSourcePreset,
  PythonPackageInstallRequest,
  PythonPackageInstallResult,
  PythonPackageVersionList,
  QqBackend,
  QqAccountSetupRequest,
  QqComponentUpgradeResult,
  RuntimePaths,
  RuntimeResourcePathChangeResult,
  RuntimeResourcePathKey,
  ResourcePathMode,
  ResourcePathPlan,
  ResourcePathProgress,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceId,
  ServiceStartupSettings,
  SnowLumaResetResult,
  SourceSettings,
  SourceSettingsUpdate,
  SystemPerformanceSnapshot,
  StartupAgreementConfirmResult,
  StartupAgreementState,
  TerminalSettings,
  WindowResizeEdge,
  WindowState,
} from "../../shared/contracts";
import { InitManager } from "../services/init-manager";
import { readMaiBotDeployment } from "../services/maibot-deployment-state";
import type { AppIconManager } from "../services/app-icon-manager";
import type { CodexPetManager } from "../services/codex-pet-manager";
import { LogStore } from "../services/log-store";
import { LocalChatAdapter } from "../services/local-chat-adapter";
import { LauncherUiSettingsManager } from "../services/launcher-ui-settings-manager";
import { getLauncherUpdateDownloadRoot } from "../services/launcher-update-cleanup";
import { ModuleUpdater } from "../services/module-updater";
import { NetworkProxyManager } from "../services/network-proxy-manager";
import { PythonDependencyManager } from "../services/python-dependency-manager";
import { ResourceLocationManager } from "../services/resource-location-manager";
import { ServiceManager } from "../services/service-manager";
import { defaultServiceStartupSettings } from "../services/service-startup-defaults";
import { SourceSettingsManager } from "../services/source-settings-manager";
import {
  getWindowWorkAreaBounds,
  isWindowVisuallyMaximized,
} from "../window-state";
import { getMiniWindowBounds } from "../mini-window-bounds";

let previousCpuSample: { idle: number; total: number } | null = null;

const LAUNCHER_SETTING_FILES = [
  "resource-paths.json",
  "resource-location.json",
  "service-commands.json",
  "runtime-paths.json",
  "terminal-settings.json",
  "service-startup-settings.json",
  "qq-backend.json",
  "message-platform.json",
  "module-sources.json",
  "maibot-update-selection.json",
  "python-dependency-source.json",
  "source-settings.json",
  "network-proxy.json",
  "launcher-ui-settings.json",
  "app-icon-settings.json",
  "qq-component-upgrade-state.json",
];
const LAUNCHER_RUNTIME_DIRECTORIES = ["modules", "python-env", "python-overrides", "logs"];
const RETIRED_ENTRY_DIRECTORY = ".reset-pending-delete";
const REMOVE_RETRY_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 250,
} as const;
const NORMAL_MINIMUM_SIZE = { width: 1000, height: 680 };
const NORMAL_DEFAULT_SIZE = { width: 1100, height: 720 };
const NORMAL_RESTORE_MARGIN = 48;
const FLOATING_BALL_SIZE = { width: 96, height: 96 };
const FLOATING_GLASS_SIZE = { width: 80, height: 86 };
const FLOATING_BUBBLE_SIZE = { width: 360, height: 260 };
const FLOATING_STRIP_SIZE = { width: 28, height: 112 };
const FLOATING_EDGE_SNAP_DISTANCE = 18;
const TRANSPARENT_WINDOW_BACKGROUND = "#00000000";
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
const MAIBOT_WEBVIEW_PARTITION = "persist:maibot-webui";
const ONEKEY_LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/Mai-with-u/MaiBotOneKey/releases/latest";
const ONEKEY_RELEASES_API_URL =
  "https://api.github.com/repos/Mai-with-u/MaiBotOneKey/releases?per_page=100";
const ONEKEY_RELEASE_SOURCE = "Mai-with-u/MaiBotOneKey";
const MAIBOT_UPDATE_SELECTION_FILE = "maibot-update-selection.json";

interface GitHubReleaseAsset {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
  fallback_download_url?: string;
  sha256?: string;
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
  fallbackDownloadUrl?: string;
  sha256?: string;
}

interface LauncherUpdateDownloadResult {
  installerPath: string;
  receivedBytes: number;
  totalBytes?: number;
}

type LauncherUpdateDownloadProgressCallback = (
  progress: LauncherUpdateDownloadProgress,
) => void;

interface RegisterAppIpcOptions {
  paths: RuntimePaths;
  initManager: InitManager;
  moduleUpdater: ModuleUpdater;
  networkProxyManager: NetworkProxyManager;
  launcherUiSettingsManager: LauncherUiSettingsManager;
  pythonDependencyManager: PythonDependencyManager;
  sourceSettingsManager: SourceSettingsManager;
  resourceLocationManager: ResourceLocationManager;
  serviceManager: ServiceManager;
  logStore: LogStore;
  appIconManager: AppIconManager;
  codexPetManager: CodexPetManager;
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

function isRuntimeBusy(service: ServiceDescriptor): boolean {
  return (
    service.status === "starting" ||
    service.status === "running" ||
    service.status === "stopping"
  );
}

function isLauncherUpdateBlockedService(service: ServiceDescriptor): boolean {
  return (
    service.id === "maibot" ||
    service.id === "napcat"
  ) && (isRuntimeBusy(service) || Boolean(service.managed));
}

async function assertLauncherUpdateAllowed(serviceManager: ServiceManager): Promise<void> {
  await serviceManager.refresh();
  const busyService = serviceManager.snapshot().find(isLauncherUpdateBlockedService);
  if (!busyService) {
    return;
  }

  const serviceName = busyService.id === "maibot" ? "MaiBot Core" : busyService.name || "QQ 后端";
  throw new Error(`请先停止 ${serviceName}，再更新一键包。`);
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
  return (
    Boolean(diff) &&
    diff !== ".." &&
    !diff.startsWith(`..${sep}`) &&
    !isAbsolute(diff)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readSystemPerformance(): SystemPerformanceSnapshot {
  const cpuList = cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpuList) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }

  let cpuUsagePercent: number | undefined;
  if (previousCpuSample && total > previousCpuSample.total) {
    const idleDelta = idle - previousCpuSample.idle;
    const totalDelta = total - previousCpuSample.total;
    cpuUsagePercent = Math.max(
      0,
      Math.min(100, (1 - idleDelta / totalDelta) * 100),
    );
  }
  previousCpuSample = { idle, total };

  const memoryTotalBytes = totalmem();
  const memoryFreeBytes = freemem();
  return {
    cpuCores: cpuList.length,
    cpuModel: cpuList[0]?.model ?? "Unknown CPU",
    cpuUsagePercent,
    loadAverage: loadavg(),
    memoryFreeBytes,
    memoryTotalBytes,
    memoryUsedPercent:
      memoryTotalBytes > 0
        ? ((memoryTotalBytes - memoryFreeBytes) / memoryTotalBytes) * 100
        : 0,
    uptimeSeconds: uptime(),
  };
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
  const retiredPath = join(
    retiredRoot,
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

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

async function clearDirectoryContents(
  root: string,
  entryNames?: string[],
): Promise<string[]> {
  if (!existsSync(root)) {
    await mkdir(root, { recursive: true });
    return [];
  }

  const entries = entryNames ?? (await readdir(root));
  const removedEntries = entries.map((entry) => join(root, entry));
  await Promise.all(
    removedEntries.map((entryPath) => retireAndRemovePath(entryPath, root)),
  );
  await mkdir(root, { recursive: true });
  return removedEntries;
}

interface ParsedVersionTag {
  tag: string;
  parts: number[];
  prerelease: boolean;
  prereleaseLabel?: string;
  prereleaseNumber?: number;
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
  const clean = version
    .trim()
    .toLowerCase()
    .replace(/^v/u, "")
    .split(/[+-]/u, 1)[0];
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
  return left.localeCompare(right, "en-US", {
    numeric: true,
    sensitivity: "base",
  });
}

async function readPythonDistInfoVersion(
  root: string,
  packageName: string,
): Promise<string | undefined> {
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const expectedName = normalizePythonPackageName(packageName);
    const versions: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) {
        continue;
      }
      const metadata = await readFile(
        join(root, entry.name, "METADATA"),
        "utf8",
      ).catch(() => undefined);
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
  const match = normalized.match(
    /^(\d+(?:\.\d+){0,3})(?:[-._]?([a-z]+)\.?(\d*)?)?$/iu,
  );
  if (!match) {
    return undefined;
  }
  const prereleaseLabel = match[2]?.toLowerCase();
  const prereleaseNumber = match[3] ? Number(match[3]) : undefined;

  return {
    tag,
    parts: match[1].split(".").map((part) => Number(part)),
    prerelease: Boolean(prereleaseLabel),
    prereleaseLabel,
    prereleaseNumber,
  };
}

function prereleaseRank(label: string | undefined): number {
  switch (label) {
    case "dev":
      return 0;
    case "a":
    case "alpha":
      return 1;
    case "b":
    case "beta":
      return 2;
    case "pre":
    case "preview":
      return 3;
    case "rc":
      return 4;
    default:
      return 5;
  }
}

function compareParsedTags(
  left: ParsedVersionTag,
  right: ParsedVersionTag,
): number {
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index++) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (left.prerelease !== right.prerelease) {
    return left.prerelease ? -1 : 1;
  }
  if (left.prerelease && right.prerelease) {
    const rankDiff =
      prereleaseRank(left.prereleaseLabel) -
      prereleaseRank(right.prereleaseLabel);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    const numberDiff =
      (left.prereleaseNumber ?? 0) - (right.prereleaseNumber ?? 0);
    if (numberDiff !== 0) {
      return numberDiff;
    }
  }
  return left.tag.localeCompare(right.tag, "en-US", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareVersionTags(
  left: string | undefined,
  right: string | undefined,
): number {
  const parsedLeft = left ? parseVersionTag(left) : undefined;
  const parsedRight = right ? parseVersionTag(right) : undefined;
  if (parsedLeft && parsedRight) {
    return compareParsedTags(parsedLeft, parsedRight);
  }
  return (left ?? "").localeCompare(right ?? "", "en-US", {
    numeric: true,
    sensitivity: "base",
  });
}

function releaseTagToVersion(tag: string | undefined): string | undefined {
  return tag?.trim().replace(/^v/iu, "") || undefined;
}

function versionAsTag(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^v/iu.test(trimmed) ? trimmed : `v${trimmed}`;
}

function launcherUpdatePackageLabel(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    return "macOS DMG 安装包";
  }
  if (platform === "win32") {
    return "Windows 安装包";
  }
  return "当前平台安装包";
}

function launcherUpdateDefaultFileName(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    return "MaiBot-OneKey-update.dmg";
  }
  if (platform === "win32") {
    return "MaiBot-OneKey-update.exe";
  }
  return "MaiBot-OneKey-update";
}

function launcherAssetArchNames(arch: string): string[] {
  if (arch === "arm64") {
    return ["arm64", "aarch64"];
  }
  if (arch === "x64") {
    return ["x64", "x86_64", "amd64"];
  }
  return [arch.toLowerCase()];
}

function scoreLauncherUpdateAsset(
  asset: GitHubReleaseAsset,
  platformNames: string[],
  arch: string,
): number {
  const name = String(asset.name ?? "").toLowerCase();
  const archNames = launcherAssetArchNames(arch);
  let score = 0;
  if (platformNames.some((platformName) => name.includes(platformName))) {
    score += 20;
  }
  if (archNames.some((archName) => name.includes(archName))) {
    score += 10;
  }
  if (name.includes("universal")) {
    score += 5;
  }
  return score;
}

function selectBestLauncherUpdateAsset(
  assets: GitHubReleaseAsset[],
  platformNames: string[],
  arch: string,
): GitHubReleaseAsset | undefined {
  return assets
    .map((asset, index) => ({
      asset,
      index,
      score: scoreLauncherUpdateAsset(asset, platformNames, arch),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })[0]?.asset;
}

function sanitizeDownloadFileName(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const sanitized = basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  return sanitized || launcherUpdateDefaultFileName(platform);
}

function selectLauncherUpdateAsset(
  rawAssets: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): GitHubReleaseAsset | undefined {
  const assets = Array.isArray(rawAssets)
    ? rawAssets.filter((item): item is GitHubReleaseAsset => {
        return Boolean(item && typeof item === "object");
      })
    : [];
  const downloadableAssets = assets.filter((asset) => {
    const name = typeof asset.name === "string" ? asset.name.toLowerCase() : "";
    const url =
      typeof asset.browser_download_url === "string"
        ? asset.browser_download_url
        : "";
    return Boolean(name && isOfficialLauncherDownloadUrl(url));
  });

  if (platform === "darwin") {
    const dmgAssets = downloadableAssets.filter((asset) => {
      const name =
        typeof asset.name === "string" ? asset.name.toLowerCase() : "";
      return name.endsWith(".dmg");
    });
    return selectBestLauncherUpdateAsset(
      dmgAssets,
      ["mac", "darwin", "osx"],
      arch,
    );
  }

  if (platform === "win32") {
    const executableAssets = downloadableAssets.filter((asset) => {
      const name =
        typeof asset.name === "string" ? asset.name.toLowerCase() : "";
      return name.endsWith(".exe") && !name.includes("uninstaller");
    });
    return selectBestLauncherUpdateAsset(
      executableAssets,
      ["win", "windows"],
      arch,
    );
  }

  const linuxAssets = downloadableAssets.filter((asset) => {
    const name = typeof asset.name === "string" ? asset.name.toLowerCase() : "";
    return (
      name.endsWith(".appimage") ||
      name.endsWith(".deb") ||
      name.endsWith(".rpm")
    );
  });
  return selectBestLauncherUpdateAsset(linuxAssets, ["linux"], arch);
}

async function fetchLauncherReleaseNotesInRange(
  currentTag: string,
  latestTag: string,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(ONEKEY_RELEASES_API_URL, {
      cache: "no-store",
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
          release.draft !== true &&
          typeof tag === "string" &&
          compareVersionTags(tag, currentTag) > 0 &&
          compareVersionTags(tag, latestTag) <= 0
        );
      })
      .sort((left, right) =>
        compareVersionTags(String(right.tag_name), String(left.tag_name)),
      )
      .map((release) => {
        const tag = String(release.tag_name);
        const title =
          typeof release.name === "string" && release.name.trim()
            ? release.name.trim()
            : tag;
        const body =
          typeof release.body === "string" && release.body.trim()
            ? release.body.trim()
            : "此版本没有填写更新说明。";
        return `## ${title}\n\n${body}`;
      });

    return notes.length > 1 ? notes.join("\n\n---\n\n") : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function releaseBody(release: GitHubReleasePayload): string | undefined {
  return typeof release.body === "string" && release.body.trim()
    ? release.body.trim()
    : undefined;
}

function releaseTitle(
  release: GitHubReleasePayload,
  fallbackTag: string,
): string {
  return typeof release.name === "string" && release.name.trim()
    ? release.name.trim()
    : fallbackTag;
}

async function fetchMaiBotReleaseByTag(
  tag: string,
): Promise<GitHubReleasePayload | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const url = `https://api.github.com/repos/Mai-with-u/MaiBot/releases/tags/${encodeURIComponent(tag)}`;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`GitHub Release returned HTTP ${response.status}`);
    }

    const release = (await response.json()) as unknown;
    return release &&
      typeof release === "object" &&
      (release as GitHubReleasePayload).draft !== true &&
      typeof (release as GitHubReleasePayload).tag_name === "string"
      ? (release as GitHubReleasePayload)
      : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneKeyReleases(): Promise<GitHubReleasePayload[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(ONEKEY_RELEASES_API_URL, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub Releases returned HTTP ${response.status}`);
    }

    const releases = (await response.json()) as unknown;
    if (!Array.isArray(releases)) {
      return [];
    }

    return releases.filter(
      (release): release is GitHubReleasePayload =>
        Boolean(release && typeof release === "object") &&
        release.draft !== true &&
        typeof release.tag_name === "string",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMaiBotUpdateInfo(
  currentVersion: string | undefined,
  target: ModuleUpdateTarget,
): Promise<MaiBotUpdateInfo> {
  const currentTag = versionAsTag(currentVersion);
  const targetName = target.name.trim();
  const release = await fetchMaiBotReleaseByTag(`v${targetName}`).catch(() => undefined);
  return { currentVersion, currentTag, target, releaseName: `MaiBot ${targetName} (PyPI)`,
    releaseUrl: `https://pypi.org/project/maibot/${encodeURIComponent(targetName)}/`,
    releaseNotes: release ? releaseBody(release) : `安装 MaiBot ${targetName} 及其依赖。更新会备份配置、数据和插件，并保留上一个运行环境。`,
    available: currentVersion !== targetName, checkedAt: Date.now(), source: "PyPI" };
}

async function fetchLauncherUpdateInfo(
  currentVersion: string,
): Promise<LauncherUpdateInternalInfo> {
  let mirror = await fetchMirrorManifest().catch(() => undefined);
  if (mirror && !mirror.releases.some((release) => selectLauncherUpdateAsset(release.assets))) {
    mirror = undefined;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    let release: GitHubReleasePayload;
    if (mirror) {
      release = mirror.latest;
    } else {
      const response = await fetch(ONEKEY_LATEST_RELEASE_API_URL, {
        cache: "no-store",
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`GitHub Releases returned HTTP ${response.status}`);
      }

      release = (await response.json()) as GitHubReleasePayload;
    }
    if (release.draft === true || typeof release.tag_name !== "string") {
      throw new Error("Latest release metadata is incomplete");
    }

    const latestTag = release.tag_name;
    const currentTag = `v${currentVersion}`;
    const latestAvailable = compareVersionTags(latestTag, currentTag) > 0;
    let targetRelease = release;
    const latestAsset = selectLauncherUpdateAsset(release.assets);
    let asset = latestAsset;
    if (latestAvailable && !asset) {
      const releases = mirror?.releases ?? await fetchOneKeyReleases().catch(() => []);
      const fallbackRelease = releases
        .filter((item) => {
          const tag = String(item.tag_name);
          return compareVersionTags(tag, currentTag) > 0 && compareVersionTags(tag, latestTag) <= 0;
        })
        .sort((left, right) =>
          compareVersionTags(String(right.tag_name), String(left.tag_name))
        )
        .find((item) => Boolean(selectLauncherUpdateAsset(item.assets)));
      const fallbackAsset = fallbackRelease
        ? selectLauncherUpdateAsset(fallbackRelease.assets)
        : undefined;
      if (fallbackRelease && fallbackAsset) {
        targetRelease = fallbackRelease;
        asset = fallbackAsset;
      }
    }
    const downloadTag = typeof targetRelease.tag_name === "string" ? targetRelease.tag_name : latestTag;
    const available = Boolean(asset) && compareVersionTags(downloadTag, currentTag) > 0;
    const latestReleaseNotes =
      typeof release.body === "string" && release.body.trim()
        ? release.body.trim()
        : undefined;
    const releaseNotes = mirror ? releaseBody(targetRelease) : available
      ? ((await fetchLauncherReleaseNotesInRange(currentTag, downloadTag).catch(
          () => undefined,
        )) ?? releaseBody(targetRelease) ?? latestReleaseNotes)
      : latestReleaseNotes;
    return {
      currentVersion,
      latestTag,
      latestVersion: releaseTagToVersion(latestTag),
      downloadTag,
      downloadVersion: releaseTagToVersion(downloadTag),
      releaseName: releaseTitle(targetRelease, downloadTag),
      releaseUrl:
        typeof targetRelease.html_url === "string"
          ? targetRelease.html_url
          : "https://github.com/Mai-with-u/MaiBotOneKey/releases",
      releaseNotes,
      assetName: typeof asset?.name === "string" ? asset.name : undefined,
      assetSize: typeof asset?.size === "number" ? asset.size : undefined,
      latestAssetUnavailable: latestAvailable && !latestAsset,
      available,
      checkedAt: Date.now(),
      source: mirror ? "CNB · Mai-with-u/MaiBotOneKey" : `GitHub 官方 · ${ONEKEY_RELEASE_SOURCE}`,
      fallbackDownloadUrl: asset?.fallback_download_url,
      sha256: asset?.sha256,
      downloadUrl:
        typeof asset?.browser_download_url === "string"
          ? asset.browser_download_url
          : undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function publicLauncherUpdateInfo(
  update: LauncherUpdateInternalInfo,
): LauncherUpdateInfo {
  const { downloadUrl: _downloadUrl, fallbackDownloadUrl: _fallback, sha256: _sha256, ...publicUpdate } = update;
  return publicUpdate;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const length = Number(value);
  return Number.isFinite(length) && length > 0 ? length : undefined;
}

function launcherDownloadProgress(
  phase: LauncherUpdateDownloadProgress["phase"],
  update: LauncherUpdateInternalInfo,
  receivedBytes: number,
  totalBytes?: number,
): LauncherUpdateDownloadProgress {
  return {
    phase,
    assetName: update.assetName,
    receivedBytes,
    totalBytes,
    percent: totalBytes
      ? Math.min(100, Math.round((receivedBytes / totalBytes) * 1000) / 10)
      : undefined,
  };
}

async function writeDownloadChunk(
  stream: WriteStream,
  chunk: Buffer,
): Promise<void> {
  if (stream.write(chunk)) {
    return;
  }
  await once(stream, "drain");
}

async function finishDownloadStream(stream: WriteStream): Promise<void> {
  stream.end();
  await once(stream, "finish");
}

async function downloadLauncherUpdate(
  paths: RuntimePaths,
  update: LauncherUpdateInternalInfo,
  onProgress?: LauncherUpdateDownloadProgressCallback,
): Promise<LauncherUpdateDownloadResult> {
  if (!update.downloadUrl) throw new Error("没有可下载的安装包");
  if ([update.downloadUrl, update.fallbackDownloadUrl].some((url) => url && !isOfficialLauncherDownloadUrl(url))) {
    throw new Error("安装包只允许从 CNB 或 GitHub 官方仓库下载");
  }
  return withDownloadFallback(
    [update.downloadUrl, update.fallbackDownloadUrl].filter((url): url is string => Boolean(url)),
    (downloadUrl) => downloadLauncherUpdateFromUrl(paths, { ...update, downloadUrl }, onProgress),
  );
}

async function downloadLauncherUpdateFromUrl(
  paths: RuntimePaths,
  update: LauncherUpdateInternalInfo,
  onProgress?: LauncherUpdateDownloadProgressCallback,
): Promise<LauncherUpdateDownloadResult> {
  if (!update.downloadUrl || !update.assetName) {
    throw new Error(`最新版本没有可下载的${launcherUpdatePackageLabel()}`);
  }

  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(update.downloadUrl, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), 30_000);
    if (!response.ok) {
      throw new Error(`安装包下载失败: HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("安装包下载失败：服务器没有返回可读取的内容");
    }

    const updatesRoot = getLauncherUpdateDownloadRoot(paths);
    await mkdir(updatesRoot, { recursive: true });
    const installerPath = join(
      updatesRoot,
      sanitizeDownloadFileName(update.assetName),
    );
    const partialPath = `${installerPath}.download`;
    await rm(partialPath, { force: true }).catch(() => undefined);

    const totalBytes =
      parseContentLength(response.headers.get("content-length")) ??
      update.assetSize;
    const reader = response.body.getReader();
    const stream = createWriteStream(partialPath);
    const hash = createHash("sha256");
    let receivedBytes = 0;
    let lastProgressAt = 0;

    const emitProgress = (
      phase: LauncherUpdateDownloadProgress["phase"],
      force = false,
    ): void => {
      if (!onProgress) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastProgressAt < 120) {
        return;
      }
      lastProgressAt = now;
      onProgress(
        launcherDownloadProgress(phase, update, receivedBytes, totalBytes),
      );
    };

    emitProgress("downloading", true);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        timeout.refresh();
        const chunk = Buffer.from(value);
        hash.update(chunk);
        receivedBytes += chunk.length;
        await writeDownloadChunk(stream, chunk);
        emitProgress("downloading", receivedBytes === totalBytes);
      }

      await finishDownloadStream(stream);
      if (update.assetSize && receivedBytes !== update.assetSize) {
        throw new Error(
          `安装包大小校验失败: ${receivedBytes} / ${update.assetSize}`,
        );
      }

      if (update.sha256 && hash.digest("hex") !== update.sha256) {
        throw new Error("安装包 SHA-256 校验失败");
      }

      await rm(installerPath, { force: true }).catch(() => undefined);
      await rename(partialPath, installerPath);
      emitProgress("starting", true);
      return {
        installerPath,
        receivedBytes,
        totalBytes,
      };
    } catch (error: unknown) {
      await reader.cancel().catch(() => undefined);
      const closed = stream.closed ? Promise.resolve() : new Promise<void>((resolve) => stream.once("close", resolve));
      stream.destroy();
      await closed;
      await rm(partialPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function parsePackageVersion(version: string): ParsedVersionTag | undefined {
  const normalized = version.replace(/^v/iu, "");
  const match = normalized.match(
    /^(\d+(?:\.\d+){0,3})(?:(?:[-._]?(?:dev|a|alpha|b|beta|rc|pre|preview))\d*)?/iu,
  );
  if (!match) {
    return undefined;
  }

  return {
    tag: version,
    parts: match[1].split(".").map((part) => Number(part)),
    prerelease: /(?:^|[._+-])(?:dev|a|alpha|b|beta|rc|pre|preview)\d*/iu.test(
      version,
    ),
  };
}

async function fetchPypiVersionSummary(
  packageName: string,
): Promise<
  Pick<
    ModuleRuntimeVersions,
    | "dashboardLatestPypi"
    | "dashboardLatestStablePypi"
    | "dashboardLatestPrereleasePypi"
  >
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://pypi.org/pypi/${packageName}/json`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {};
    }
    const data = (await response.json()) as {
      info?: { version?: unknown };
      releases?: Record<string, unknown>;
    };
    const latestPypi =
      typeof data.info?.version === "string" ? data.info.version : undefined;
    const parsed = Object.keys(data.releases ?? {})
      .map(parsePackageVersion)
      .filter((version): version is ParsedVersionTag => Boolean(version));
    const stable = parsed
      .filter((version) => !version.prerelease)
      .sort(compareParsedTags)
      .at(-1)?.tag;
    const prerelease = parsed
      .filter((version) => version.prerelease)
      .sort(compareParsedTags)
      .at(-1)?.tag;
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


export function registerAppIpc({
  paths,
  initManager,
  moduleUpdater,
  networkProxyManager,
  launcherUiSettingsManager,
  pythonDependencyManager,
  sourceSettingsManager,
  resourceLocationManager,
  serviceManager,
  logStore,
  appIconManager,
  codexPetManager,
  applyAppIcon,
  getMainWindow,
  requestQuit,
  showMainWindow,
}: RegisterAppIpcOptions): RegisteredAppIpcDisposables {
  let remoteModuleVersionsCache: ModuleRuntimeVersions = {};
  let remoteAppVersionCache: Pick<
    DesktopSnapshot,
    "appLatestTag" | "appLatestSource"
  > = {};
  let remoteModuleVersionsRefreshPromise: Promise<void> | null = null;
  let remoteVersionsInitialized = false;
  let initDependencyRefreshPromise: Promise<void> | null = null;
  let floatingMode = false;
  let miniMode = false;
  let miniRestoreBounds: Electron.Rectangle | null = null;
  let miniRestoreMaximized = false;
  let floatingBubbleExpanded = false;
  let floatingEdgeSide: "left" | "right" | null = null;
  let floatingGlassEffect = false;
  let normalBounds: Electron.Rectangle | null = null;
  let shellMaximized = false;
  let shellRestoreBounds: Electron.Rectangle | null = null;
  let resizeState: WindowResizeState | null = null;
  const maibotUpdateSelectionPath = join(
    paths.userDataRoot,
    MAIBOT_UPDATE_SELECTION_FILE,
  );
  let maiBotBackupAbortController: AbortController | null = null;

  const readManagedWindowState = (window: BrowserWindow | null): WindowState =>
    ({
      ...readWindowState(window, floatingMode, floatingEdgeSide, shellMaximized),
      isMiniMode: miniMode,
    });

  const sendWindowState = (window: BrowserWindow | null): WindowState => {
    if (window && floatingMode) {
      ensureFloatingAlwaysOnTop(window);
    }
    const state = readManagedWindowState(window);
    window?.webContents.send("desktop:window-state", state);
    return state;
  };

  const clampFloatingBounds = (
    bounds: Electron.Rectangle,
  ): Electron.Rectangle => {
    const display = screen.getDisplayMatching(bounds);
    const workArea = display.workArea;
    return {
      x: Math.min(
        Math.max(bounds.x, workArea.x),
        workArea.x + workArea.width - bounds.width,
      ),
      y: Math.min(
        Math.max(bounds.y, workArea.y),
        workArea.y + workArea.height - bounds.height,
      ),
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
      x: Math.round(
        display.workArea.x + display.workArea.width - size.width - 18,
      ),
      y: Math.round(
        display.workArea.y + display.workArea.height - size.height - 18,
      ),
      width: size.width,
      height: size.height,
    };
  };

  const isFloatingGlassCollapsed = (): boolean =>
    floatingMode &&
    floatingGlassEffect &&
    !floatingBubbleExpanded &&
    !floatingEdgeSide;

  const activeFloatingSize = (): { width: number; height: number } =>
    floatingEdgeSide
      ? FLOATING_STRIP_SIZE
      : floatingBubbleExpanded
          ? FLOATING_BUBBLE_SIZE
          : isFloatingGlassCollapsed()
            ? FLOATING_GLASS_SIZE
            : FLOATING_BALL_SIZE;

  const withActiveFloatingSize = (
    bounds: Electron.Rectangle,
  ): Electron.Rectangle => {
    const size = activeFloatingSize();
    return {
      x: bounds.x,
      y: bounds.y,
      width: size.width,
      height: size.height,
    };
  };

  const restoreNormalWindowChrome = (window: BrowserWindow): void => {
    applyFloatingBackgroundMaterial(window, false);
    window.setResizable(false);
    window.setMaximizable(true);
    window.setMinimumSize(
      miniMode ? 1 : NORMAL_MINIMUM_SIZE.width,
      miniMode ? 1 : NORMAL_MINIMUM_SIZE.height,
    );
  };

  const applyFloatingBackgroundMaterial = (
    window: BrowserWindow,
    enabled: boolean,
  ): void => {
    if (process.platform !== "win32" || typeof window.setBackgroundMaterial !== "function") {
      window.setBackgroundColor(TRANSPARENT_WINDOW_BACKGROUND);
      return;
    }
    try {
      window.setBackgroundMaterial(enabled ? "acrylic" : "none");
    } catch {
      // Older Windows builds can reject acrylic even when Electron exposes the API.
    } finally {
      window.setBackgroundColor(TRANSPARENT_WINDOW_BACKGROUND);
    }
  };

  const ensureFloatingAlwaysOnTop = (window: BrowserWindow): void => {
    if (!floatingMode || window.isDestroyed()) {
      return;
    }
    window.setAlwaysOnTop(true, "screen-saver");
    window.moveTop();
  };

  const syncFloatingBackgroundMaterial = (window: BrowserWindow): void => {
    applyFloatingBackgroundMaterial(window, isFloatingGlassCollapsed());
    ensureFloatingAlwaysOnTop(window);
  };

  const resizeFloatingToActiveSize = (
    window: BrowserWindow,
    animate: boolean,
  ): void => {
    const currentBounds = window.getBounds();
    const size = activeFloatingSize();
    window.setBounds(
      clampFloatingBounds({
        x: Math.round(currentBounds.x + (currentBounds.width - size.width) / 2),
        y: Math.round(
          currentBounds.y + (currentBounds.height - size.height) / 2,
        ),
        width: size.width,
        height: size.height,
      }),
      animate,
    );
  };

  const clampNormalBounds = (
    bounds: Electron.Rectangle,
  ): Electron.Rectangle => {
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(
      Math.max(bounds.width, NORMAL_MINIMUM_SIZE.width),
      workArea.width,
    );
    const height = Math.min(
      Math.max(bounds.height, NORMAL_MINIMUM_SIZE.height),
      workArea.height,
    );
    return {
      x: Math.round(
        Math.min(
          Math.max(bounds.x, workArea.x),
          workArea.x + workArea.width - width,
        ),
      ),
      y: Math.round(
        Math.min(
          Math.max(bounds.y, workArea.y),
          workArea.y + workArea.height - height,
        ),
      ),
      width: Math.round(width),
      height: Math.round(height),
    };
  };

  const fallbackNormalBounds = (window: BrowserWindow): Electron.Rectangle => {
    const workArea = getWindowWorkAreaBounds(window);
    const width = Math.min(
      Math.max(
        NORMAL_MINIMUM_SIZE.width,
        Math.min(
          NORMAL_DEFAULT_SIZE.width,
          workArea.width - NORMAL_RESTORE_MARGIN * 2,
        ),
      ),
      workArea.width,
    );
    const height = Math.min(
      Math.max(
        NORMAL_MINIMUM_SIZE.height,
        Math.min(
          NORMAL_DEFAULT_SIZE.height,
          workArea.height - NORMAL_RESTORE_MARGIN * 2,
        ),
      ),
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
    if (
      floatingMode || miniMode ||
      isShellWindowMaximized(window) ||
      window.isFullScreen() ||
      !WINDOW_RESIZE_EDGES.has(edge)
    ) {
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
    if (
      !resizeState ||
      floatingMode || miniMode ||
      isShellWindowMaximized(window) ||
      window.isFullScreen()
    ) {
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
      floatingBubbleExpanded = false;
      floatingEdgeSide = null;
      window.setMinimumSize(1, 1);
      window.setResizable(false);
      ensureFloatingAlwaysOnTop(window);
      syncFloatingBackgroundMaterial(window);
      window.setBounds(floatingBounds(window, FLOATING_BALL_SIZE), true);
      window.show();
      window.focus();
      return sendWindowState(window);
    }

    if (!enabled) {
      resizeState = null;
      const shouldRestoreBounds = floatingMode;
      floatingMode = false;
      floatingBubbleExpanded = false;
      floatingEdgeSide = null;
      syncFloatingBackgroundMaterial(window);
      window.setAlwaysOnTop(false);
      restoreNormalWindowChrome(window);
      if (shouldRestoreBounds) {
        window.setBounds(
          normalBounds ?? { x: 80, y: 80, ...NORMAL_DEFAULT_SIZE },
          true,
        );
      }
      normalBounds = null;
      window.show();
      window.focus();
      return sendWindowState(window);
    }

    return sendWindowState(window);
  };

  const applyMiniMode = (enabled: boolean): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return readManagedWindowState(window);
    if (floatingMode) applyFloatingMode(false);
    if (miniMode === enabled) return sendWindowState(window);
    resizeState = null;
    if (enabled) {
      miniRestoreMaximized = isShellWindowMaximized(window);
      miniRestoreBounds = miniRestoreMaximized ? getShellRestoreBounds(window) : window.getBounds();
      shellMaximized = false;
      shellRestoreBounds = null;
      if (window.isFullScreen()) window.setFullScreen(false);
      if (window.isMaximized()) window.unmaximize();
      miniMode = true;
      restoreNormalWindowChrome(window);
      window.setBounds(getMiniWindowBounds(getWindowWorkAreaBounds(window)));
    } else {
      miniMode = false;
      restoreNormalWindowChrome(window);
      window.setBounds(clampNormalBounds(miniRestoreBounds ?? fallbackNormalBounds(window)));
      if (miniRestoreMaximized) maximizeShellWindow(window);
      miniRestoreBounds = null;
      miniRestoreMaximized = false;
    }
    window.show();
    return sendWindowState(window);
  };

  const applyFloatingGlassEffect = (enabled: boolean): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readManagedWindowState(window);
    }
    floatingGlassEffect = enabled;
    if (floatingMode && !floatingEdgeSide) {
      resizeFloatingToActiveSize(window, true);
    }
    syncFloatingBackgroundMaterial(window);
    ensureFloatingAlwaysOnTop(window);
    return sendWindowState(window);
  };

  const applyFloatingBubbleExpanded = (expanded: boolean): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readManagedWindowState(window);
    }
    if (!floatingMode) {
      return sendWindowState(window);
    }
    if (floatingBubbleExpanded === expanded) {
      return sendWindowState(window);
    }
    floatingBubbleExpanded = expanded;
    if (expanded) {
      floatingEdgeSide = null;
    }
    resizeFloatingToActiveSize(window, true);
    syncFloatingBackgroundMaterial(window);
    ensureFloatingAlwaysOnTop(window);
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
      const nextSize = activeFloatingSize();
      const undockedBounds = {
        x:
          previousEdgeSide === "left"
            ? currentBounds.x
            : currentBounds.x + currentBounds.width - nextSize.width,
        y: currentBounds.y,
        width: nextSize.width,
        height: nextSize.height,
      };
      window.setBounds(clampFloatingBounds(undockedBounds), false);
      syncFloatingBackgroundMaterial(window);
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
      const nextSize = activeFloatingSize();
      window.setBounds(
        clampFloatingBounds({
          x: currentBounds.x,
          y: currentBounds.y,
          width: nextSize.width,
          height: nextSize.height,
        }),
        false,
      );
      syncFloatingBackgroundMaterial(window);
    }

    const size = activeFloatingSize();
    const cursorPoint = screen.getCursorScreenPoint();
    const safeOffsetX = wasEdgeDocked
      ? Math.round(size.width / 2)
      : Math.min(Math.max(Math.round(offsetX), 0), size.width);
    const safeOffsetY = wasEdgeDocked
      ? Math.round(size.height / 2)
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
    const isNearLeft =
      currentBounds.x <= workArea.x + FLOATING_EDGE_SNAP_DISTANCE;
    const isNearRight =
      currentBounds.x + currentBounds.width >=
      workArea.x + workArea.width - FLOATING_EDGE_SNAP_DISTANCE;

    if (isNearLeft || isNearRight) {
      floatingEdgeSide = isNearLeft ? "left" : "right";
      const x =
        floatingEdgeSide === "left"
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
      syncFloatingBackgroundMaterial(window);
      return sendWindowState(window);
    }

    floatingEdgeSide = null;
    window.setBounds(
      clampFloatingBounds(withActiveFloatingSize(currentBounds)),
      true,
    );
    syncFloatingBackgroundMaterial(window);
    ensureFloatingAlwaysOnTop(window);
    return sendWindowState(window);
  };

  const readLocalModuleVersions = async (): Promise<ModuleRuntimeVersions> => {
    const versions: ModuleRuntimeVersions = {};
    const maibotRoot = paths.maibotRoot;

    const deployment = readMaiBotDeployment(maibotRoot);
    versions.maibotDeploymentMode = moduleUpdater.isPackageMode() ? "pypi" : "source";
    versions.maibotCanRollback = Boolean(deployment?.previous && deployment.snapshot);

    const pyprojectVersion = await readPyprojectVersion(
      join(maibotRoot, "pyproject.toml"),
    );
    if (deployment) {
      versions.maibotLocal = await readPythonDistInfoVersion(pythonDependencyManager.getPythonPackagesRoot(), "maibot");
      versions.maibotLocalSource = "pypi";
      versions.maibotSelectedTarget = { type: "package", name: deployment.packageVersion };
      versions.maibotSelectedAt = deployment.installedAt;
      versions.maibotSelectedChannel = deployment.packageVersion === remoteModuleVersionsCache.maibotLatestStableTag ? "stable" : "custom";
    } else if (pyprojectVersion) {
      versions.maibotLocal = pyprojectVersion;
      versions.maibotLocalSource = "pyproject";
    }

    const dashboardVersion = await readPythonDistInfoVersion(
      pythonDependencyManager.getPythonPackagesRoot(),
      "maibot-dashboard",
    );
    if (dashboardVersion) {
      versions.dashboardPythonEnv = dashboardVersion;
      versions.dashboardPythonEnvSource = "python-env";
    }

    return versions;
  };

  const readRemoteModuleVersions = async (): Promise<ModuleRuntimeVersions> => {
    const versions: ModuleRuntimeVersions = {};
    try {
      const packages = await moduleUpdater.listMaiBotPackageVersions();
      for (const line of packages.output) logStore.append("desktop", "system", line);
      versions.maibotLatestStableTag = packages.versions.find((item) => !item.isPrerelease)?.version;
      versions.maibotLatestPrereleaseTag = packages.versions.find((item) => item.isPrerelease)?.version;
      versions.maibotRemoteSource = packages.sourceUrl;
      if (!versions.maibotLatestStableTag) versions.maibotRemoteError = "未找到可安装的 MaiBot 正式包";
    } catch (error) { versions.maibotRemoteError = String(error); }

    const dashboardVersions = await fetchPypiVersionSummary("maibot-dashboard");
    if (
      dashboardVersions.dashboardLatestPypi ||
      dashboardVersions.dashboardLatestStablePypi ||
      dashboardVersions.dashboardLatestPrereleasePypi
    ) {
      Object.assign(versions, dashboardVersions);
      versions.dashboardPypiSource = "PyPI";
    }

    return versions;
  };

  const readRemoteAppVersion = async (): Promise<
    Pick<DesktopSnapshot, "appLatestTag" | "appLatestSource">
  > => {
    try {
      const update = await fetchLauncherUpdateInfo(app.getVersion());
      return { appLatestTag: update.latestTag, appLatestSource: update.source };
    } catch {
      return {};
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

  let longPathRepairPrompt: Promise<void> | undefined;
  const offerLongPathRepair = async (): Promise<void> => {
    const show = (options: Electron.MessageBoxOptions) => {
      const window = getMainWindow();
      return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
    };
    if (await windowsLongPathsEnabled().catch(() => false)) {
      await show({ type: "info", title: "Windows 长路径支持", message: "系统已开启长路径支持", detail: "请保存工作并重启 Windows 后重新安装。若重启后仍然失败，请将实例迁移到更短的目录，并提供完整错误日志。", buttons: ["知道了"] });
      return;
    }
    const result = await show({ type: "warning", title: "安装路径过长", message: "是否开启 Windows 长路径支持？", detail: "安装依赖时文件路径超过了系统限制。开启将修改系统设置，随后 Windows 会请求管理员授权。完成后建议重启电脑，再重新安装。", buttons: ["开启长路径支持", "暂不开启"], defaultId: 0, cancelId: 1, noLink: true });
    if (result.response !== 0) return;
    try {
      await enableWindowsLongPaths();
      await show({ type: "info", title: "已开启长路径支持", message: "Windows 长路径支持已开启", detail: "请保存工作并重启 Windows，之后回到启动器重新安装。", buttons: ["知道了"] });
    } catch {
      await show({ type: "warning", title: "未能开启长路径支持", message: "设置未完成或管理员授权被取消", detail: "请重试并允许 Windows 管理员授权；如果电脑由组织管理，请联系管理员开启长路径支持。", buttons: ["知道了"] });
    }
  };
  const withLongPathRepair = async <T,>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (process.platform === "win32" && isWindowsLongPathError(error)) {
        longPathRepairPrompt ??= offerLongPathRepair().finally(() => { longPathRepairPrompt = undefined; });
        // Preserve the install error even if displaying the repair dialog fails.
        await longPathRepairPrompt.catch(() => undefined);
      }
      throw error;
    }
  };
  const handleRuntimeMutation: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => withLongPathRepair(() => resourceLocationManager.withRuntimeActivity(async () => listener(event, ...args))));
  };
  const handleDeploymentMutation: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => withLongPathRepair(() => resourceLocationManager.withDeploymentOperation(async () => listener(event, ...args))));
  };

  const buildSnapshot = async (
    options: { refreshDependencies?: boolean } = {},
  ): Promise<DesktopSnapshot> => ({
    paths,
    runtimeOperation: resourceLocationManager.getOperationLabel(),
    services: serviceManager.snapshot(),
    serviceCommands: await serviceManager.getCommandConfigs(),
    runtimeResourcePathConfigs: resourceLocationManager.getPathConfigs(),
    terminalSettings: serviceManager.getTerminalSettings(),
    serviceStartupSettings: serviceManager.getStartupSettings(),
    launcherUiSettings: launcherUiSettingsManager.getSettings(),
    appIconSettings: appIconManager.getSettings(),
    codexPetSettings: await codexPetManager.getSettings(),
    networkProxySettings: networkProxyManager.getSettings(),
    appVersion: app.getVersion(),
    appLatestTag: remoteAppVersionCache.appLatestTag,
    appLatestSource: remoteAppVersionCache.appLatestSource,
    moduleVersions: await readModuleVersions(),
    platform: process.platform,
    windowState: readManagedWindowState(getMainWindow()),
    initState: await initManager.getState({
      refreshDependencies: options.refreshDependencies ?? false,
    }),
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
    // Local status polling must not repeatedly query external update services.
    if (remoteVersionsInitialized || remoteModuleVersionsRefreshPromise) {
      return;
    }
    remoteVersionsInitialized = true;
    remoteModuleVersionsRefreshPromise = Promise.all([
      readRemoteModuleVersions(),
      readRemoteAppVersion(),
    ])
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

  const refreshRemoteVersionsNow = async (): Promise<DesktopSnapshot> => {
    remoteVersionsInitialized = true;
    if (remoteModuleVersionsRefreshPromise) {
      await remoteModuleVersionsRefreshPromise;
    } else {
      const [versions, appVersion] = await Promise.all([
        readRemoteModuleVersions(),
        readRemoteAppVersion(),
      ]);
      remoteModuleVersionsCache = versions;
      remoteAppVersionCache = appVersion;
    }
    const snapshot = await buildSnapshot();
    const window = getMainWindow();
    window?.webContents.send("desktop:snapshot", snapshot);
    return snapshot;
  };

  const scheduleInitDependencyRefresh = (): void => {
    if (initDependencyRefreshPromise) {
      return;
    }
    initDependencyRefreshPromise = initManager
      .refreshDependencyChecks()
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

  const mutateQqBackendSafely = async <T>(
    requestedBackend: QqBackend,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const currentInitState = await initManager.getState();
    const switchingBackend = requestedBackend !== currentInitState.qqBackend;
    await serviceManager.refresh();
    const runtimeServices = serviceManager.snapshot();
    const qqBackendService = runtimeServices.find((service) => service.id === "napcat");

    if (switchingBackend && qqBackendService && isRuntimeBusy(qqBackendService)) {
      throw new Error("请先停止当前 QQ 后端，再切换 NapCat / SnowLuma。");
    }

    let operationCompleted = false;
    try {
      const result = await operation();
      operationCompleted = true;
      serviceManager.reloadRuntimePaths();
      return result;
    } catch (error) {
      if (switchingBackend && !operationCompleted) {
        try {
          await initManager.setQqBackend(currentInitState.qqBackend);
          serviceManager.reloadRuntimePaths();
        } catch (rollbackError) {
          logStore.append(
            "desktop",
            "stderr",
            `QQ 后端切换失败后回滚未完成: ${String(rollbackError)}`,
          );
        }
      }
      await broadcastSnapshot();
      throw error;
    }
  };

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
      throw new Error(
        `请先停止服务，再调整覆盖路径：${active.map((service) => service.name).join(", ")}`,
      );
    }
  };

  resourceLocationManager.setApplyHandler(async () => {
    initManager.clearDependencyCache();
    serviceManager.reloadRuntimePaths();
  });
  const onResourceOperation = (): void => { void broadcastSnapshot().catch((error) => logStore.append("desktop", "system", `目录操作状态刷新失败: ${String(error)}`)); };
  const onResourceProgress = (progress: ResourcePathProgress): void => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send("resources:progress", progress);
  };
  resourceLocationManager.on("operation-change", onResourceOperation);
  resourceLocationManager.on("progress", onResourceProgress);

  const resetLauncherStores = async (): Promise<void> => {
    for (const service of serviceManager.snapshot()) {
      await serviceManager.resetCommandConfig(service.id);
    }
    await serviceManager.saveTerminalSettings({
      ...serviceManager.getTerminalSettings(),
      useEmbeddedTerminal: true,
    });
    await serviceManager.saveStartupSettings(defaultServiceStartupSettings());
    await networkProxyManager.resetSettings();
    await launcherUiSettingsManager.resetSettings();
    appIconManager.reset();
    applyAppIcon();

    for (const key of ["maibot", "napcat", "snowluma"] as const) {
      const config = resourceLocationManager
        .getPathConfigs()
        .find((item) => item.key === key);
      if (config?.customized) {
        await resourceLocationManager.resetPath(key);
      }
    }

    initManager.clearDependencyCache();
    serviceManager.reloadRuntimePaths();
  };

  const resetLauncherSettings = async (): Promise<LauncherResetResult> => {
    assertServicesStoppedForResourceMove();
    await resetLauncherStores();

    const removedEntries: string[] = [];
    for (const fileName of LAUNCHER_SETTING_FILES) {
      removedEntries.push(
        ...(await removeExistingPath(join(paths.userDataRoot, fileName))),
      );
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
    if (
      samePath(root, paths.installRoot) ||
      isPathInside(root, paths.installRoot)
    ) {
      throw new Error(
        "Refusing to reset all because the target path contains the install root.",
      );
    }
    if (
      !samePath(root, paths.userDataRoot) &&
      !isPathInside(paths.userDataRoot, root)
    ) {
      throw new Error(
        "Refusing to reset all because the target path is outside the user data root.",
      );
    }

    await resetLauncherStores();
    const resetEntries = samePath(root, paths.userDataRoot)
      ? [...LAUNCHER_RUNTIME_DIRECTORIES, ...LAUNCHER_SETTING_FILES]
      : undefined;
    const removedEntries = await clearDirectoryContents(root, resetEntries);
    await mkdir(paths.logsRoot, { recursive: true });
    initManager.clearDependencyCache();
    serviceManager.reloadRuntimePaths();
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

  ipcMain.handle(
    "desktop:getSystemPerformance",
    (): SystemPerformanceSnapshot => {
      return readSystemPerformance();
    },
  );

  ipcMain.handle(
    "desktop:openExternal",
    async (_event, url: string): Promise<void> => {
      await shell.openExternal(url);
    },
  );

  ipcMain.handle(
    "desktop:openPath",
    async (_event, path: string): Promise<void> => {
      await shell.openPath(path);
    },
  );

  ipcMain.handle("desktop:clearWebviewCache", async (): Promise<void> => {
    const webviewSession = session.fromPartition(MAIBOT_WEBVIEW_PARTITION);
    await webviewSession.clearCache();
    await webviewSession.clearStorageData({
      storages: ["cachestorage", "serviceworkers"],
    });
  });

  ipcMain.handle("init:getState", async (): Promise<InitState> => {
    return initManager.getState({ refreshDependencies: true });
  });

  ipcMain.handle("init:getMaiBotSetupStatus", () => initManager.getMaiBotSetupStatus());

  handleRuntimeMutation("adapters:syncQqConnections", async (): Promise<InitRepairResult> => {
    await serviceManager.refresh();
    const result = await initManager.syncQqConnections();
    logStore.append("desktop", "system", "已通过 MaiBot API 同步适配器连接配置");
    await broadcastSnapshot();
    return result;
  });

  handleRuntimeMutation("init:repair", async (event): Promise<InitRepairResult> => {
    const result = await initManager.repair((progress) => {
      logStore.append("maibot", "system", `MaiBot preparation: ${progress.log ?? progress.label}`);
      if (!event.sender.isDestroyed()) event.sender.send("modules:maibot-update-progress", progress);
    });
    logStore.append(
      "desktop",
      "system",
      `Initialization repair changed ${result.changedFiles.length} files.`,
    );
    await broadcastSnapshot();
    return result;
  });

  handleRuntimeMutation(
    "protocols:resetSnowLuma",
    async (): Promise<SnowLumaResetResult> => {
      await serviceManager.refresh();
      if (serviceManager.snapshot().some((service) => service.id === "napcat" && isRuntimeBusy(service))) {
        throw new Error(
          "Stop QQ backend before resetting SnowLuma.",
        );
      }

      const result = await initManager.resetSnowLumaComponent();
      serviceManager.reloadRuntimePaths();
      logStore.append(
        "desktop",
        "system",
        `SnowLuma 组件已重置: ${result.snowlumaRoot}`,
      );
      await broadcastSnapshot();
      return result;
    },
  );

  handleRuntimeMutation(
    "protocols:upgradeQqComponents",
    async (): Promise<QqComponentUpgradeResult> => {
      await serviceManager.refresh();
      if (serviceManager.snapshot().some((service) => service.id === "napcat" && isRuntimeBusy(service))) {
        throw new Error(
          "Stop QQ backend before upgrading NapCat / SnowLuma.",
        );
      }

      const result = await initManager.upgradeQqComponents();
      serviceManager.reloadRuntimePaths();
      const summary = result.components
        .map(
          (component) =>
            `${component.name}${component.skipped ? " skipped" : ` preserved ${component.preservedEntries.length}`}`,
        )
        .join(", ");
      logStore.append(
        "desktop",
        "system",
        `QQ backend components upgraded: ${summary}`,
      );
      await broadcastSnapshot();
      return result;
    },
  );

  handleRuntimeMutation("adapters:setQqProtocol", async (_event, protocol: "napcat" | "snowluma" | "official", options?: import("../../shared/contracts").QqProtocolOptions): Promise<InitState> => {
    if (!["napcat", "snowluma", "official"].includes(protocol)) throw new Error("Unsupported QQ protocol.");
    await serviceManager.refresh();
    const backendService = serviceManager.snapshot().find((service) => service.id === "napcat");
    if (protocol !== "official" && protocol !== initManager.getQqProtocolSync() && backendService && isRuntimeBusy(backendService)) {
      throw new Error("请先停止当前 QQ 协议端，再切换。");
    }
    if (protocol === "official") {
      await initManager.setQqProtocol(protocol, options);
    } else {
      await mutateQqBackendSafely(protocol, () => initManager.setQqProtocol(protocol));
    }
    await broadcastSnapshot();
    return initManager.getState();
  });

  handleRuntimeMutation("adapters:setEnabled", async (_event, adapter: "onebot" | "official", enabled: boolean): Promise<void> => {
    await initManager.adapters.setEnabled(adapter, enabled);
    await broadcastSnapshot();
  });

  ipcMain.handle("protocols:getLoginInfo", async () => {
    const accounts = initManager.getQqBackendAccounts();
    const tokens = await serviceManager.readQqWebuiTokens();
    return {
      napcat: { qqAccount: accounts.napcat, webuiToken: tokens.napcat },
      snowluma: { qqAccount: accounts.snowluma, webuiToken: tokens.snowluma },
    };
  });

  handleRuntimeMutation("protocols:saveQqBackendAccount", async (_event, backend: QqBackend, account: string) => {
    await serviceManager.refresh();
    const service = serviceManager.snapshot().find((item) => item.id === "napcat");
    if (backend === initManager.getQqBackendSync() && service && isRuntimeBusy(service)) {
      throw new Error("请先停止当前 QQ 协议端，再修改 QQ 账号。");
    }
    await initManager.saveQqBackendAccount(backend, account);
    await broadcastSnapshot();
  });

  handleRuntimeMutation("protocols:saveSnowLumaWebuiPassword", async (_event, password: string) => {
    await serviceManager.saveSnowLumaWebuiPassword(password);
    await broadcastSnapshot();
  });

  handleRuntimeMutation(
    "protocols:setQqBackend",
    async (_event, backend: QqBackend): Promise<InitState> => {
      if (backend !== "napcat" && backend !== "snowluma") {
        throw new Error("Unsupported QQ backend.");
      }
      await mutateQqBackendSafely(
        backend,
        () => initManager.setQqBackend(backend),
      );
      const state = await initManager.getState();
      logStore.append(
        "desktop",
        "system",
        `QQ 后端已切换为: ${backend === "snowluma" ? "SnowLuma" : "NapCat"}`,
      );
      await broadcastSnapshot();
      return state;
    },
  );

  handleRuntimeMutation(
    "protocols:setQqAccount",
    async (_event, request: QqAccountSetupRequest): Promise<InitState> => {
      const currentInitState = await initManager.getState();
      const requestedBackend = request.qqBackend ?? currentInitState.qqBackend;
      const state = await mutateQqBackendSafely(
        requestedBackend,
        () => initManager.setQqAccount(
          request.qqAccount,
          request.websocketToken,
          request.qqBackend,
        ),
      );
      logStore.append(
        "desktop",
        "system",
        request.qqAccount ? `机器人 QQ 号已配置: ${request.qqAccount}` : "SnowLuma 消息平台已配置，QQ 号由客户端登录确定",
      );
      await broadcastSnapshot();
      return state;
    },
  );

  ipcMain.handle(
    "agreements:getState",
    async (): Promise<StartupAgreementState> => {
      return initManager.getAgreementState();
    },
  );

  ipcMain.handle(
    "agreements:confirm",
    async (): Promise<StartupAgreementConfirmResult> => {
      const result = await initManager.confirmAgreements();
      logStore.append(
        "desktop",
        "system",
        `Startup agreements confirmed, changed ${result.changedFiles.length} files.`,
      );
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle(
    "modules:checkMaibotUpdate",
    async (_event, target: ModuleUpdateTarget): Promise<MaiBotUpdateInfo> => {
      if (!target || typeof target.name !== "string" || !target.name.trim()) {
        throw new Error("没有可用的 MaiBot 目标版本");
      }
      if (target.type !== "package") {
        throw new Error("MaiBot 目标版本类型不正确");
      }

      const localVersions = await readLocalModuleVersions();
      return fetchMaiBotUpdateInfo(localVersions.maibotLocal, {
        type: target.type,
        name: target.name.trim(),
      });
    },
  );

  handleDeploymentMutation(
    "modules:updateMaibot",
    async (
      event,
      target?: ModuleUpdateTarget,
    ): Promise<ModuleUpdateResult> => {
      target ??= resolveMaiBotUpdateTarget("stable", remoteModuleVersionsCache.maibotLatestStableTag, undefined);
      if (!target || target.type !== "package" || typeof target.name !== "string" || !target.name.trim()) {
        throw new Error("没有可用的 MaiBot 更新目标，请先获取 PyPI 包版本；旧源码实例可迁移到 PyPI");
      }
      target = { type: target.type, name: target.name.trim() };
      const maibot = serviceManager
        .snapshot()
        .find((service) => service.id === "maibot");
      if (
        maibot?.managed ||
        maibot?.status === "starting" ||
        maibot?.status === "running" ||
        maibot?.status === "stopping"
      ) {
        throw new Error("Stop MaiBot Core before updating MaiBot.");
      }

      logStore.append("desktop", "system", "Updating MaiBot from PyPI.");
      const sendProgress = (progress: MaiBotModuleUpdateProgress): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("modules:maibot-update-progress", progress);
        }
      };
      const result = await moduleUpdater.updateMaiBot(target, sendProgress);
      initManager.clearDependencyCache();
      serviceManager.reloadRuntimePaths();
      // The deployment record is authoritative. Discard legacy tag/branch/dev selections.
      await rm(maibotUpdateSelectionPath, { force: true }).catch(() => undefined);
      logStore.append(
        "desktop",
        "system",
        `MaiBot update finished: ${result.before ?? "-"} -> ${result.after ?? "-"} (${result.changed ? "changed" : "unchanged"})`,
      );
      await broadcastSnapshot();
      return result;
    },
  );

  handleDeploymentMutation("modules:rollbackMaibot", async (): Promise<void> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || (maibot && ["starting", "running", "stopping"].includes(maibot.status))) throw new Error("请先停止 MaiBot，再恢复上一环境");
    await moduleUpdater.rollbackMaiBot();
    await rm(maibotUpdateSelectionPath, { force: true });
    initManager.clearDependencyCache();
    serviceManager.reloadRuntimePaths();
    await broadcastSnapshot();
  });

  ipcMain.handle(
    "modules:refreshVersions",
    async (): Promise<DesktopSnapshot> => {
      return refreshRemoteVersionsNow();
    },
  );

  ipcMain.handle(
    "modules:listMaibotTags",
    async (): Promise<ModuleTagOption[]> => {
      return moduleUpdater.listMaiBotTags();
    },
  );

  ipcMain.handle(
    "data:cancelMaibotBackupOperation",
    async (): Promise<boolean> => {
      if (!maiBotBackupAbortController) {
        return false;
      }
      maiBotBackupAbortController.abort();
      return true;
    },
  );

  handleRuntimeMutation(
    "data:exportMaibotBackup",
    async (event): Promise<MaiBotBackupExportResult | null> => {
      const sendProgress = (progress: MaiBotBackupProgress): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("data:maibot-backup-progress", progress);
        }
      };
      const maibot = serviceManager
        .snapshot()
        .find((service) => service.id === "maibot");
      if (
        maibot?.managed ||
        maibot?.status === "starting" ||
        maibot?.status === "running" ||
        maibot?.status === "stopping"
      ) {
        throw new Error("Stop MaiBot Core before exporting a backup.");
      }

      const createdAt = new Date().toISOString().replace(/[:.]/gu, "-");
      const mainWindow = getMainWindow();
      const dialogOptions: Electron.SaveDialogOptions = {
        title: "Export MaiBot backup",
        defaultPath: `MaiBot-backup-${createdAt}.maibot-backup.tar.gz`,
        filters: [
          { name: "MaiBot backup", extensions: ["tar.gz", "tgz"] },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        return null;
      }
      if (maiBotBackupAbortController) {
        throw new Error("已有 MaiBot 迁移任务正在运行。");
      }

      const controller = new AbortController();
      maiBotBackupAbortController = controller;
      try {
        const exportResult = await initManager.exportMaiBotBackup(
          result.filePath,
          app.getVersion(),
          sendProgress,
          controller.signal,
        );
        logStore.append(
          "desktop",
          "system",
          `MaiBot backup exported: ${exportResult.filePath}`,
        );
        return exportResult;
      } catch (error) {
        const cancelled = error instanceof Error && error.name === "AbortError";
        sendProgress({
          operation: "export",
          phase: cancelled ? "cancelled" : "failed",
          percent: 100,
          detail: cancelled ? "已取消导出，正在清理未完成的迁移包" : error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
        throw error;
      } finally {
        if (maiBotBackupAbortController === controller) {
          maiBotBackupAbortController = null;
        }
      }
    },
  );

  handleRuntimeMutation(
    "data:importMaibotBackup",
    async (event): Promise<MaiBotBackupImportResult | null> => {
      const sendProgress = (progress: MaiBotBackupProgress): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("data:maibot-backup-progress", progress);
        }
      };
      const maibot = serviceManager
        .snapshot()
        .find((service) => service.id === "maibot");
      if (
        maibot?.managed ||
        maibot?.status === "starting" ||
        maibot?.status === "running" ||
        maibot?.status === "stopping"
      ) {
        throw new Error("Stop MaiBot Core before importing a backup.");
      }

      const mainWindow = getMainWindow();
      const dialogOptions: Electron.OpenDialogOptions = {
        title: "Import MaiBot backup",
        properties: ["openFile"],
        filters: [
          { name: "MaiBot backup", extensions: ["tar.gz", "tgz"] },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      if (maiBotBackupAbortController) {
        throw new Error("已有 MaiBot 迁移任务正在运行。");
      }

      const controller = new AbortController();
      maiBotBackupAbortController = controller;
      try {
        const importResult = await initManager.importMaiBotBackup(
          result.filePaths[0],
          sendProgress,
          controller.signal,
        );
        logStore.append(
          "desktop",
          "system",
          `MaiBot backup imported: ${importResult.sourcePath}`,
        );
        await broadcastSnapshot();
        return importResult;
      } catch (error) {
        const cancelled = error instanceof Error && error.name === "AbortError";
        sendProgress({
          operation: "import",
          phase: cancelled ? "cancelled" : "failed",
          percent: 100,
          detail: cancelled ? "已取消导入，必要时已回退原 data/config 目录" : error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
        throw error;
      } finally {
        if (maiBotBackupAbortController === controller) {
          maiBotBackupAbortController = null;
        }
      }
    },
  );

  handleRuntimeMutation(
    "data:importMaibotDb",
    async (): Promise<MaiBotDataImportResult | null> => {
      const maibot = serviceManager
        .snapshot()
        .find((service) => service.id === "maibot");
      if (
        maibot?.managed ||
        maibot?.status === "starting" ||
        maibot?.status === "running" ||
        maibot?.status === "stopping"
      ) {
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

      const importResult = await initManager.importMaiBotDatabase(
        result.filePaths[0],
      );
      logStore.append(
        "desktop",
        "system",
        `MaiBot.db imported: ${importResult.sourcePath} -> ${importResult.destPath}`,
      );
      await broadcastSnapshot();
      return importResult;
    },
  );

  handleRuntimeMutation(
    "data:importMaibotConfig",
    async (
      _event,
      fileName: MaiBotConfigFileName,
    ): Promise<MaiBotConfigImportResult | null> => {
      const maibot = serviceManager
        .snapshot()
        .find((service) => service.id === "maibot");
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

      const importResult = await initManager.importMaiBotConfig(
        fileName,
        result.filePaths[0],
      );
      logStore.append(
        "desktop",
        "system",
        `MaiBot ${fileName} imported: ${importResult.sourcePath} -> ${importResult.destPath}`,
      );
      await broadcastSnapshot();
      return importResult;
    },
  );

  ipcMain.handle(
    "data:getMaibotStorageStats",
    async (): Promise<MaiBotStorageStats> => {
      return initManager.getMaiBotStorageStats();
    },
  );

  handleRuntimeMutation(
    "data:cleanupMaibotStorage",
    async (
      _event,
      target: MaiBotStorageCleanupTarget,
    ): Promise<MaiBotStorageCleanupResult> => {
      const maibot = serviceManager
        .snapshot()
        .find((service) => service.id === "maibot");
      if (
        maibot?.managed ||
        maibot?.status === "starting" ||
        maibot?.status === "running" ||
        maibot?.status === "stopping"
      ) {
        throw new Error("Stop MaiBot Core before cleaning local data.");
      }

      const result = await initManager.cleanupMaiBotStorage(target);
      logStore.append(
        "desktop",
        "system",
        `MaiBot storage cleanup ${target}: ${result.removedEntries.length} entries, ${result.removedBytes} bytes`,
      );
      await broadcastSnapshot();
      return result;
    },
  );

  handleRuntimeMutation(
    "data:resetMaibotData",
    async (): Promise<MaiBotDataResetResult> => {
      const maibot = serviceManager
        .snapshot()
        .find((service) => service.id === "maibot");
      if (
        maibot?.managed ||
        maibot?.status === "starting" ||
        maibot?.status === "running" ||
        maibot?.status === "stopping"
      ) {
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
    },
  );

  ipcMain.handle(
    "launcher:resetSettings",
    async (): Promise<LauncherResetResult> => {
      return resourceLocationManager.withPathOperation(() => resetLauncherSettings());
    },
  );

  ipcMain.handle(
    "launcher:resetAll",
    async (): Promise<LauncherResetResult> => {
      return resourceLocationManager.withPathOperation(() => resetLauncherAll());
    },
  );

  ipcMain.handle(
    "launcher:saveNetworkProxySettings",
    async (
      _event,
      settings: NetworkProxySettings,
    ): Promise<NetworkProxySettings> => {
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
    "launcher:saveUiSettings",
    async (
      _event,
      settings: LauncherUiSettings,
    ): Promise<LauncherUiSettings> => {
      const result = await launcherUiSettingsManager.saveSettings(settings);
      logStore.append(
        "desktop",
        "system",
        "启动器界面设置已保存",
      );
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle("launcher:getSourceSettings", (): SourceSettings => {
    return sourceSettingsManager.getSettings();
  });

  ipcMain.handle(
    "launcher:saveSourceSettings",
    async (_event, settings: SourceSettingsUpdate): Promise<SourceSettings> => {
      const result = await sourceSettingsManager.saveSettings(settings);
      logStore.append(
        "desktop",
        "system",
        `Source settings saved: python=${result.python.length}`,
      );
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle(
    "launcher:resetSourceSettings",
    async (): Promise<SourceSettings> => {
      const result = await sourceSettingsManager.resetSettings();
      logStore.append(
        "desktop",
        "system",
        `Source settings reset to defaults: python=${result.python.length}`,
      );
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle(
    "launcher:selectAppIcon",
    async (_event, iconId: AppIconId): Promise<AppIconSettings> => {
      const result = await appIconManager.select(iconId);
      applyAppIcon();
      return result;
    },
  );

  ipcMain.handle(
    "launcher:checkUpdate",
    async (): Promise<LauncherUpdateInfo> => {
      return publicLauncherUpdateInfo(await checkLauncherUpdate());
    },
  );

  ipcMain.handle(
    "launcher:downloadAndInstallUpdate",
    async (event): Promise<LauncherUpdateApplyResult> => {
      const sendProgress = (progress: LauncherUpdateDownloadProgress): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("launcher:update-download-progress", progress);
        }
      };

      sendProgress({
        phase: "checking",
        receivedBytes: 0,
      });
      await assertLauncherUpdateAllowed(serviceManager);
      const update = await checkLauncherUpdate();
      if (!update.available) {
        throw new Error(update.latestAssetUnavailable
          ? `最新版本 ${update.latestTag ?? ""} 暂无可用的${launcherUpdatePackageLabel()}`
          : "当前启动器已经是最新版本");
      }

      const download = await downloadLauncherUpdate(
        paths,
        update,
        sendProgress,
      );
      await assertLauncherUpdateAllowed(serviceManager);
      const installerPath = download.installerPath;
      let willQuit = false;
      if (process.platform === "win32") {
        const child = spawn(installerPath, [], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.unref();
        willQuit = true;
      } else {
        const openError = await shell.openPath(installerPath);
        if (openError) {
          throw new Error(`安装包打开失败：${openError}`);
        }
      }
      sendProgress({
        phase: "completed",
        assetName: update.assetName,
        receivedBytes: download.receivedBytes,
        totalBytes: download.totalBytes,
        percent: 100,
      });
      logStore.append(
        "desktop",
        "system",
        `启动器更新安装包已打开: ${installerPath}`,
      );
      if (willQuit) {
        setTimeout(() => requestQuit(), 800);
      }
      return {
        update: publicLauncherUpdateInfo(update),
        installerPath,
        started: true,
        willQuit,
      };
    },
  );

  ipcMain.handle("launcher:quit", (): void => {
    requestQuit();
  });

  ipcMain.handle("pythonDeps:getState", (): PythonEnvironmentState => {
    return pythonDependencyManager.getState();
  });

  ipcMain.handle(
    "pythonDeps:saveSourcePreset",
    async (
      _event,
      preset: PythonPackageSourcePreset,
    ): Promise<PythonEnvironmentState> => {
      const state = await pythonDependencyManager.saveSourcePreset(preset);
      await broadcastSnapshot();
      return state;
    },
  );

  ipcMain.handle(
    "pythonDeps:listVersions",
    async (
      _event,
      packageName: ManagedPythonPackageName,
    ): Promise<PythonPackageVersionList> => {
      return pythonDependencyManager.listVersions(packageName);
    },
  );

  handleDeploymentMutation(
    "pythonDeps:installVersion",
    async (
      _event,
      request: PythonPackageInstallRequest,
    ): Promise<PythonPackageInstallResult> => {
      const maibot = serviceManager
        .snapshot()
        .find((service) => service.id === "maibot");
      if (
        maibot?.managed ||
        maibot?.status === "starting" ||
        maibot?.status === "running" ||
        maibot?.status === "stopping"
      ) {
        throw new Error(
          "Stop MaiBot Core before updating Python dependencies.",
        );
      }

      logStore.append(
        "desktop",
        "system",
        `Installing Python dependency: ${request.packageName}==${request.version}`,
      );
      const result = await pythonDependencyManager.installVersion(request);
      logStore.append(
        "desktop",
        "system",
        `Python dependency installed: ${result.packageName}==${result.version} -> ${result.targetDir}`,
      );
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle(
    "services:start",
    async (_event, serviceId: ServiceId): Promise<ServiceDescriptor> => {
      const descriptor = await serviceManager.start(serviceId);
      await broadcastSnapshot();
      return descriptor;
    },
  );

  ipcMain.handle(
    "services:stop",
    async (_event, serviceId: ServiceId): Promise<ServiceDescriptor> => {
      const descriptor = await serviceManager.stop(serviceId);
      await broadcastSnapshot();
      return descriptor;
    },
  );

  ipcMain.handle(
    "services:restart",
    async (_event, serviceId: ServiceId): Promise<ServiceDescriptor> => {
      const descriptor = await serviceManager.restart(serviceId);
      await broadcastSnapshot();
      return descriptor;
    },
  );

  ipcMain.handle(
    "services:startAll",
    async (): Promise<ServiceDescriptor[]> => {
      try {
        return await serviceManager.startAll();
      } finally {
        await broadcastSnapshot();
      }
    },
  );

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

  ipcMain.handle(
    "services:saveCommandConfig",
    async (
      _event,
      config: ServiceCommandUpdate,
    ): Promise<DesktopSnapshot["serviceCommands"]> => {
      const configs = await serviceManager.saveCommandConfig(config);
      await broadcastSnapshot();
      return configs;
    },
  );

  ipcMain.handle(
    "services:resetCommandConfig",
    async (
      _event,
      serviceId: ServiceId,
    ): Promise<DesktopSnapshot["serviceCommands"]> => {
      const configs = await serviceManager.resetCommandConfig(serviceId);
      await broadcastSnapshot();
      return configs;
    },
  );

  ipcMain.handle(
    "services:saveTerminalSettings",
    async (_event, settings: TerminalSettings): Promise<TerminalSettings> => {
      const config = await serviceManager.saveTerminalSettings(settings);
      await broadcastSnapshot();
      return config;
    },
  );

  ipcMain.handle(
    "services:saveStartupSettings",
    async (
      _event,
      settings: ServiceStartupSettings,
    ): Promise<ServiceStartupSettings> => {
      const config = await serviceManager.saveStartupSettings(settings);
      logStore.append(
        "desktop",
        "system",
        config.useLocalDashboard
          ? "MaiBot Core startup will use local Dashboard build"
          : "MaiBot Core startup will use installed Dashboard package",
      );
      await broadcastSnapshot();
      return config;
    },
  );

  ipcMain.handle("resources:choosePath", async (_event, key: RuntimeResourcePathKey, mode: ResourcePathMode): Promise<string | null> => {
    if (!["maibot", "napcat", "snowluma"].includes(key) || !["copy", "existing"].includes(mode)) throw new Error("无效的目录操作");
    return resourceLocationManager.withPathOperation(async () => {
      assertServicesStoppedForResourceMove();
      const window = getMainWindow();
      const label = resourceLocationManager.getPathConfigs().find((config) => config.key === key)!.label;
      const options: Electron.OpenDialogOptions = {
        title: mode === "copy" ? `${label}：选择空目录作为复制目标（保留原目录）` : `${label}：选择已有组件目录`,
        properties: mode === "copy" ? ["openDirectory", "createDirectory"] : ["openDirectory"],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
  });
  ipcMain.handle("resources:inspectPath", (_event, key: RuntimeResourcePathKey, path: string, mode: ResourcePathMode): Promise<ResourcePathPlan> => resourceLocationManager.inspectPath(key, path, mode));
  ipcMain.handle("resources:applyPath", async (_event, plan: ResourcePathPlan): Promise<RuntimeResourcePathChangeResult> => {
    const result = await resourceLocationManager.applyPlan(plan);
    logStore.append("desktop", "system", `组件目录已${plan.mode === "copy" ? "复制并切换" : "切换"}: ${result.previousPath} -> ${result.path}`);
    await broadcastSnapshot().catch((error) => logStore.append("desktop", "system", `目录已切换，界面刷新失败: ${String(error)}`));
    return result;
  });
  ipcMain.handle("resources:cancelOperation", (_event, operationId: string): boolean => resourceLocationManager.cancelOperation(operationId));
  ipcMain.handle("resources:getProgress", (): ResourcePathProgress | null => resourceLocationManager.getProgress());

  ipcMain.handle("logs:list", (): LogEntry[] => logStore.list());

  ipcMain.handle("logs:clear", (): void => {
    logStore.clear();
    void broadcastSnapshot();
  });

  ipcMain.handle(
    "localChat:connect",
    async (
      _event,
      request?: LocalChatConnectRequest,
    ): Promise<LocalChatConnectionState> => {
      return localChatAdapter.connect(request);
    },
  );

  ipcMain.handle("localChat:disconnect", async (): Promise<void> => {
    localChatAdapter.disconnect();
  });

  ipcMain.handle(
    "localChat:send",
    async (
      _event,
      request: LocalChatSendRequest,
    ): Promise<LocalChatMessageEvent> => {
      return localChatAdapter.send(request);
    },
  );

  ipcMain.handle(
    "localChat:listMessages",
    async (
      _event,
      request?: LocalChatConnectRequest,
    ): Promise<LocalChatMessageEvent[]> => {
      return localChatAdapter.listMessages(request);
    },
  );

  ipcMain.handle("desktop:openLogsDirectory", async (): Promise<void> => {
    await mkdir(paths.logsRoot, { recursive: true });
    await shell.openPath(paths.logsRoot);
  });

  ipcMain.handle(
    "desktop:chooseCloseAction",
    async (_event, action: CloseAction): Promise<void> => {
      const mainWindow = getMainWindow();

      if (action === "minimize") {
        mainWindow?.hide();
        return;
      }

      requestQuit();
    },
  );

  ipcMain.handle("desktop:show", (): void => showMainWindow());

  ipcMain.handle("desktop:window:minimize", (): void => {
    getMainWindow()?.minimize();
  });

  ipcMain.handle("desktop:window:toggleMaximize", (): WindowState | void => {
    const window = getMainWindow();
    if (!window) return;
    if (miniMode) return applyMiniMode(false);
    return isShellWindowMaximized(window)
      ? restoreShellWindow(window)
      : maximizeShellWindow(window);
  });

  ipcMain.handle("desktop:window:close", (): void => {
    getMainWindow()?.close();
  });

  ipcMain.handle(
    "desktop:window:setMiniMode",
    (_event, enabled: boolean): WindowState => applyMiniMode(enabled === true),
  );

  ipcMain.handle(
    "desktop:window:setFloatingMode",
    (_event, enabled: boolean): WindowState => applyFloatingMode(enabled),
  );

  ipcMain.handle(
    "desktop:window:setFloatingGlassEffect",
    (_event, enabled: boolean): WindowState =>
      applyFloatingGlassEffect(enabled),
  );

  ipcMain.handle(
    "desktop:window:setFloatingBubbleExpanded",
    (_event, expanded: boolean): WindowState =>
      applyFloatingBubbleExpanded(expanded),
  );

  ipcMain.handle(
    "desktop:window:moveFloatingBy",
    (_event, deltaX: number, deltaY: number): WindowState =>
      moveFloatingBy(deltaX, deltaY),
  );
  ipcMain.handle(
    "desktop:window:moveFloatingTo",
    (_event, offsetX: number, offsetY: number): WindowState =>
      moveFloatingTo(offsetX, offsetY),
  );

  ipcMain.handle(
    "desktop:window:finishFloatingDrag",
    (): WindowState => finishFloatingDrag(),
  );

  ipcMain.handle(
    "desktop:window:startResize",
    (
      _event,
      edge: WindowResizeEdge,
      screenX: number,
      screenY: number,
    ): WindowState => startWindowResize(edge, screenX, screenY),
  );

  ipcMain.handle(
    "desktop:window:resizeTo",
    (_event, screenX: number, screenY: number): WindowState =>
      resizeWindowTo(screenX, screenY),
  );

  ipcMain.handle(
    "desktop:window:finishResize",
    (): WindowState => finishWindowResize(),
  );

  ipcMain.handle(
    "desktop:window:getState",
    (): WindowState => readManagedWindowState(getMainWindow()),
  );

  return {
    localChatAdapter,
    dispose: () => {
      resourceLocationManager.off("operation-change", onResourceOperation);
      resourceLocationManager.off("progress", onResourceProgress);
      localChatAdapter.dispose();
    },
  };
}
