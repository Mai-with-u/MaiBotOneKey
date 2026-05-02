import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir } from "node:fs/promises";
import type {
  CloseAction,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
  LogEntry,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  ManagedPythonPackageName,
  ModuleUpdateResult,
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
  const buildSnapshot = async (): Promise<DesktopSnapshot> => ({
    paths,
    services: serviceManager.snapshot(),
    serviceCommands: await serviceManager.getCommandConfigs(),
    runtimePathConfigs: serviceManager.getRuntimePathConfigs(),
    appVersion: app.getVersion(),
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
    return buildSnapshot();
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

  ipcMain.handle("modules:updateMaibot", async (): Promise<ModuleUpdateResult> => {
    const maibot = serviceManager.snapshot().find((service) => service.id === "maibot");
    if (maibot?.managed || maibot?.status === "starting" || maibot?.status === "running" || maibot?.status === "stopping") {
      throw new Error("请先停止 MaiBot Core，再更新 MaiBot 模块。");
    }

    logStore.append("desktop", "system", "开始更新 MaiBot 模块：使用内置 Git 强制拉取远端代码");
    await initManager.ensureServiceReady("maibot");
    const result = await moduleUpdater.updateMaiBot();
    logStore.append(
      "desktop",
      "system",
      `MaiBot 模块更新完成: ${result.before ?? "-"} -> ${result.after ?? "-"} (${result.changed ? "已更新" : "已是最新"})`,
    );
    await broadcastSnapshot();
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
