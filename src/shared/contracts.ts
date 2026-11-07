export type ServiceId = "maibot" | "napcat";
export type QqBackend = "napcat" | "snowluma";
export type QqProtocol = QqBackend | "official";

export type ServiceStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type ServiceHealth =
  | "unknown"
  | "checking"
  | "ready"
  | "unreachable"
  | "conflict";

export type LogSource = ServiceId | "desktop";

export type LogStream = "stdout" | "stderr" | "system";

export type InitCheckStatus = "ok" | "warning" | "error";

export type CloseAction = "minimize" | "quit";

export type TerminalMode = "embedded" | "external";

export type PtySessionStatus =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "error";

export type PtyEncoding =
  | "auto"
  | "utf8"
  | "gbk"
  | "gb18030"
  | "big5"
  | "shiftjis"
  | "euckr"
  | "utf16le";

export interface ServiceDescriptor {
  id: ServiceId;
  name: string;
  port: number;
  ports: number[];
  url: string;
  status: ServiceStatus;
  health: ServiceHealth;
  managed: boolean;
  desired?: boolean;
  restartAttempts?: number;
  pid?: number;
  terminalMode?: TerminalMode;
  detail?: string;
  cwd?: string;
  command?: string[];
  logPath?: string;
  startedAt?: number;
  stoppedAt?: number;
  error?: string;
}

export interface ServiceCommandConfig {
  serviceId: ServiceId;
  serviceName: string;
  cwd: string;
  commandLine: string;
  defaultCwd: string;
  defaultCommandLine: string;
  customized: boolean;
}

export interface ServiceCommandUpdate {
  serviceId: ServiceId;
  cwd: string;
  commandLine: string;
}

export type RuntimeResourcePathKey = "maibot" | "napcat" | "snowluma";

export interface RuntimeResourcePathConfig {
  key: RuntimeResourcePathKey;
  label: string;
  value: string;
  defaultValue: string;
  customized: boolean;
}

export type ResourcePathMode = "existing" | "copy";
export interface ResourcePathPlan {
  key: RuntimeResourcePathKey;
  mode: ResourcePathMode;
  sourcePath: string;
  targetPath: string;
  fileCount: number;
  totalBytes: number;
  availableBytes?: number;
  unchanged: boolean;
  sourceFingerprint?: string;
}
export interface ResourcePathProgress {
  operationId: string;
  key: RuntimeResourcePathKey;
  stage: "checking" | "copying" | "committing" | "rolling-back" | "completed" | "cancelled" | "failed";
  copiedFiles: number;
  copiedBytes: number;
  totalFiles: number;
  totalBytes: number;
  currentFile?: string;
  error?: string;
}

export interface RuntimeResourcePathChangeResult {
  key: RuntimeResourcePathKey;
  previousPath: string;
  path: string;
  defaultPath: string;
  copiedEntries: string[];
  copiedFiles: number;
  copiedBytes: number;
  changedAt: number;
}

export interface TerminalSettings {
  useEmbeddedTerminal: boolean;
  fontSize: number;
}

export interface ServiceStartupSettings {
  useLocalDashboard: boolean;
  autoStartServices?: boolean;
  /** Undefined when login items are unsupported or this is a development build. */
  openAtLogin?: boolean;
}

export type TopStartActionMode = "ask" | "maibot-only" | "with-qq-backend";

export interface LauncherUiSettings {
  topStartActionMode: TopStartActionMode;
}

export type AppIconId = "soft" | "sprout" | "bean";

export interface AppIconOption {
  id: AppIconId;
  label: string;
  description: string;
  previewUrl?: string;
}

export interface AppIconSettings {
  selectedIconId: AppIconId;
  options: AppIconOption[];
}

export interface NetworkProxySettings {
  enabled: boolean;
  port: number;
}

