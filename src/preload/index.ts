import { contextBridge, ipcRenderer } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessagePlatformLoginInfo, QqProtocol, QqProtocolOptions, QqComponentUpgradeId } from "../shared/contracts";
import type {
  CloseAction,
  AppIconId,
  AppIconSettings,
  DesktopBridge,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
  MaiBotSetupStatus,
  LauncherUiSettings,
  LauncherUpdateApplyResult,
  LauncherUpdateInfo,
  LogEntry,
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatEvent,
  LocalChatMessageEvent,
  LocalChatSendRequest,
  LauncherResetResult,
  LauncherUpdateDownloadProgress,
  MaiBotConfigFileName,
  MaiBotBackupProgress,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  MaiBotStorageCleanupResult,
  MaiBotStorageCleanupTarget,
  MaiBotStorageStats,
  MaiBotUpdateInfo,
  MaiBotModuleUpdateProgress,
  ManagedPythonPackageName,
  ModuleUpdateTarget,
  ModuleUpdateResult,
  NetworkProxySettings,
  ModuleTagOption,
  PythonEnvironmentState,
  PythonPackageSourcePreset,
  PythonPackageInstallRequest,
  PythonPackageInstallResult,
  PythonPackageVersionList,
  PtyDataEvent,
  PtyBufferSnapshot,
  PtyErrorEvent,
  PtyExitEvent,
  PtyInputRequest,
  PtyResizeRequest,
  PtySessionSnapshot,
  PtyStartRequest,
  PtyStopRequest,
  QqBackend,
  QqAccountSetupRequest,
  QqComponentUpgradeResult,
  RuntimeResourcePathChangeResult,
  RuntimeResourcePathKey,
  ResourcePathMode,
  ResourcePathPlan,
  ResourcePathProgress,
  ServiceCommandConfig,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceId,
  ServiceStartupSettings,
  SnowLumaResetResult,
  SourceSettings,
  SourceSettingsUpdate,
  StartupAgreementConfirmResult,
  StartupAgreementState,
  SystemPerformanceSnapshot,
  TerminalSettings,
  WindowResizeEdge,
  WindowState,
  MaiBotBackupExportResult,
  MaiBotBackupImportResult,
} from "../shared/contracts";

