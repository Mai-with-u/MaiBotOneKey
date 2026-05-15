import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CloseAction,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
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
  MaiBotPluginListResult,
  MaiBotPluginOperationRequest,
  MaiBotPluginOperationResult,
  ManagedPythonPackageName,
  ModuleRuntimeVersions,
  ModuleUpdateResult,
  ModuleSourceConfig,
  ModuleSourceUpdate,
  ModuleTagOption,
  PythonOverridesState,
  PythonRuntimeCandidate,
  PythonPackageInstallRequest,
  PythonPackageInstallResult,
  PythonPackageVersionList,
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

function readWindowState(window: BrowserWindow | null): WindowState {
  if (!window || window.isDestroyed()) {
    return { isMaximized: false, isFullScreen: false, isFocused: false };
  }

  return {
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen(),
    isFocused: window.isFocused(),
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
}: RegisterAppIpcOptions): void {
  let remoteModuleVersionsCache: ModuleRuntimeVersions = {};
  let remoteModuleVersionsRefreshPromise: Promise<void> | null = null;
  let initDependencyRefreshPromise: Promise<void> | null = null;

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
    windowState: readWindowState(getMainWindow()),
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

  ipcMain.handle(
    "init:setQqAccount",
    async (_event, request: QqAccountSetupRequest): Promise<InitState> => {
      const state = await initManager.setQqAccount(
        request.qqAccount,
        request.websocketToken,
        request.chat,
      );
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

  ipcMain.handle("plugins:listMarket", async (): Promise<MaiBotPluginListResult> => {
    return maibotPluginClient.listMarket();
  });

  ipcMain.handle("plugins:listInstalled", async (): Promise<MaiBotInstalledPlugin[]> => {
    return maibotPluginClient.listInstalled();
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

  ipcMain.handle("plugins:getConfig", async (_event, pluginId: string): Promise<MaiBotPluginConfigState> => {
    return maibotPluginClient.getConfig(pluginId);
  });

  ipcMain.handle(
    "plugins:saveConfig",
    async (
      _event,
      pluginId: string,
      config: Record<string, MaiBotPluginConfigValue>,
    ): Promise<MaiBotPluginConfigSaveResult> => {
      const result = await maibotPluginClient.saveConfig(pluginId, config);
      logStore.append("desktop", "system", `MaiBot plugin config saved: ${pluginId}`);
      await broadcastSnapshot();
      return result;
    },
  );

  ipcMain.handle("pythonDeps:getState", (): PythonOverridesState => {
    return pythonDependencyManager.getState();
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

  ipcMain.handle("desktop:openLogsDirectory", async (): Promise<void> => {
    await mkdir(paths.logsRoot, { recursive: true });
    await shell.openPath(paths.logsRoot);
  });

  ipcMain.handle("desktop:chooseCloseAction", async (_event, action: CloseAction): Promise<void> => {
    const mainWindow = getMainWindow();

    if (action === "minimize") {
      mainWindow?.minimize();
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

  ipcMain.handle("desktop:window:getState", (): WindowState => readWindowState(getMainWindow()));
}
