import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CloseAction,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
  LauncherResetResult,
  LogEntry,
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatMessageEvent,
  LocalChatSendRequest,
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  MaiBotInstalledPlugin,
  MaiBotPluginConfigSaveResult,
  MaiBotPluginConfigState,
  MaiBotPluginConfigValue,
  MaiBotPluginListOptions,
  MaiBotPluginListResult,
  MaiBotPluginOperationRequest,
  MaiBotPluginOperationResult,
  MaiBotPluginReadmeResult,
  MaiBotPluginStats,
  MaiBotStatisticSummary,
  ManagedPythonPackageName,
  ModuleRuntimeVersions,
  ModuleUpdateResult,
  ModuleSourceConfig,
  ModuleSourceUpdate,
  ModuleTagOption,
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
  WindowState,
} from "../../shared/contracts";
import { InitManager } from "../services/init-manager";
import { LogStore } from "../services/log-store";
import { LocalChatAdapter } from "../services/local-chat-adapter";
import { MaiBotPluginClient } from "../services/maibot-plugin-client";
import { ModuleUpdater } from "../services/module-updater";
import { PythonDependencyManager } from "../services/python-dependency-manager";
import { ResourceLocationManager } from "../services/resource-location-manager";
import { ServiceManager } from "../services/service-manager";

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
];
const LAUNCHER_RUNTIME_DIRECTORIES = ["modules", "python-overrides", "logs"];
const RETIRED_ENTRY_DIRECTORY = ".reset-pending-delete";
const REMOVE_RETRY_OPTIONS = { recursive: true, force: true, maxRetries: 8, retryDelay: 250 } as const;
const NORMAL_MINIMUM_SIZE = { width: 1080, height: 720 };
const FLOATING_BALL_SIZE = { width: 96, height: 96 };
const FLOATING_PANEL_SIZE = { width: 380, height: 520 };

interface RegisterAppIpcOptions {
  paths: RuntimePaths;
  initManager: InitManager;
  moduleUpdater: ModuleUpdater;
  pythonDependencyManager: PythonDependencyManager;
  resourceLocationManager: ResourceLocationManager;
  serviceManager: ServiceManager;
  logStore: LogStore;
  getMainWindow: () => BrowserWindow | null;
  requestQuit: () => void;
  showMainWindow: () => void;
}

export interface RegisteredAppIpcDisposables {
  localChatAdapter: LocalChatAdapter;
  dispose: () => void;
}

