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
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  ManagedPythonPackageName,
  ModuleRuntimeVersions,
  ModuleUpdateResult,
  ModuleSourceConfig,
  ModuleSourceUpdate,
  ModuleTagOption,
  NapcatAdapterConfig,
  NapcatAdapterConfigSaveResult,
  NapcatAdapterConfigState,
  PythonOverridesState,
  PythonPackageInstallRequest,
  PythonPackageInstallResult,
  PythonPackageVersionList,
  QqAccountSetupRequest,
  RuntimePaths,
  RuntimePathConfig,
  RuntimePathKey,
  RuntimePathUpdate,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceId,
  StartupAgreementConfirmResult,
  StartupAgreementState,
  WindowState,
} from "../../shared/contracts";
import { InitManager } from "../services/init-manager";
import { LogStore } from "../services/log-store";
import { ModuleUpdater } from "../services/module-updater";
import { PythonDependencyManager } from "../services/python-dependency-manager";
import { ServiceManager } from "../services/service-manager";

interface RegisterAppIpcOptions {
  paths: RuntimePaths;
  initManager: InitManager;
  moduleUpdater: ModuleUpdater;
  pythonDependencyManager: PythonDependencyManager;
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

async function readPythonDistInfoVersion(root: string, packageName: string): Promise<string | undefined> {
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const expectedName = normalizePythonPackageName(packageName);
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
      return metadata.match(/^Version:\s*(.+)$/imu)?.[1]?.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
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

function pickLatestTags(rawTags: string[]): Pick<ModuleRuntimeVersions, "maibotLatestStableTag" | "maibotLatestPrereleaseTag"> {
  const parsed = rawTags.map(parseVersionTag).filter((tag): tag is ParsedVersionTag => Boolean(tag));
  const stable = parsed.filter((tag) => !tag.prerelease).sort(compareParsedTags).at(-1)?.tag;
  const prerelease = parsed.filter((tag) => tag.prerelease).sort(compareParsedTags).at(-1)?.tag;
  return {
    maibotLatestStableTag: stable,
    maibotLatestPrereleaseTag: prerelease,
  };
}

async function fetchPypiLatestVersion(packageName: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://pypi.org/pypi/${packageName}/json`, { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as { info?: { version?: unknown } };
    return typeof data.info?.version === "string" ? data.info.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function registerAppIpc({
  paths,
  initManager,
  moduleUpdater,
  pythonDependencyManager,
  serviceManager,
  logStore,
  getMainWindow,
  requestQuit,
  showMainWindow,
}: RegisterAppIpcOptions): void {
  let remoteModuleVersionsCache: ModuleRuntimeVersions = {};
  let remoteModuleVersionsRefreshPromise: Promise<void> | null = null;

  const readLocalModuleVersions = async (): Promise<ModuleRuntimeVersions> => {
    const versions: ModuleRuntimeVersions = {};
    const maibotRoot = join(paths.modulesRoot, "MaiBot");

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

    const latestDashboard = await fetchPypiLatestVersion("maibot-dashboard");
    if (latestDashboard) {
      versions.dashboardLatestPypi = latestDashboard;
      versions.dashboardPypiSource = "PyPI";
    }

    return versions;
  };

  const readModuleVersions = async (): Promise<ModuleRuntimeVersions> => ({
    ...remoteModuleVersionsCache,
    ...(await readLocalModuleVersions()),
  });

  const buildSnapshot = async (): Promise<DesktopSnapshot> => ({
    paths,
    services: serviceManager.snapshot(),
    serviceCommands: await serviceManager.getCommandConfigs(),
    runtimePathConfigs: serviceManager.getRuntimePathConfigs(),
    appVersion: app.getVersion(),
    moduleVersions: await readModuleVersions(),
    platform: process.platform,
    windowState: readWindowState(getMainWindow()),
    initState: await initManager.getState(),
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

  serviceManager.on("snapshot", (services: ServiceDescriptor[]) => {
    const window = getMainWindow();
    window?.webContents.send("services:snapshot", services);
    void broadcastSnapshot();
  });
  logStore.onEntry((entry) => {
    const window = getMainWindow();
    window?.webContents.send("logs:entry", entry);
  });

  ipcMain.handle("desktop:getSnapshot", async (): Promise<DesktopSnapshot> => {
    await serviceManager.refresh();
    const snapshot = await buildSnapshot();
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
    return initManager.getState();
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

    logStore.append("desktop", "system", "开始更新 MaiBot 模块：使用内置 Git 强制拉取远端代码");
    await initManager.ensureServiceReady("maibot");
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

  ipcMain.handle("napcatAdapter:getConfig", async (): Promise<NapcatAdapterConfigState> => {
    return initManager.getNapcatAdapterConfig();
  });

  ipcMain.handle(
    "napcatAdapter:saveConfig",
    async (_event, payload: NapcatAdapterConfig): Promise<NapcatAdapterConfigSaveResult> => {
      const result = await initManager.saveNapcatAdapterConfig(payload);
      logStore.append(
        "desktop",
        "system",
        `napcat-adapter 配置已保存: ${result.configPath}`,
      );
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

  ipcMain.handle("logs:list", (): LogEntry[] => logStore.list());

  ipcMain.handle("logs:clear", (): void => {
    logStore.clear();
    void broadcastSnapshot();
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