export interface RuntimePaths {
  protocolSettingsRoot?: string;
  instanceRegistryRoot?: string;
  activeInstanceId?: string;
  activeInstanceName?: string;
  /** Explicit local development selection; packaged applications retain instance compatibility. */
  maibotDevMode?: "pypi" | "source";
  installRoot: string;
  userDataRoot: string;
  defaultResourceRoot: string;
  resourceRoot: string;
  modulesRoot: string;
  defaultMaibotRoot: string;
  maibotRoot: string;
  defaultNapcatRoot: string;
  napcatRoot: string;
  defaultSnowlumaRoot: string;
  snowlumaRoot: string;
  bundledModulesRoot: string;
  runtimeRoot: string;
  pythonEnvRoot: string;
  logsRoot: string;
}

export interface LauncherInstance {
  development?: { mode: "pypi" | "source"; pythonRoot: string; localDashboard: boolean };
  id: string;
  name: string;
  settingsRoot: string;
  resourceRoot: string;
  paths: Record<RuntimeResourcePathKey, string>;
  legacy?: boolean;
  attached?: boolean;
}
export interface LauncherInstanceState {
  version: 1;
  ignoredLegacyRoots?: string[];
  activeId: string;
  instances: LauncherInstance[];
}
export interface InstanceCreateRequest {
  name: string;
  mode: "new" | "existing";
  paths: { maibot: string; napcat?: string; snowluma?: string };
}

export interface ModuleRuntimeVersions {
  snowlumaLocal?: string;
  snowlumaBundled?: string;
  maibotLocal?: string;
  maibotLocalSource?: "pyproject" | "pypi" | "unknown";
  maibotDeploymentMode?: "source" | "pypi";
  maibotCanRollback?: boolean;
  maibotRollbackRestoresData?: boolean;
  maibotSelectedChannel?: "stable" | "custom";
  maibotSelectedTarget?: ModuleUpdateTarget;
  maibotSelectedAt?: number;
  maibotLatestStableTag?: string;
  maibotLatestPrereleaseTag?: string;
  maibotRemoteSource?: string;
  maibotRemoteError?: string;
  dashboardPythonEnv?: string;
  dashboardPythonEnvSource?: "python-env" | "unknown";
  dashboardLatestPypi?: string;
  dashboardLatestStablePypi?: string;
  dashboardLatestPrereleasePypi?: string;
  dashboardPypiSource?: string;
}

export interface DesktopSnapshot {
  paths: RuntimePaths;
  runtimeOperation: string | null;
  services: ServiceDescriptor[];
  serviceCommands: ServiceCommandConfig[];
  runtimeResourcePathConfigs: RuntimeResourcePathConfig[];
  terminalSettings: TerminalSettings;
  serviceStartupSettings: ServiceStartupSettings;
  launcherUiSettings: LauncherUiSettings;
  appIconSettings: AppIconSettings;
  networkProxySettings: NetworkProxySettings;
  appVersion: string;
  appLatestTag?: string;
  appLatestSource?: string;
  moduleVersions: ModuleRuntimeVersions;
  platform: NodeJS.Platform;
  windowState: WindowState;
  initState: InitState;
  startupAgreement: StartupAgreementState;
  recentLogs: LogEntry[];
}

export interface SystemPerformanceSnapshot {
  cpuCores: number;
  cpuModel: string;
  cpuUsagePercent?: number;
  loadAverage: number[];
  memoryFreeBytes: number;
  memoryTotalBytes: number;
  memoryUsedPercent: number;
  uptimeSeconds: number;
}

export interface LauncherUpdateInfo {
  currentVersion: string;
  latestTag?: string;
  latestVersion?: string;
  downloadTag?: string;
  downloadVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  assetName?: string;
  assetSize?: number;
  latestAssetUnavailable?: boolean;
  available: boolean;
  checkedAt: number;
  source: string;
}

export interface MaiBotUpdateInfo {
  currentVersion?: string;
  currentTag?: string;
  target: ModuleUpdateTarget;
  targetTag?: string;
  releaseName?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  available: boolean;
  checkedAt: number;
  source: string;
}

export type LauncherUpdateDownloadPhase =
  | "checking"
  | "downloading"
  | "starting"
  | "completed";

