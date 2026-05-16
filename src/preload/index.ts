import { contextBridge, ipcRenderer } from "electron";
import type {
  CloseAction,
  DesktopBridge,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
  LogEntry,
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatEvent,
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
  ManagedPythonPackageName,
  ModuleUpdateResult,
  ModuleSourceConfig,
  ModuleSourceUpdate,
  ModuleTagOption,
  PythonOverridesState,
  PythonRuntimeCandidate,
  PythonPackageInstallRequest,
  PythonPackageInstallResult,
  PythonPackageVersionList,
  PtyDataEvent,
  PtyErrorEvent,
  PtyExitEvent,
  PtyInputRequest,
  PtyResizeRequest,
  PtySessionSnapshot,
  PtyStartRequest,
  PtyStopRequest,
  QqBackend,
  QqAccountSetupRequest,
  RuntimePathConfig,
  RuntimePathKey,
  RuntimePathUpdate,
  RuntimeResourcePathChangeResult,
  RuntimeResourcePathKey,
  ServiceCommandConfig,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceId,
  StartupAgreementConfirmResult,
  StartupAgreementState,
  TerminalSettings,
  WindowState,
} from "../shared/contracts";

function onIpc<T>(channel: string, callback: (event: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const desktopBridge: DesktopBridge = {
  getSnapshot: () => ipcRenderer.invoke("desktop:getSnapshot") as Promise<DesktopSnapshot>,
  openLogsDirectory: () => ipcRenderer.invoke("desktop:openLogsDirectory") as Promise<void>,
  openPath: (path: string) => ipcRenderer.invoke("desktop:openPath", path) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke("desktop:openExternal", url) as Promise<void>,
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
  window: {
    minimize: () => ipcRenderer.invoke("desktop:window:minimize") as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke("desktop:window:toggleMaximize") as Promise<void>,
    close: () => ipcRenderer.invoke("desktop:window:close") as Promise<void>,
    getState: () => ipcRenderer.invoke("desktop:window:getState") as Promise<WindowState>,
    onState: (callback: (state: WindowState) => void) => onIpc("desktop:window-state", callback),
  },
  init: {
    getState: () => ipcRenderer.invoke("init:getState") as Promise<InitState>,
    repair: () => ipcRenderer.invoke("init:repair") as Promise<InitRepairResult>,
    setQqBackend: (backend: QqBackend) =>
      ipcRenderer.invoke("init:setQqBackend", backend) as Promise<InitState>,
    setQqAccount: (request: QqAccountSetupRequest) =>
      ipcRenderer.invoke("init:setQqAccount", request) as Promise<InitState>,
  },
  agreements: {
    getState: () => ipcRenderer.invoke("agreements:getState") as Promise<StartupAgreementState>,
    confirm: () => ipcRenderer.invoke("agreements:confirm") as Promise<StartupAgreementConfirmResult>,
  },
  modules: {
    updateMaiBot: (tag?: string) => ipcRenderer.invoke("modules:updateMaibot", tag) as Promise<ModuleUpdateResult>,
    listMaiBotTags: () => ipcRenderer.invoke("modules:listMaibotTags") as Promise<ModuleTagOption[]>,
    getSourceConfig: () => ipcRenderer.invoke("modules:getSourceConfig") as Promise<ModuleSourceConfig>,
    saveSourceConfig: (config: ModuleSourceUpdate) =>
      ipcRenderer.invoke("modules:saveSourceConfig", config) as Promise<ModuleSourceConfig>,
  },
  data: {
    importMaiBotDatabase: () =>
      ipcRenderer.invoke("data:importMaibotDb") as Promise<MaiBotDataImportResult | null>,
    importMaiBotConfig: (fileName: MaiBotConfigFileName) =>
      ipcRenderer.invoke(
        "data:importMaibotConfig",
        fileName,
      ) as Promise<MaiBotConfigImportResult | null>,
    resetMaiBotData: () =>
      ipcRenderer.invoke("data:resetMaibotData") as Promise<MaiBotDataResetResult>,
  },
  plugins: {
    listMarket: (serviceUrl?: string, options?: MaiBotPluginListOptions) =>
      ipcRenderer.invoke("plugins:listMarket", serviceUrl, options) as Promise<MaiBotPluginListResult>,
    listInstalled: (serviceUrl?: string) =>
      ipcRenderer.invoke("plugins:listInstalled", serviceUrl) as Promise<MaiBotInstalledPlugin[]>,
    install: (request: MaiBotPluginOperationRequest) =>
      ipcRenderer.invoke("plugins:install", request) as Promise<MaiBotPluginOperationResult>,
    update: (request: MaiBotPluginOperationRequest) =>
      ipcRenderer.invoke("plugins:update", request) as Promise<MaiBotPluginOperationResult>,
    uninstall: (pluginId: string) =>
      ipcRenderer.invoke("plugins:uninstall", pluginId) as Promise<MaiBotPluginOperationResult>,
    getConfig: (pluginId: string) =>
      ipcRenderer.invoke("plugins:getConfig", pluginId) as Promise<MaiBotPluginConfigState>,
    saveConfig: (pluginId: string, config: Record<string, MaiBotPluginConfigValue>) =>
      ipcRenderer.invoke("plugins:saveConfig", pluginId, config) as Promise<MaiBotPluginConfigSaveResult>,
    getReadme: (pluginId: string, repositoryUrl?: string) =>
      ipcRenderer.invoke("plugins:getReadme", pluginId, repositoryUrl) as Promise<MaiBotPluginReadmeResult>,
    getStats: (pluginId: string) =>
      ipcRenderer.invoke("plugins:getStats", pluginId) as Promise<MaiBotPluginStats | null>,
  },
  pythonDeps: {
    getState: () => ipcRenderer.invoke("pythonDeps:getState") as Promise<PythonOverridesState>,
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
    saveRuntimePathConfig: (config: RuntimePathUpdate) =>
      ipcRenderer.invoke("services:saveRuntimePathConfig", config) as Promise<RuntimePathConfig[]>,
    resetRuntimePathConfig: (key: RuntimePathKey) =>
      ipcRenderer.invoke("services:resetRuntimePathConfig", key) as Promise<RuntimePathConfig[]>,
    listPythonRuntimeCandidates: () =>
      ipcRenderer.invoke("services:listPythonRuntimeCandidates") as Promise<PythonRuntimeCandidate[]>,
    selectPythonRuntimePath: () =>
      ipcRenderer.invoke("services:selectPythonRuntimePath") as Promise<string | null>,
    saveTerminalSettings: (settings: TerminalSettings) =>
      ipcRenderer.invoke("services:saveTerminalSettings", settings) as Promise<TerminalSettings>,
    onSnapshot: (callback: (services: ServiceDescriptor[]) => void) =>
      onIpc("services:snapshot", callback),
  },
  resources: {
    migratePath: (key: RuntimeResourcePathKey) =>
      ipcRenderer.invoke("resources:migratePath", key) as Promise<RuntimeResourcePathChangeResult | null>,
    selectPath: (key: RuntimeResourcePathKey) =>
      ipcRenderer.invoke("resources:selectPath", key) as Promise<RuntimeResourcePathChangeResult | null>,
    savePath: (key: RuntimeResourcePathKey, path: string) =>
      ipcRenderer.invoke("resources:savePath", key, path) as Promise<RuntimeResourcePathChangeResult>,
    resetPath: (key: RuntimeResourcePathKey) =>
      ipcRenderer.invoke("resources:resetPath", key) as Promise<RuntimeResourcePathChangeResult>,
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
    listMessages: () =>
      ipcRenderer.invoke("localChat:listMessages") as Promise<LocalChatMessageEvent[]>,
    onEvent: (callback: (event: LocalChatEvent) => void) => onIpc("localChat:event", callback),
  },
  pty: {
    start: (request: PtyStartRequest) =>
      ipcRenderer.invoke("pty:start", request) as Promise<PtySessionSnapshot>,
    stop: (request: PtyStopRequest) => ipcRenderer.invoke("pty:stop", request) as Promise<void>,
    kill: (sessionId: string) => ipcRenderer.invoke("pty:kill", sessionId) as Promise<void>,
    input: (request: PtyInputRequest) => ipcRenderer.invoke("pty:input", request) as Promise<void>,
    resize: (request: PtyResizeRequest) =>
      ipcRenderer.invoke("pty:resize", request) as Promise<void>,
    clear: (sessionId: string) => ipcRenderer.invoke("pty:clear", sessionId) as Promise<void>,
    list: () => ipcRenderer.invoke("pty:list") as Promise<PtySessionSnapshot[]>,
    getBuffer: (sessionId: string) =>
      ipcRenderer.invoke("pty:getBuffer", sessionId) as Promise<string>,
    onData: (callback: (event: PtyDataEvent) => void) => onIpc("pty:data", callback),
    onExit: (callback: (event: PtyExitEvent) => void) => onIpc("pty:exit", callback),
    onError: (callback: (event: PtyErrorEvent) => void) => onIpc("pty:error", callback),
    onSnapshot: (callback: (snapshot: PtySessionSnapshot) => void) =>
      onIpc("pty:snapshot", callback),
  },
};

contextBridge.exposeInMainWorld("maibotDesktop", desktopBridge);