function onIpc<T>(channel: string, callback: (event: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

let pendingQqAccountSetup: QqBackend | undefined;
const qqAccountSetupListeners = new Set<(backend: QqBackend) => void>();
ipcRenderer.on("desktop:qq-account-setup-required", (_event, backend: QqBackend) => {
  if (qqAccountSetupListeners.size === 0) pendingQqAccountSetup = backend;
  else for (const listener of qqAccountSetupListeners) listener(backend);
});

const desktopBridge: DesktopBridge = {
  webuiPreloadUrl: pathToFileURL(join(__dirname, "webui.cjs")).toString(),
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke("desktop:getSnapshot") as Promise<DesktopSnapshot>,
  getSystemPerformance: () =>
    ipcRenderer.invoke("desktop:getSystemPerformance") as Promise<SystemPerformanceSnapshot>,
  openLogsDirectory: () => ipcRenderer.invoke("desktop:openLogsDirectory") as Promise<void>,
  openPath: (path: string) => ipcRenderer.invoke("desktop:openPath", path) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke("desktop:openExternal", url) as Promise<void>,
  clearWebviewCache: () => ipcRenderer.invoke("desktop:clearWebviewCache") as Promise<void>,
  chooseCloseAction: (action: CloseAction) =>
    ipcRenderer.invoke("desktop:chooseCloseAction", action) as Promise<void>,
  onCloseRequest: (callback: () => void) => {
    const listener = (): void => callback();
    ipcRenderer.on("desktop:close-request", listener);

    return () => {
      ipcRenderer.removeListener("desktop:close-request", listener);
    };
  },
  onSnapshot: (callback: (snapshot: DesktopSnapshot) => void) =>
    onIpc("desktop:snapshot", callback),
  onQqAccountSetupRequired: (callback) => {
    qqAccountSetupListeners.add(callback);
    if (pendingQqAccountSetup) {
      const backend = pendingQqAccountSetup;
      pendingQqAccountSetup = undefined;
      callback(backend);
    }
    return () => { qqAccountSetupListeners.delete(callback); };
  },
  window: {
    setMiniMode: (enabled: boolean) =>
      ipcRenderer.invoke("desktop:window:setMiniMode", enabled) as Promise<WindowState>,
    minimize: () => ipcRenderer.invoke("desktop:window:minimize") as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke("desktop:window:toggleMaximize") as Promise<WindowState>,
    close: () => ipcRenderer.invoke("desktop:window:close") as Promise<void>,
    setFloatingMode: (enabled: boolean) =>
      ipcRenderer.invoke("desktop:window:setFloatingMode", enabled) as Promise<WindowState>,
    setFloatingGlassEffect: (enabled: boolean) =>
      ipcRenderer.invoke("desktop:window:setFloatingGlassEffect", enabled) as Promise<WindowState>,
    setFloatingBubbleExpanded: (expanded: boolean) =>
      ipcRenderer.invoke("desktop:window:setFloatingBubbleExpanded", expanded) as Promise<WindowState>,
    moveFloatingBy: (deltaX: number, deltaY: number) =>
      ipcRenderer.invoke("desktop:window:moveFloatingBy", deltaX, deltaY) as Promise<WindowState>,
    moveFloatingTo: (offsetX: number, offsetY: number) =>
      ipcRenderer.invoke("desktop:window:moveFloatingTo", offsetX, offsetY) as Promise<WindowState>,
    finishFloatingDrag: () =>
      ipcRenderer.invoke("desktop:window:finishFloatingDrag") as Promise<WindowState>,
    startResize: (edge: WindowResizeEdge, screenX: number, screenY: number) =>
      ipcRenderer.invoke("desktop:window:startResize", edge, screenX, screenY) as Promise<WindowState>,
    resizeTo: (screenX: number, screenY: number) =>
      ipcRenderer.invoke("desktop:window:resizeTo", screenX, screenY) as Promise<WindowState>,
    finishResize: () =>
      ipcRenderer.invoke("desktop:window:finishResize") as Promise<WindowState>,
    getState: () => ipcRenderer.invoke("desktop:window:getState") as Promise<WindowState>,
    onState: (callback: (state: WindowState) => void) => onIpc("desktop:window-state", callback),
  },
  init: {
    getState: () => ipcRenderer.invoke("init:getState") as Promise<InitState>,
    getMaiBotSetupStatus: () => ipcRenderer.invoke("init:getMaiBotSetupStatus") as Promise<MaiBotSetupStatus>,
    repair: () =>
      ipcRenderer.invoke("init:repair") as Promise<InitRepairResult>,
  },
  protocols: {
    getLoginInfo: () => ipcRenderer.invoke("protocols:getLoginInfo") as Promise<MessagePlatformLoginInfo>,
    saveQqBackendAccount: (backend: QqBackend, account: string) => ipcRenderer.invoke("protocols:saveQqBackendAccount", backend, account) as Promise<void>,
    saveSnowLumaWebuiPassword: (password: string) => ipcRenderer.invoke("protocols:saveSnowLumaWebuiPassword", password) as Promise<void>,
    setQqBackend: (backend: QqBackend) =>
      ipcRenderer.invoke("protocols:setQqBackend", backend) as Promise<InitState>,
    setQqAccount: (request: QqAccountSetupRequest) =>
      ipcRenderer.invoke("protocols:setQqAccount", request) as Promise<InitState>,
    resetSnowLuma: () =>
      ipcRenderer.invoke("protocols:resetSnowLuma") as Promise<SnowLumaResetResult>,
    upgradeQqComponents: (component?: QqComponentUpgradeId) =>
      ipcRenderer.invoke("protocols:upgradeQqComponents", component) as Promise<QqComponentUpgradeResult>,
  },
  adapters: {
    syncQqConnections: () => ipcRenderer.invoke("adapters:syncQqConnections") as Promise<InitRepairResult>,
    setQqProtocol: (protocol: QqProtocol, options?: QqProtocolOptions) =>
      ipcRenderer.invoke("adapters:setQqProtocol", protocol, options) as Promise<InitState>,
    setEnabled: (adapter: "onebot" | "official", enabled: boolean) =>
      ipcRenderer.invoke("adapters:setEnabled", adapter, enabled) as Promise<void>,
  },
  agreements: {
    getState: () => ipcRenderer.invoke("agreements:getState") as Promise<StartupAgreementState>,
    confirm: () => ipcRenderer.invoke("agreements:confirm") as Promise<StartupAgreementConfirmResult>,
  },
  modules: {
    refreshVersions: () =>
      ipcRenderer.invoke("modules:refreshVersions") as Promise<DesktopSnapshot>,
    checkMaiBotUpdate: (target: ModuleUpdateTarget) =>
      ipcRenderer.invoke("modules:checkMaibotUpdate", target) as Promise<MaiBotUpdateInfo>,
    updateMaiBot: (target?: ModuleUpdateTarget) =>
      ipcRenderer.invoke("modules:updateMaibot", target) as Promise<ModuleUpdateResult>,
    rollbackMaiBot: () => ipcRenderer.invoke("modules:rollbackMaibot") as Promise<void>,
    onMaiBotUpdateProgress: (callback: (progress: MaiBotModuleUpdateProgress) => void) =>
      onIpc("modules:maibot-update-progress", callback),
    listMaiBotTags: () => ipcRenderer.invoke("modules:listMaibotTags") as Promise<ModuleTagOption[]>,

  },
  data: {
    onMaiBotBackupProgress: (callback: (progress: MaiBotBackupProgress) => void) =>
      onIpc("data:maibot-backup-progress", callback),
    exportMaiBotBackup: () =>
      ipcRenderer.invoke("data:exportMaibotBackup") as Promise<MaiBotBackupExportResult | null>,
    importMaiBotBackup: () =>
      ipcRenderer.invoke("data:importMaibotBackup") as Promise<MaiBotBackupImportResult | null>,
    cancelMaiBotBackupOperation: () =>
      ipcRenderer.invoke("data:cancelMaibotBackupOperation") as Promise<boolean>,
    importMaiBotDatabase: () =>
      ipcRenderer.invoke("data:importMaibotDb") as Promise<MaiBotDataImportResult | null>,
    importMaiBotConfig: (fileName: MaiBotConfigFileName) =>
      ipcRenderer.invoke(
        "data:importMaibotConfig",
        fileName,
      ) as Promise<MaiBotConfigImportResult | null>,
    getMaiBotStorageStats: () =>
      ipcRenderer.invoke("data:getMaibotStorageStats") as Promise<MaiBotStorageStats>,
    cleanupMaiBotStorage: (target: MaiBotStorageCleanupTarget) =>
      ipcRenderer.invoke("data:cleanupMaibotStorage", target) as Promise<MaiBotStorageCleanupResult>,
    resetMaiBotData: () =>
      ipcRenderer.invoke("data:resetMaibotData") as Promise<MaiBotDataResetResult>,
  },
  launcher: {
    saveNetworkProxySettings: (settings: NetworkProxySettings) =>
      ipcRenderer.invoke("launcher:saveNetworkProxySettings", settings) as Promise<NetworkProxySettings>,
    saveUiSettings: (settings: LauncherUiSettings) =>
      ipcRenderer.invoke("launcher:saveUiSettings", settings) as Promise<LauncherUiSettings>,
    getSourceSettings: () =>
      ipcRenderer.invoke("launcher:getSourceSettings") as Promise<SourceSettings>,
    saveSourceSettings: (settings: SourceSettingsUpdate) =>
      ipcRenderer.invoke("launcher:saveSourceSettings", settings) as Promise<SourceSettings>,
    resetSourceSettings: () =>
      ipcRenderer.invoke("launcher:resetSourceSettings") as Promise<SourceSettings>,
    selectAppIcon: (iconId: AppIconId) =>
      ipcRenderer.invoke("launcher:selectAppIcon", iconId) as Promise<AppIconSettings>,
    checkUpdate: () =>
      ipcRenderer.invoke("launcher:checkUpdate") as Promise<LauncherUpdateInfo>,
    downloadAndInstallUpdate: () =>
      ipcRenderer.invoke("launcher:downloadAndInstallUpdate") as Promise<LauncherUpdateApplyResult>,
    quit: () =>
      ipcRenderer.invoke("launcher:quit") as Promise<void>,
    onDownloadProgress: (callback: (progress: LauncherUpdateDownloadProgress) => void) =>
      onIpc("launcher:update-download-progress", callback),
    resetSettings: () =>
      ipcRenderer.invoke("launcher:resetSettings") as Promise<LauncherResetResult>,
    resetAll: () =>
      ipcRenderer.invoke("launcher:resetAll") as Promise<LauncherResetResult>,
  },
  pythonDeps: {
    getState: () => ipcRenderer.invoke("pythonDeps:getState") as Promise<PythonEnvironmentState>,
    saveSourcePreset: (preset: PythonPackageSourcePreset) =>
      ipcRenderer.invoke("pythonDeps:saveSourcePreset", preset) as Promise<PythonEnvironmentState>,
    listVersions: (packageName: ManagedPythonPackageName) =>
      ipcRenderer.invoke("pythonDeps:listVersions", packageName) as Promise<PythonPackageVersionList>,
    installVersion: (request: PythonPackageInstallRequest) =>
      ipcRenderer.invoke("pythonDeps:installVersion", request) as Promise<PythonPackageInstallResult>,
  },
  services: {
    start: (serviceId: ServiceId) =>
      ipcRenderer.invoke("services:start", serviceId) as Promise<ServiceDescriptor>,
    stop: (serviceId: ServiceId) =>
      ipcRenderer.invoke("services:stop", serviceId) as Promise<ServiceDescriptor>,
    restart: (serviceId: ServiceId) =>
      ipcRenderer.invoke("services:restart", serviceId) as Promise<ServiceDescriptor>,
    startAll: () => ipcRenderer.invoke("services:startAll") as Promise<ServiceDescriptor[]>,
    stopAll: () => ipcRenderer.invoke("services:stopAll") as Promise<ServiceDescriptor[]>,
    refresh: () => ipcRenderer.invoke("services:refresh") as Promise<ServiceDescriptor[]>,
    saveCommandConfig: (config: ServiceCommandUpdate) =>
      ipcRenderer.invoke("services:saveCommandConfig", config) as Promise<ServiceCommandConfig[]>,
    resetCommandConfig: (serviceId: ServiceId) =>
      ipcRenderer.invoke("services:resetCommandConfig", serviceId) as Promise<ServiceCommandConfig[]>,
    saveTerminalSettings: (settings: TerminalSettings) =>
      ipcRenderer.invoke("services:saveTerminalSettings", settings) as Promise<TerminalSettings>,
    saveStartupSettings: (settings: ServiceStartupSettings) =>
      ipcRenderer.invoke("services:saveStartupSettings", settings) as Promise<ServiceStartupSettings>,
    onSnapshot: (callback: (services: ServiceDescriptor[]) => void) =>
      onIpc("services:snapshot", callback),
  },
  resources: {
    choosePath: (key: RuntimeResourcePathKey, mode: ResourcePathMode) => ipcRenderer.invoke("resources:choosePath", key, mode) as Promise<string | null>,
    inspectPath: (key: RuntimeResourcePathKey, path: string, mode: ResourcePathMode) => ipcRenderer.invoke("resources:inspectPath", key, path, mode) as Promise<ResourcePathPlan>,
    applyPath: (plan: ResourcePathPlan) => ipcRenderer.invoke("resources:applyPath", plan) as Promise<RuntimeResourcePathChangeResult>,
    cancelOperation: (operationId: string) => ipcRenderer.invoke("resources:cancelOperation", operationId) as Promise<boolean>,
    getProgress: () => ipcRenderer.invoke("resources:getProgress") as Promise<ResourcePathProgress | null>,
    onProgress: (callback: (progress: ResourcePathProgress) => void) => onIpc("resources:progress", callback),
  },
  logs: {
    list: () => ipcRenderer.invoke("logs:list") as Promise<LogEntry[]>,
    clear: () => ipcRenderer.invoke("logs:clear") as Promise<void>,
    onEntry: (callback: (entry: LogEntry) => void) => onIpc("logs:entry", callback),
  },
  localChat: {
    connect: (request?: LocalChatConnectRequest) =>
      ipcRenderer.invoke("localChat:connect", request) as Promise<LocalChatConnectionState>,
    disconnect: () => ipcRenderer.invoke("localChat:disconnect") as Promise<void>,
    send: (request: LocalChatSendRequest) =>
      ipcRenderer.invoke("localChat:send", request) as Promise<LocalChatMessageEvent>,
    listMessages: (request?: LocalChatConnectRequest) =>
      ipcRenderer.invoke("localChat:listMessages", request) as Promise<LocalChatMessageEvent[]>,
    onEvent: (callback: (event: LocalChatEvent) => void) => onIpc("localChat:event", callback),
  },
  pty: {
    start: (request: PtyStartRequest) =>
      ipcRenderer.invoke("pty:start", request) as Promise<PtySessionSnapshot>,
    stop: (request: PtyStopRequest) => ipcRenderer.invoke("pty:stop", request) as Promise<void>,
    kill: (sessionId: string) => ipcRenderer.invoke("pty:kill", sessionId) as Promise<void>,
    close: (sessionId: string) => ipcRenderer.invoke("pty:close", sessionId) as Promise<void>,
    input: (request: PtyInputRequest) => ipcRenderer.invoke("pty:input", request) as Promise<void>,
    resize: (request: PtyResizeRequest) =>
      ipcRenderer.invoke("pty:resize", request) as Promise<void>,
    clear: (sessionId: string) => ipcRenderer.invoke("pty:clear", sessionId) as Promise<void>,
    list: () => ipcRenderer.invoke("pty:list") as Promise<PtySessionSnapshot[]>,
    getBuffer: (sessionId: string) =>
      ipcRenderer.invoke("pty:getBuffer", sessionId) as Promise<PtyBufferSnapshot | null>,
    onData: (callback: (event: PtyDataEvent) => void) => onIpc("pty:data", callback),
    onExit: (callback: (event: PtyExitEvent) => void) => onIpc("pty:exit", callback),
    onError: (callback: (event: PtyErrorEvent) => void) => onIpc("pty:error", callback),
    onSnapshot: (callback: (snapshot: PtySessionSnapshot) => void) =>
      onIpc("pty:snapshot", callback),
  },
};

contextBridge.exposeInMainWorld("maibotDesktop", desktopBridge);
