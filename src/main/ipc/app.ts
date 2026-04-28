import { app, BrowserWindow, ipcMain, shell } from "electron";
import { mkdir } from "node:fs/promises";
import type {
  CloseAction,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
  LogEntry,
  RuntimePaths,
  RuntimePathConfig,
  RuntimePathKey,
  RuntimePathUpdate,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceId,
  WindowState,
} from "../../shared/contracts";
import { InitManager } from "../services/init-manager";
import { LogStore } from "../services/log-store";
import { ServiceManager } from "../services/service-manager";

interface RegisterAppIpcOptions {
  paths: RuntimePaths;
  initManager: InitManager;
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

  ipcMain.handle("init:setQqAccount", async (_event, qqAccount: string): Promise<InitState> => {
    const state = await initManager.setQqAccount(qqAccount);
    logStore.append("desktop", "system", `机器人 QQ 号已配置: ${qqAccount}`);
    await broadcastSnapshot();
    return state;
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