function readWindowState(window: BrowserWindow | null, isFloating = false): WindowState {
  if (!window || window.isDestroyed()) {
    return { isMaximized: false, isFullScreen: false, isFocused: false, isFloating };
  }

  return {
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen(),
    isFocused: window.isFocused(),
    isFloating,
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

function isAtLeastVersion(tag: ParsedVersionTag, minimum: number[]): boolean {
  const length = Math.max(tag.parts.length, minimum.length);
  for (let index = 0; index < length; index++) {
    const diff = (tag.parts[index] ?? 0) - (minimum[index] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return true;
}

function pickLatestTags(
  rawTags: string[],
): Pick<ModuleRuntimeVersions, "maibotLatestStableTag" | "maibotLatestPrereleaseTag" | "maibotLatestLegacyTag"> {
  const parsed = rawTags.map(parseVersionTag).filter((tag): tag is ParsedVersionTag => Boolean(tag));
  const standard = parsed.filter((tag) => isAtLeastVersion(tag, [1, 0, 0]));
  const stable = standard.filter((tag) => !tag.prerelease).sort(compareParsedTags).at(-1)?.tag;
  const prerelease = standard.filter((tag) => tag.prerelease).sort(compareParsedTags).at(-1)?.tag;
  const legacy = parsed.filter((tag) => !isAtLeastVersion(tag, [1, 0, 0])).sort(compareParsedTags).at(-1)?.tag;
  return {
    maibotLatestStableTag: stable,
    maibotLatestPrereleaseTag: prerelease,
    maibotLatestLegacyTag: legacy,
  };
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
    .replace(/&yen;/giu, "¥")
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
  const inlineValue = text.match(new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*([^\\n]+)`, "u"))?.[1]?.trim();
  if (inlineValue) {
    return inlineValue;
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const labelIndex = lines.findIndex((line) => line === label);
  const nextLine = labelIndex >= 0 ? lines[labelIndex + 1] : undefined;
  return nextLine && !nextLine.endsWith(":") && !nextLine.endsWith("：") ? nextLine : undefined;
}

function readStatisticCount(text: string, label: string): number | undefined {
  const raw = readStatisticField(text, label);
  const value = raw?.match(/[\d,]+/u)?.[0]?.replace(/,/gu, "");
  return value ? Number(value) : undefined;
}

function parseChatStatistics(text: string): MaiBotStatisticSummary["chatStats"] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const startIndex = lines.findIndex((line) => line.includes("聊天消息统计"));
  if (startIndex < 0) {
    return [];
  }

  const stats: MaiBotStatisticSummary["chatStats"] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.startsWith("-") || line.includes("Token/") || line.includes("花费/")) {
      break;
    }
    if (line.includes("联系人") || line.includes("群组名称") || line.includes("消息数量")) {
      continue;
    }
    const match = line.match(/^(.+?)\s+(\d+)$/u);
    if (!match) {
      continue;
    }
    stats.push({ name: match[1].trim(), messageCount: Number(match[2]) });
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
  const periodLabel = text.match(/(最近[^\s(（]*统计数据)/u)?.[1];
  const startedAt = text.match(/自\s*([^，,)）]+)开始/u)?.[1]?.trim();

  return {
    available: true,
    updatedAt: fileStat.mtimeMs,
    sourcePath,
    periodLabel,
    startedAt,
    totalOnlineTime: readStatisticField(text, "总在线时间"),
    totalMessages: readStatisticCount(text, "总消息数"),
    totalReplies: readStatisticCount(text, "总回复数"),
    totalRequests: readStatisticCount(text, "总请求数"),
    totalTokens: readStatisticCount(text, "总Token数"),
    totalCost: readStatisticField(text, "总花费"),
    costPerMessage: readStatisticField(text, "花费/消息数量"),
    costPerReceivedMessage: readStatisticField(text, "花费/接受消息数量"),
    costPerReply: readStatisticField(text, "花费/回复数量"),
    costPerHour: readStatisticField(text, "花费/时间"),
    tokensPerHour: readStatisticField(text, "Token/时间"),
    chatStats: parseChatStatistics(text),
  };
}

export function registerAppIpc({
  paths,
  initManager,
  moduleUpdater,
  pythonDependencyManager,
  resourceLocationManager,
  serviceManager,
  logStore,
  getMainWindow,
  requestQuit,
  showMainWindow,
}: RegisterAppIpcOptions): RegisteredAppIpcDisposables {
  let remoteModuleVersionsCache: ModuleRuntimeVersions = {};
  let remoteModuleVersionsRefreshPromise: Promise<void> | null = null;
  let initDependencyRefreshPromise: Promise<void> | null = null;
  let floatingMode = false;
  let normalBounds: Electron.Rectangle | null = null;

  const sendWindowState = (window: BrowserWindow | null): WindowState => {
    const state = readWindowState(window, floatingMode);
    window?.webContents.send("desktop:window-state", state);
    return state;
  };

  const floatingBounds = (window: BrowserWindow, size: { width: number; height: number }): Electron.Rectangle => {
    const display = screen.getDisplayMatching(window.getBounds());
    return {
      x: Math.round(display.workArea.x + display.workArea.width - size.width - 18),
      y: Math.round(display.workArea.y + display.workArea.height - size.height - 18),
      width: size.width,
      height: size.height,
    };
  };

  const applyFloatingMode = (enabled: boolean): WindowState => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return readWindowState(window, floatingMode);
    }

    if (enabled && !floatingMode) {
      normalBounds = window.getBounds();
      if (window.isMaximized()) {
        window.unmaximize();
      }
      floatingMode = true;
      window.setMinimumSize(72, 72);
      window.setResizable(false);
      window.setAlwaysOnTop(true, "floating");
      window.setBounds(floatingBounds(window, FLOATING_BALL_SIZE), true);
      window.show();
      window.focus();
      return sendWindowState(window);
    }

    if (!enabled && floatingMode) {
      floatingMode = false;
      window.setAlwaysOnTop(false);
      window.setResizable(true);
      window.setMinimumSize(NORMAL_MINIMUM_SIZE.width, NORMAL_MINIMUM_SIZE.height);
      window.setBounds(normalBounds ?? { x: 80, y: 80, width: 1280, height: 820 }, true);
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
      return readWindowState(window, floatingMode);
    }
    if (!floatingMode) {
      return sendWindowState(window);
    }
    window.setBounds(floatingBounds(window, expanded ? FLOATING_PANEL_SIZE : FLOATING_BALL_SIZE), true);
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

  const readModuleVersions = async (): Promise<ModuleRuntimeVersions> => ({
    ...remoteModuleVersionsCache,
    ...(await readLocalModuleVersions()),
  });

  const buildSnapshot = async (options: { refreshDependencies?: boolean } = {}): Promise<DesktopSnapshot> => ({
    paths,
    services: serviceManager.snapshot(),
    serviceCommands: await serviceManager.getCommandConfigs(),
    runtimePathConfigs: serviceManager.getRuntimePathConfigs(),
    runtimeResourcePathConfigs: resourceLocationManager.getPathConfigs(),
    terminalSettings: serviceManager.getTerminalSettings(),
    appVersion: app.getVersion(),
    moduleVersions: await readModuleVersions(),
    platform: process.platform,
    windowState: readWindowState(getMainWindow(), floatingMode),
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
    remoteModuleVersionsRefreshPromise = readRemoteModuleVersions()
      .then(async (versions) => {
        remoteModuleVersionsCache = versions;
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
  const localChatAdapter = new LocalChatAdapter(paths);

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
      throw new Error(`请先停止服务，再调整覆盖路径组: ${active.map((service) => service.name).join(", ")}`);
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
    logStore.append("desktop", "system", "启动器设置已清空，将重新进入启动引导");
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
      throw new Error("当前运行时资源目录指向安装/开发目录，已阻止完整清空。请在打包版的独立运行时目录中执行。");
    }
    if (!samePath(root, paths.userDataRoot) && !isPathInside(paths.userDataRoot, root)) {
      throw new Error("当前运行时资源目录不在启动器数据目录内，已阻止完整清空。");
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

  ipcMain.handle("init:getState", async (): Promise<InitState> => {
    return initManager.getState({ refreshDependencies: true });
  });

  ipcMain.handle("init:repair", async (): Promise<InitRepairResult> => {
    const result = await initManager.repair();
    logStore.append("desktop", "system", `初始化准备完成，变更 ${result.changedFiles.length} 个文件`);
    await broadcastSnapshot();
    return result;
  });

  ipcMain.handle("init:resetSnowLuma", async (): Promise<SnowLumaResetResult> => {
    await serviceManager.refresh();
    if (serviceManager.snapshot().some(isRuntimeBusy)) {
      throw new Error("请先停止 MaiBot Core 和 QQ 后端，再重置 SnowLuma 组件。");
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
      throw new Error("未知 QQ 后端");
    }
    if (backend !== currentInitState.qqBackend && serviceManager.snapshot().some(isRuntimeBusy)) {
      throw new Error("MaiBot Core 或 QQ 后端正在运行时不能切换 NapCat / SnowLuma，请先停止全部服务。");
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
        throw new Error("MaiBot Core 或 QQ 后端正在运行时不能切换 NapCat / SnowLuma，请先停止全部服务。");
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
    logStore.append("desktop", "system", `MaiBot EULA 与隐私政策已确认，写入 ${result.changedFiles.length} 个文件`);
    await broadcastSnapshot();
    return result;
  });

  ipcMain.handle("modules:updateMaibot", async (_event, tag?: string): Promise<ModuleUpdateResult> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping") {
      throw new Error("请先停止 MaiBot Core，再更新 MaiBot 模块。");
    }

    logStore.append("desktop", "system", "开始更新 MaiBot 模块：使用可用 Git 强制拉取远端代码");
    const result = await moduleUpdater.updateMaiBot(tag);
    logStore.append(
      "desktop",
      "system",
      `MaiBot 模块更新完成: ${result.before ?? "-"} -> ${result.after ?? "-"} (${result.changed ? "已更新" : "已是最新"})`,
    );
    await broadcastSnapshot();
    return result;
  });

  ipcMain.handle("modules:listMaibotTags", async (): Promise<ModuleTagOption[]> => {
    return moduleUpdater.listMaiBotTags();
  });

  ipcMain.handle("modules:getSourceConfig", async (): Promise<ModuleSourceConfig> => {
    return moduleUpdater.getSourceConfig();
  });

  ipcMain.handle("modules:saveSourceConfig", async (_event, config: ModuleSourceUpdate): Promise<ModuleSourceConfig> => {
    const result = await moduleUpdater.saveSourceConfig(config);
    logStore.append("desktop", "system", `模块更新源已切换: ${result.preset} (${result.maibotUrl})`);
    return result;
  });


  ipcMain.handle("data:importMaibotDb", async (): Promise<MaiBotDataImportResult | null> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping") {
      throw new Error("请先停止 MaiBot Core，再导入旧版本数据库。");
    }

    const mainWindow = getMainWindow();
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "选择旧版本 MaiBot.db",
      properties: ["openFile"],
      filters: [
        { name: "MaiBot 数据库", extensions: ["db"] },
        { name: "全部文件", extensions: ["*"] },
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
      `MaiBot.db 导入完成: ${importResult.sourcePath} -> ${importResult.destPath}`,
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
        throw new Error("请先停止 MaiBot Core，再覆盖配置文件。");
      }

      if (fileName !== "bot_config.toml" && fileName !== "model_config.toml") {
        throw new Error(`不支持的配置文件名: ${fileName}`);
      }

      const mainWindow = getMainWindow();
      const dialogOptions: Electron.OpenDialogOptions = {
        title: `选择 ${fileName}`,
        properties: ["openFile"],
        filters: [
          { name: "TOML 配置", extensions: ["toml"] },
          { name: "全部文件", extensions: ["*"] },
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
        `MaiBot ${fileName} 导入完成: ${importResult.sourcePath} -> ${importResult.destPath}`,
      );
      await broadcastSnapshot();
      return importResult;
    },
  );

  ipcMain.handle("data:resetMaibotData", async (): Promise<MaiBotDataResetResult> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping") {
      throw new Error("请先停止 MaiBot Core，再重置数据。");
    }

    const resetResult = await initManager.resetMaiBotData();
    logStore.append(
      "desktop",
      "system",
      `已清空 MaiBot data 目录 (${resetResult.removedEntries.length} 项): ${resetResult.dataDir}`,
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
      throw new Error("请先停止 MaiBot Core，再更新 Python 依赖。");
    }

    logStore.append("desktop", "system", `开始更新 Python 覆盖依赖: ${request.packageName}==${request.version}`);
    const result = await pythonDependencyManager.installVersion(request);
    logStore.append(
      "desktop",
      "system",
      `Python 覆盖依赖更新完成: ${result.packageName}==${result.version} -> ${result.targetDir}`,
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
      title: "选择 Python 可执行文件",
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
      const targetPath = await chooseResourcePath("选择迁移目标目录");
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
      const targetPath = await chooseResourcePath("选择已有目录");
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

  ipcMain.handle("desktop:window:toggleMaximize", (): void => {
    const window = getMainWindow();
    if (!window) return;
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  ipcMain.handle("desktop:window:close", (): void => {
    getMainWindow()?.close();
  });

  ipcMain.handle("desktop:window:setFloatingMode", (_event, enabled: boolean): WindowState => applyFloatingMode(enabled));

  ipcMain.handle("desktop:window:setFloatingPanelExpanded", (_event, expanded: boolean): WindowState =>
    applyFloatingPanelExpanded(expanded),
  );

  ipcMain.handle("desktop:window:getState", (): WindowState => readWindowState(getMainWindow(), floatingMode));

  return {
    localChatAdapter,
    dispose: () => {
      localChatAdapter.dispose();
    },
  };
}
