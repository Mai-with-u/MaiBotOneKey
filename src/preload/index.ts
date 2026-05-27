import { contextBridge, ipcRenderer } from "electron";
import type {
  CloseAction,
  AppIconId,
  AppIconSettings,
  DesktopBridge,
  DesktopSnapshot,
  InitRepairResult,
  InitState,
  LauncherUpdateApplyResult,
  LauncherUpdateInfo,
  LogEntry,
  Live2dModelImportResult,
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatEvent,
  LocalChatMessageEvent,
  LocalChatSendRequest,
  LauncherResetResult,
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  MaiBotInstalledPlugin,
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
  MaiBotPluginDownloadResult,
  MaiBotPluginListOptions,
  MaiBotPluginListResult,
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
  ModuleUpdateTarget,
  ModuleUpdateResult,
  NetworkProxySettings,
  OpenCodeSettings,
  ModuleSourceConfig,
  ModuleSourceUpdate,
  ModuleTagOption,
  PythonOverridesState,
  PythonRuntimeCandidate,
  PythonPackageSourcePreset,
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
  SnowLumaResetResult,
  StartupAgreementConfirmResult,
  StartupAgreementState,
  TerminalSettings,
  WindowResizeEdge,
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
    toggleMaximize: () => ipcRenderer.invoke("desktop:window:toggleMaximize") as Promise<WindowState>,
    close: () => ipcRenderer.invoke("desktop:window:close") as Promise<void>,
    setFloatingMode: (enabled: boolean) =>
      ipcRenderer.invoke("desktop:window:setFloatingMode", enabled) as Promise<WindowState>,
    setFloatingPanelExpanded: (expanded: boolean) =>
      ipcRenderer.invoke("desktop:window:setFloatingPanelExpanded", expanded) as Promise<WindowState>,
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
    repair: () => ipcRenderer.invoke("init:repair") as Promise<InitRepairResult>,
    resetSnowLuma: () =>
      ipcRenderer.invoke("init:resetSnowLuma") as Promise<SnowLumaResetResult>,
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
    updateMaiBot: (target?: ModuleUpdateTarget) =>
      ipcRenderer.invoke("modules:updateMaibot", target) as Promise<ModuleUpdateResult>,
    listMaiBotBranches: () => ipcRenderer.invoke("modules:listMaibotBranches") as Promise<ModuleBranchOption[]>,
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
  launcher: {
    saveNetworkProxySettings: (settings: NetworkProxySettings) =>
      ipcRenderer.invoke("launcher:saveNetworkProxySettings", settings) as Promise<NetworkProxySettings>,
    saveOpenCodeSettings: (settings: OpenCodeSettings) =>
      ipcRenderer.invoke("launcher:saveOpenCodeSettings", settings) as Promise<OpenCodeSettings>,
    selectAppIcon: (iconId: AppIconId) =>
      ipcRenderer.invoke("launcher:selectAppIcon", iconId) as Promise<AppIconSettings>,
    checkUpdate: () =>
      ipcRenderer.invoke("launcher:checkUpdate") as Promise<LauncherUpdateInfo>,
    downloadAndInstallUpdate: () =>
      ipcRenderer.invoke("launcher:downloadAndInstallUpdate") as Promise<LauncherUpdateApplyResult>,
    resetSettings: () =>
      ipcRenderer.invoke("launcher:resetSettings") as Promise<LauncherResetResult>,
    resetAll: () =>
      ipcRenderer.invoke("launcher:resetAll") as Promise<LauncherResetResult>,
  },
  live2d: {
    getLibraryRoot: () => ipcRenderer.invoke("live2d:getLibraryRoot") as Promise<string>,
    openLibrary: () => ipcRenderer.invoke("live2d:openLibrary") as Promise<void>,
    importModel: (sourcePath?: string) =>
      ipcRenderer.invoke("live2d:importModel", sourcePath) as Promise<Live2dModelImportResult | null>,
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
    createFromBlueprint: (request: MaiBotPluginBlueprintCreateRequest) =>
      ipcRenderer.invoke("plugins:createFromBlueprint", request) as Promise<MaiBotPluginBlueprintCreateResult>,
    parseToBlueprint: (pluginId: string) =>
      ipcRenderer.invoke("plugins:parseToBlueprint", pluginId) as Promise<MaiBotPluginBlueprintParseResult>,
    listBuilderLibrary: () =>
      ipcRenderer.invoke("plugins:listBuilderLibrary") as Promise<MaiBotPluginBuilderLibraryListResult>,
    saveBuilderLibrary: (request: MaiBotPluginBuilderLibrarySaveRequest) =>
      ipcRenderer.invoke("plugins:saveBuilderLibrary", request) as Promise<MaiBotPluginBuilderLibrarySaveResult>,
    loadBuilderLibrary: (pluginId: string) =>
      ipcRenderer.invoke("plugins:loadBuilderLibrary", pluginId) as Promise<MaiBotPluginBuilderLibraryLoadResult>,
    deleteBuilderLibrary: (pluginId: string) =>
      ipcRenderer.invoke("plugins:deleteBuilderLibrary", pluginId) as Promise<MaiBotPluginBuilderLibraryDeleteResult>,
    exportBuilderBlueprint: (request: MaiBotPluginBuilderBlueprintExportRequest) =>
      ipcRenderer.invoke("plugins:exportBuilderBlueprint", request) as Promise<MaiBotPluginBuilderBlueprintExportResult | null>,
    importBuilderBlueprint: (sourcePath?: string) =>
      ipcRenderer.invoke("plugins:importBuilderBlueprint", sourcePath) as Promise<MaiBotPluginBuilderBlueprintImportResult | null>,
    openBuilderLibrary: () =>
      ipcRenderer.invoke("plugins:openBuilderLibrary") as Promise<void>,
    getConfig: (pluginId: string, serviceUrl?: string) =>
      ipcRenderer.invoke("plugins:getConfig", pluginId, serviceUrl) as Promise<MaiBotPluginConfigState>,
    saveConfig: (pluginId: string, config: Record<string, MaiBotPluginConfigValue>, serviceUrl?: string) =>
      ipcRenderer.invoke("plugins:saveConfig", pluginId, config, serviceUrl) as Promise<MaiBotPluginConfigSaveResult>,
    getReadme: (pluginId: string, repositoryUrl?: string) =>
      ipcRenderer.invoke("plugins:getReadme", pluginId, repositoryUrl) as Promise<MaiBotPluginReadmeResult>,
    getStats: (pluginId: string) =>
      ipcRenderer.invoke("plugins:getStats", pluginId) as Promise<MaiBotPluginStats | null>,
    getUserState: (pluginId: string, userId: string) =>
      ipcRenderer.invoke("plugins:getUserState", pluginId, userId) as Promise<MaiBotPluginUserState | null>,
    getUserStates: (userId: string) =>
      ipcRenderer.invoke("plugins:getUserStates", userId) as Promise<MaiBotPluginUserStates>,
    like: (pluginId: string, userId: string) =>
      ipcRenderer.invoke("plugins:like", pluginId, userId) as Promise<MaiBotPluginVoteResult>,
    dislike: (pluginId: string, userId: string) =>
      ipcRenderer.invoke("plugins:dislike", pluginId, userId) as Promise<MaiBotPluginVoteResult>,
    rate: (pluginId: string, rating: number | null | undefined, comment: string | null | undefined, userId: string) =>
      ipcRenderer.invoke("plugins:rate", pluginId, rating, comment, userId) as Promise<MaiBotPluginRatingResult>,
    recordDownload: (pluginId: string, userId?: string, fingerprint?: string) =>
      ipcRenderer.invoke("plugins:recordDownload", pluginId, userId, fingerprint) as Promise<MaiBotPluginDownloadResult>,
  },
  statistics: {
    getMaiBot: () =>
      ipcRenderer.invoke("statistics:getMaibot") as Promise<MaiBotStatisticSummary>,
  },
  pythonDeps: {
    getState: () => ipcRenderer.invoke("pythonDeps:getState") as Promise<PythonOverridesState>,
    saveSourcePreset: (preset: PythonPackageSourcePreset) =>
      ipcRenderer.invoke("pythonDeps:saveSourcePreset", preset) as Promise<PythonOverridesState>,
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
    close: (sessionId: string) => ipcRenderer.invoke("pty:close", sessionId) as Promise<void>,
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