export interface LauncherUpdateDownloadProgress {
  phase: LauncherUpdateDownloadPhase;
  assetName?: string;
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface LauncherUpdateApplyResult {
  update: LauncherUpdateInfo;
  installerPath: string;
  started: boolean;
  willQuit: boolean;
}

export interface WindowState {
  isMiniMode?: boolean;
  isMaximized: boolean;
  isFullScreen: boolean;
  isFocused: boolean;
}

export type WindowResizeEdge =
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "top-left"
  | "top-right"
  | "bottom-right"
  | "bottom-left";

export interface InitCheck {
  id: string;
  label: string;
  status: InitCheckStatus;
  detail: string;
  path?: string;
  actionLabel?: string;
  actionUrl?: string;
}

export type MaiBotSetupStatus = "pending" | "complete";

export interface InitState {
  isReady: boolean;
  qqAccount?: string;
  qqBackend: QqBackend;
  qqProtocol?: QqProtocol;
  qqOfficialConfigured?: boolean;
  napCatDownloadRequired?: boolean;
  messagePlatformConfigured: boolean;
  checks: InitCheck[];
  repairedAt?: number;
}

export interface QqProtocolOptions {
  officialCredentials?: { appId: string; appSecret: string };
}

export interface InitRepairResult {
  state: InitState;
  changedFiles: string[];
}

export type AgreementDocumentId = "eula" | "privacy";

export interface AgreementDocument {
  id: AgreementDocumentId;
  title: string;
  fileName: string;
  sourcePath: string;
  content: string;
  exists: boolean;
  error?: string;
}

export interface StartupAgreementState {
  isDismissed: boolean;
  documents: AgreementDocument[];
}

export interface StartupAgreementDismissResult {
  state: StartupAgreementState;
  changedFiles: string[];
}

export interface MaiBotDataResetResult {
  dataDir: string;
  removedEntries: string[];
  clearedAt: number;
}

export type MaiBotStorageCleanupTarget = "images" | "emoji" | "marketCache" | "logs";

export type MaiBotStorageCategoryKey =
  | "database"
  | "images"
  | "emoji"
  | "memory"
  | "plugins"
  | "prompts"
  | "webui"
  | "marketCache"
  | "logs"
  | "other";

export interface MaiBotStorageCategory {
  key: MaiBotStorageCategoryKey;
  label: string;
  description: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  latestModifiedAt?: number;
  cleanupTarget?: MaiBotStorageCleanupTarget;
}

export interface MaiBotStorageStats {
  maibotRoot: string;
  dataDir: string;
  logsDir: string;
  totalSizeBytes: number;
  categories: MaiBotStorageCategory[];
  scannedAt: number;
}

export interface MaiBotStorageCleanupResult {
  target: MaiBotStorageCleanupTarget;
  removedEntries: string[];
  removedBytes: number;
  cleanedAt: number;
}

export interface SnowLumaResetResult {
  snowlumaRoot: string;
  bundledRoot: string;
  removed: boolean;
  copied: boolean;
  resetAt: number;
}

export type QqComponentUpgradeId = "napcat" | "snowluma";

export interface QqComponentUpgradeEntry {
  id: QqComponentUpgradeId;
  name: string;
  root: string;
  bundledRoot: string;
  preservedEntries: string[];
  copied: boolean;
  skipped: boolean;
  upgradedAt: number;
}

export interface QqComponentUpgradeResult {
  components: QqComponentUpgradeEntry[];
  upgradedAt: number;
}

export interface LauncherResetResult {
  mode: "settings" | "all";
  root: string;
  removedEntries: string[];
  resetAt: number;
}

export type MaiBotConfigFileName = "bot_config.toml" | "model_config.toml";

export interface MaiBotConfigImportResult {
  fileName: MaiBotConfigFileName;
  sourcePath: string;
  destPath: string;
  backupPath?: string;
  sizeBytes: number;
  importedAt: number;
}

export interface QqAccountSetupRequest {
  qqAccount: string;
  qqBackend?: QqBackend;
  websocketToken?: string;
}

export type MessagePlatformLoginInfo = Record<QqBackend, { qqAccount?: string; webuiToken?: string }>;

export interface ModuleUpdateResult {
  moduleId: "maibot";
  moduleName: string;
  cwd: string;
  remote?: string;
  before?: string;
  after?: string;
  changed: boolean;
  output: string[];
  updatedAt: number;
  /** 实际安装来源为 Python 包索引。 */
  source: "remote";
  /** 更新失败或部分完成时面向用户展示的提示文本。 */
  warning?: string;
}

export type MaiBotModuleUpdatePhase =
  | "preparing"
  | "installing"
  | "installing-dependencies"
  | "validating"
  | "switching"
  | "completed"
  | "failed";

export interface MaiBotModuleUpdateProgress {
  phase: MaiBotModuleUpdatePhase;
  percent: number;
  label: string;
  detail?: string;
  /** 完整原始错误，供更新窗口展开查看和复制。 */
  errorDetails?: string;
  cleanupWarning?: string;
  /** 适合追加到前端更新记录中的单条阶段日志。 */
  log?: string;
  updatedAt: number;
}

export interface ModuleTagOption {
  name: string;
  isPrerelease: boolean;
}

export interface ModuleUpdateTarget {
  type: "package";
  name: string;
}

export type ManagedPythonPackageName = "maibot-dashboard" | "maim-message" | "maibot";

export interface ManagedPythonPackage {
  name: ManagedPythonPackageName;
  label: string;
}

export type PythonPackageSourcePreset = "tuna" | "pypi" | "aliyun" | (string & {});

export interface PythonPackageSourceOption {
  preset: PythonPackageSourcePreset;
  label: string;
  url: string;
}

export type SourceSettingsGroup = "python";

export interface ManagedSourceEntry {
  id: string;
  label: string;
  url: string;
  trustedHost?: string;
  builtIn?: boolean;
}

export interface SourceSettings {
  python: ManagedSourceEntry[];
}

export interface SourceSettingsUpdate {
  python?: ManagedSourceEntry[];
}

export interface PythonPackageVersion {
  version: string;
  isPrerelease: boolean;
  isDev: boolean;
  uploadedAt?: string;
  uploadedAtMs?: number;
  requiresPython?: string[];
}

export interface PythonPackageVersionList {
  packageName: ManagedPythonPackageName;
  sourceUrl: string;
  versions: PythonPackageVersion[];
  output: string[];
  fetchedAt: number;
}

export interface PythonPackageInstallRequest {
  packageName: ManagedPythonPackageName;
  version: string;
}

export interface PythonPackageInstallResult {
  packageName: ManagedPythonPackageName;
  version: string;
  sourceUrl: string;
  targetDir: string;
  output: string[];
  installedAt: number;
}

export interface PythonEnvironmentState {
  root: string;
  sourcePreset: PythonPackageSourcePreset;
  sourceUrl: string;
  sourceOptions: PythonPackageSourceOption[];
  packages: ManagedPythonPackage[];
}

export interface LogEntry {
  id: string;
  source: LogSource;
  stream: LogStream;
  message: string;
  timestamp: number;
}

export interface PtyStartRequest {
  id?: string;
  title?: string;
  cwd?: string;
  command?: string[];
  commandLine?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  encoding?: PtyEncoding;
  env?: Record<string, string>;
}

export interface PtyStopRequest {
  sessionId: string;
  forceAfterMs?: number;
}

export interface PtyResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface PtyInputRequest {
  sessionId: string;
  data: string;
}

export interface PtySessionSnapshot {
  id: string;
  title: string;
  cwd: string;
  command: string[];
  cols: number;
  rows: number;
  encoding: PtyEncoding;
  status: PtySessionStatus;
  pid?: number;
  exitCode?: number;
  signal?: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface PtyOutputChunk {
  data: string;
  cols: number;
  rows: number;
  sequence: number;
}

export interface PtyBufferSnapshot {
  chunks: PtyOutputChunk[];
  lastSequence: number;
  cols: number;
  rows: number;
  startedAt: number;
}

export interface PtyDataEvent extends PtyOutputChunk {
  sessionId: string;
  startedAt: number;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
}

export interface PtyErrorEvent {
  sessionId: string;
  message: string;
}

export interface DesktopBridge {
  webuiPreloadUrl: string;
  readonly platform: NodeJS.Platform;
  getSnapshot: () => Promise<DesktopSnapshot>;
  getSystemPerformance: () => Promise<SystemPerformanceSnapshot>;
  openLogsDirectory: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  clearWebviewCache: () => Promise<void>;
  chooseCloseAction: (action: CloseAction) => Promise<void>;
  onCloseRequest: (callback: () => void) => () => void;
  onSnapshot: (callback: (snapshot: DesktopSnapshot) => void) => () => void;
  onQqAccountSetupRequired: (callback: (backend: QqBackend) => void) => () => void;
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<WindowState>;
    close: () => Promise<void>;
    setMiniMode: (enabled: boolean) => Promise<WindowState>;
    startResize: (edge: WindowResizeEdge, screenX: number, screenY: number) => Promise<WindowState>;
    resizeTo: (screenX: number, screenY: number) => Promise<WindowState>;
    finishResize: () => Promise<WindowState>;
    getState: () => Promise<WindowState>;
    onState: (callback: (state: WindowState) => void) => () => void;
  };
  init: {
    getState: () => Promise<InitState>;
    getMaiBotSetupStatus: () => Promise<MaiBotSetupStatus>;
    repair: () => Promise<InitRepairResult>;
  };
  protocols: {
    getLoginInfo: () => Promise<MessagePlatformLoginInfo>;
    saveQqBackendAccount: (backend: QqBackend, account: string) => Promise<void>;
    saveSnowLumaWebuiPassword: (password: string) => Promise<void>;
    setQqBackend: (backend: QqBackend) => Promise<InitState>;
    setQqAccount: (request: QqAccountSetupRequest) => Promise<InitState>;
    resetSnowLuma: () => Promise<SnowLumaResetResult>;
    upgradeQqComponents: (component?: QqComponentUpgradeId) => Promise<QqComponentUpgradeResult>;
  };
  adapters: {
    syncQqConnections: () => Promise<InitRepairResult>;
    setQqProtocol: (protocol: QqProtocol, options?: QqProtocolOptions) => Promise<InitState>;
    setEnabled: (adapter: "onebot" | "official", enabled: boolean) => Promise<void>;
  };
  agreements: {
    getState: () => Promise<StartupAgreementState>;
    dismiss: () => Promise<StartupAgreementDismissResult>;
  };
  modules: {
    refreshVersions: () => Promise<DesktopSnapshot>;
    checkMaiBotUpdate: (target: ModuleUpdateTarget) => Promise<MaiBotUpdateInfo>;
    updateMaiBot: (target?: ModuleUpdateTarget) => Promise<ModuleUpdateResult>;
    rollbackMaiBot: () => Promise<void>;
    onMaiBotUpdateProgress: (callback: (progress: MaiBotModuleUpdateProgress) => void) => () => void;
    listMaiBotTags: () => Promise<ModuleTagOption[]>;
  };
  data: {
    importMaiBotConfig: (fileName: MaiBotConfigFileName) => Promise<MaiBotConfigImportResult | null>;
    resetMaiBotData: () => Promise<MaiBotDataResetResult>;
  };
  launcher: {
    saveNetworkProxySettings: (settings: NetworkProxySettings) => Promise<NetworkProxySettings>;
    saveUiSettings: (settings: LauncherUiSettings) => Promise<LauncherUiSettings>;
    getSourceSettings: () => Promise<SourceSettings>;
    saveSourceSettings: (settings: SourceSettingsUpdate) => Promise<SourceSettings>;
    resetSourceSettings: () => Promise<SourceSettings>;
    selectAppIcon: (iconId: AppIconId) => Promise<AppIconSettings>;
    checkUpdate: () => Promise<LauncherUpdateInfo>;
    downloadAndInstallUpdate: () => Promise<LauncherUpdateApplyResult>;
    quit: () => Promise<void>;
    onDownloadProgress: (callback: (progress: LauncherUpdateDownloadProgress) => void) => () => void;
    resetSettings: () => Promise<LauncherResetResult>;
    resetAll: () => Promise<LauncherResetResult>;
  };
  pythonDeps: {
    getState: () => Promise<PythonEnvironmentState>;
    saveSourcePreset: (preset: PythonPackageSourcePreset) => Promise<PythonEnvironmentState>;
    listVersions: (packageName: ManagedPythonPackageName) => Promise<PythonPackageVersionList>;
    installVersion: (request: PythonPackageInstallRequest) => Promise<PythonPackageInstallResult>;
  };
  services: {
    start: (serviceId: ServiceId) => Promise<ServiceDescriptor>;
    stop: (serviceId: ServiceId) => Promise<ServiceDescriptor>;
    restart: (serviceId: ServiceId) => Promise<ServiceDescriptor>;
    startAll: () => Promise<ServiceDescriptor[]>;
    stopAll: () => Promise<ServiceDescriptor[]>;
    refresh: () => Promise<ServiceDescriptor[]>;
    saveCommandConfig: (config: ServiceCommandUpdate) => Promise<ServiceCommandConfig[]>;
    resetCommandConfig: (serviceId: ServiceId) => Promise<ServiceCommandConfig[]>;
    saveTerminalSettings: (settings: TerminalSettings) => Promise<TerminalSettings>;
    saveStartupSettings: (settings: ServiceStartupSettings) => Promise<ServiceStartupSettings>;
    onSnapshot: (callback: (services: ServiceDescriptor[]) => void) => () => void;
  };
  resources: {
    listInstances: () => Promise<LauncherInstanceState | null>;
    createInstance: (request: InstanceCreateRequest) => Promise<LauncherInstanceState>;
    selectInstance: (id: string) => Promise<void>;
    renameInstance: (id: string, name: string) => Promise<LauncherInstanceState>;
    removeInstance: (id: string) => Promise<LauncherInstanceState>;
    choosePath: (key: RuntimeResourcePathKey, mode: ResourcePathMode) => Promise<string | null>;
    inspectPath: (key: RuntimeResourcePathKey, path: string, mode: ResourcePathMode) => Promise<ResourcePathPlan>;
    applyPath: (plan: ResourcePathPlan) => Promise<RuntimeResourcePathChangeResult>;
    cancelOperation: (operationId: string) => Promise<boolean>;
    getProgress: () => Promise<ResourcePathProgress | null>;
    onProgress: (callback: (progress: ResourcePathProgress) => void) => () => void;
  };
  logs: {
    list: () => Promise<LogEntry[]>;
    clear: () => Promise<void>;
    onEntry: (callback: (entry: LogEntry) => void) => () => void;
  };
  pty: {
    start: (request: PtyStartRequest) => Promise<PtySessionSnapshot>;
    stop: (request: PtyStopRequest) => Promise<void>;
    kill: (sessionId: string) => Promise<void>;
    close: (sessionId: string) => Promise<void>;
    input: (request: PtyInputRequest) => Promise<void>;
    resize: (request: PtyResizeRequest) => Promise<void>;
    clear: (sessionId: string) => Promise<void>;
    list: () => Promise<PtySessionSnapshot[]>;
    getBuffer: (sessionId: string) => Promise<PtyBufferSnapshot | null>;
    onData: (callback: (event: PtyDataEvent) => void) => () => void;
    onExit: (callback: (event: PtyExitEvent) => void) => () => void;
    onError: (callback: (event: PtyErrorEvent) => void) => () => void;
    onSnapshot: (callback: (snapshot: PtySessionSnapshot) => void) => () => void;
  };
}
