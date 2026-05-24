export type ServiceId = "maibot" | "napcat";
export type QqBackend = "napcat" | "snowluma";

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
export type LocalChatConnectionState = "idle" | "connecting" | "connected" | "error";
export type LocalChatMessageRole = "user" | "bot" | "system" | "error";

export type RuntimePathKey = "python" | "git";

export type RuntimePathKind = "file" | "dir";

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

export interface RuntimePathConfig {
  key: RuntimePathKey;
  label: string;
  kind: RuntimePathKind;
  value: string;
  defaultValue: string;
  customized: boolean;
}

export interface RuntimePathUpdate {
  key: RuntimePathKey;
  value: string;
}

export interface PythonRuntimeCandidate {
  path: string;
  source: string;
}

export type RuntimeResourcePathKey = "maibot" | "napcat" | "pythonOverrides";

export interface RuntimeResourcePathConfig {
  key: RuntimeResourcePathKey;
  label: string;
  value: string;
  defaultValue: string;
  customized: boolean;
}

export interface RuntimeResourcePathChangeResult {
  key: RuntimeResourcePathKey;
  previousPath: string;
  path: string;
  defaultPath: string;
  copiedEntries: string[];
  changedAt: number;
}

export interface TerminalSettings {
  useEmbeddedTerminal: boolean;
  fontSize: number;
}

export interface NetworkProxySettings {
  enabled: boolean;
  port: number;
}

export interface RuntimePaths {
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
  defaultPythonOverridesRoot: string;
  pythonOverridesRoot: string;
  live2dRoot: string;
  pluginBuilderRoot: string;
  logsRoot: string;
}

export interface Live2dModelImportResult {
  sourcePath: string;
  modelPath: string;
  modelUrl: string;
  libraryRoot: string;
  copied: boolean;
}

export interface LocalChatSendRequest {
  content: string;
  userName?: string;
  port?: number;
  images?: LocalChatImageAttachment[];
  emojis?: LocalChatImageAttachment[];
  files?: LocalChatFileAttachment[];
  voices?: LocalChatVoiceAttachment[];
}

export interface LocalChatConnectRequest {
  port?: number;
}

export interface LocalChatMessageEvent {
  id: string;
  role: LocalChatMessageRole;
  content: string;
  timestamp: number;
  sender?: string;
  images?: LocalChatImageAttachment[];
  emojis?: LocalChatImageAttachment[];
  files?: LocalChatFileAttachment[];
  voices?: LocalChatVoiceAttachment[];
  quote?: LocalChatMessageQuote;
  kind?: "chat" | "planner";
  final?: boolean;
  plannerTools?: LocalChatPlannerToolCall[];
}

export interface LocalChatMessageQuote {
  messageId?: string;
  sender?: string;
  content: string;
}

export interface LocalChatImageAttachment {
  name?: string;
  mimeType: string;
  base64: string;
  dataUrl?: string;
  size?: number;
}

export interface LocalChatFileAttachment {
  name: string;
  mimeType: string;
  base64: string;
  size: number;
}

export interface LocalChatVoiceAttachment {
  name?: string;
  mimeType: string;
  base64: string;
  dataUrl?: string;
  size?: number;
}

export interface LocalChatPlannerToolCall {
  id?: string;
  name: string;
  arguments?: LocalChatPlannerToolArgument[];
  argumentsText?: string;
  resultText?: string;
  success?: boolean;
  durationMs?: number;
}

export interface LocalChatPlannerToolArgument {
  key: string;
  value: string;
}

export interface LocalChatStateEvent {
  type: "state";
  state: LocalChatConnectionState;
  url?: string;
}

export type LocalChatEvent = LocalChatMessageEvent | LocalChatStateEvent;

export interface ModuleRuntimeVersions {
  maibotLocal?: string;
  maibotLocalSource?: "pyproject" | "unknown";
  maibotLatestStableTag?: string;
  maibotLatestPrereleaseTag?: string;
  maibotLatestLegacyTag?: string;
  maibotRemoteSource?: string;
  dashboardOverride?: string;
  dashboardOverrideSource?: "python-overrides" | "unknown";
  dashboardLatestPypi?: string;
  dashboardLatestStablePypi?: string;
  dashboardLatestPrereleasePypi?: string;
  dashboardPypiSource?: string;
}

export interface DesktopSnapshot {
  paths: RuntimePaths;
  services: ServiceDescriptor[];
  serviceCommands: ServiceCommandConfig[];
  runtimePathConfigs: RuntimePathConfig[];
  runtimeResourcePathConfigs: RuntimeResourcePathConfig[];
  terminalSettings: TerminalSettings;
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

export interface WindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
  isFocused: boolean;
  isFloating?: boolean;
  isFloatingCollapsed?: boolean;
  floatingEdge?: "left" | "right";
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

export interface InitState {
  isReady: boolean;
  qqAccount?: string;
  qqBackend: QqBackend;
  messagePlatformConfigured: boolean;
  checks: InitCheck[];
  repairedAt?: number;
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
  confirmPath: string;
  content: string;
  hash: string;
  exists: boolean;
  confirmed: boolean;
  error?: string;
}

export interface StartupAgreementState {
  isConfirmed: boolean;
  documents: AgreementDocument[];
}

export interface StartupAgreementConfirmResult {
  state: StartupAgreementState;
  changedFiles: string[];
}

export interface MaiBotDataImportResult {
  sourcePath: string;
  destPath: string;
  backupPath?: string;
  sizeBytes: number;
  importedAt: number;
}

export interface MaiBotDataResetResult {
  dataDir: string;
  removedEntries: string[];
  clearedAt: number;
}

export interface SnowLumaResetResult {
  snowlumaRoot: string;
  bundledRoot: string;
  removed: boolean;
  copied: boolean;
  resetAt: number;
}

export interface LauncherResetResult {
  mode: "settings" | "all";
  root: string;
  removedEntries: string[];
  resetAt: number;
}

export interface MaiBotChatStatistic {
  name: string;
  messageCount: number;
}

export interface MaiBotStatisticSummary {
  available: boolean;
  updatedAt: number;
  sourcePath?: string;
  periodLabel?: string;
  startedAt?: string;
  totalOnlineTime?: string;
  totalMessages?: number;
  totalReplies?: number;
  totalRequests?: number;
  totalTokens?: number;
  totalCost?: string;
  costPerMessage?: string;
  costPerReceivedMessage?: string;
  costPerReply?: string;
  costPerHour?: string;
  tokensPerHour?: string;
  chatStats: MaiBotChatStatistic[];
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

export type NapcatChatListMode = "whitelist" | "blacklist";

export interface NapcatAdapterChatConfig {
  enableChatListFilter: boolean;
  showDroppedChatListMessages: boolean;
  groupListType: NapcatChatListMode;
  groupList: string[];
  privateListType: NapcatChatListMode;
  privateList: string[];
  banUserId: string[];
  banQqBot: boolean;
}

export interface NapcatAdapterServerConfig {
  host: string;
  port: number;
  token: string;
  heartbeatInterval: number;
  reconnectDelaySec: number;
  actionTimeoutSec: number;
  connectionId: string;
}

export interface NapcatAdapterPluginOptions {
  enabled: boolean;
  configVersion: string;
}

export interface NapcatAdapterFilterConfig {
  ignoreSelfMessage: boolean;
}

export interface NapcatAdapterConfig {
  plugin: NapcatAdapterPluginOptions;
  server: NapcatAdapterServerConfig;
  chat: NapcatAdapterChatConfig;
  filters: NapcatAdapterFilterConfig;
}

export interface MaiBotPluginManifest {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string | { name?: string; url?: string };
  homepage_url?: string;
  repository_url?: string;
  license?: string;
  urls?: { repository?: string; homepage?: string };
  keywords?: string[];
  categories?: string[];
  host_application?: { min_version?: string; max_version?: string };
  sdk?: { min_version?: string; max_version?: string };
  dependencies?: string[];
  capabilities?: string[];
  manifest_version?: number;
}

export interface MaiBotMarketPlugin {
  id: string;
  manifest: MaiBotPluginManifest;
  installed?: boolean;
  installedVersion?: string;
  source?: string;
  downloads?: number;
  rating?: number;
  likes?: number;
  comment_count?: number;
}

export interface MaiBotInstalledPlugin {
  id: string;
  manifest: MaiBotPluginManifest;
  path: string;
  enabled?: boolean;
  loaded?: boolean;
  load_status?: string;
}

export interface MaiBotPluginListResult {
  installed: MaiBotInstalledPlugin[];
  market: MaiBotMarketPlugin[];
  stats?: Record<string, MaiBotPluginStats>;
}

export interface MaiBotPluginListOptions {
  forceRefresh?: boolean;
}

export interface MaiBotPluginStats {
  plugin_id: string;
  likes: number;
  dislikes: number;
  downloads: number;
  rating: number;
  rating_count: number;
  comment_count: number;
  recent_ratings?: MaiBotPluginRating[];
}

export interface MaiBotPluginRating {
  id?: string;
  user_id: string;
  rating: number;
  comment?: string;
  created_at: string;
  updated_at?: string;
  likes?: number;
  dislikes?: number;
}

export interface MaiBotPluginUserState {
  liked: boolean;
  disliked: boolean;
  rating: number;
  comment: string;
}

export interface MaiBotPluginVoteResult {
  success: boolean;
  error?: string;
  liked?: boolean;
  disliked?: boolean;
  likes?: number;
  dislikes?: number;
  remaining?: number;
}

export interface MaiBotPluginRatingResult {
  success: boolean;
  error?: string;
  user_rating?: number;
  rating?: number;
  rating_count?: number;
  comment_count?: number;
  remaining?: number;
}

export interface MaiBotPluginDownloadResult {
  success: boolean;
  error?: string;
  counted?: boolean;
  downloads?: number;
  remaining?: number;
}

export interface MaiBotPluginReadmeResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface MaiBotPluginOperationRequest {
  pluginId: string;
  repositoryUrl?: string;
  branch?: string;
  latestVersion?: string;
}

export interface MaiBotPluginOperationResult {
  success: boolean;
  message?: string;
  plugin_id?: string;
  plugin_name?: string;
  old_version?: string;
  new_version?: string;
}

export type MaiBotPluginBlueprintScalarType = "string" | "integer" | "float" | "boolean";

export type MaiBotPluginBlueprintComponentKind = "tool" | "command" | "hook";

export type MaiBotPluginBlueprintFlowNodeKind =
  | "send_text"
  | "read_config"
  | "log_info"
  | "set_variable"
  | "if_condition"
  | "compare"
  | "boolean_logic"
  | "math_operation"
  | "join_text"
  | "guard_config"
  | "loop"
  | "wait"
  | "comment"
  | "return_success";

export interface MaiBotPluginBlueprintManifest {
  pluginId: string;
  folderName?: string;
  name: string;
  version: string;
  description: string;
  authorName: string;
  authorUrl: string;
  license: string;
  repositoryUrl: string;
  minHostVersion: string;
  maxHostVersion: string;
  minSdkVersion: string;
  maxSdkVersion: string;
  capabilities: string[];
}

export interface MaiBotPluginBlueprintParameter {
  id: string;
  name: string;
  type: MaiBotPluginBlueprintScalarType;
  description: string;
  required: boolean;
  defaultValue: string;
}

export interface MaiBotPluginBlueprintComponent {
  id: string;
  kind: MaiBotPluginBlueprintComponentKind;
  name: string;
  description: string;
  detail?: string;
  trigger?: string;
  eventType?: string;
  responseText?: string;
  parameters?: MaiBotPluginBlueprintParameter[];
  flowNodes?: MaiBotPluginBlueprintFlowNode[];
  flowEdges?: MaiBotPluginBlueprintFlowEdge[];
}

export interface MaiBotPluginBlueprintFlowNode {
  id: string;
  kind: MaiBotPluginBlueprintFlowNodeKind;
  label: string;
  value?: string;
  configPath?: string;
  leftValue?: string;
  rightValue?: string;
  operator?: string;
  targetName?: string;
}

export interface MaiBotPluginBlueprintFlowEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface MaiBotPluginBlueprintConfigField {
  id: string;
  section: string;
  name: string;
  type: MaiBotPluginBlueprintScalarType;
  label: string;
  description: string;
  defaultValue: string;
}

export interface MaiBotPluginBlueprint {
  manifest: MaiBotPluginBlueprintManifest;
  components: MaiBotPluginBlueprintComponent[];
  configFields: MaiBotPluginBlueprintConfigField[];
}

export interface MaiBotPluginBlueprintFile {
  relativePath: string;
  content: string;
}

export interface MaiBotPluginBlueprintCreateRequest {
  blueprint: MaiBotPluginBlueprint;
  overwrite?: boolean;
}

export interface MaiBotPluginBlueprintCreateResult {
  pluginId: string;
  pluginPath: string;
  files: MaiBotPluginBlueprintFile[];
  overwritten: boolean;
  createdAt: number;
}

export interface MaiBotPluginBlueprintParseResult {
  pluginId: string;
  pluginPath: string;
  blueprint: MaiBotPluginBlueprint;
  parsed: {
    manifest: boolean;
    configFields: number;
    tools: number;
    commands: number;
    unsupportedDecorators: string[];
  };
}

export interface MaiBotPluginBuilderLibraryItem {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  folderName: string;
  path: string;
  blueprintPath: string;
  updatedAt: number;
  createdAt?: number;
  fileCount: number;
}

export interface MaiBotPluginBuilderLibraryListResult {
  root: string;
  plugins: MaiBotPluginBuilderLibraryItem[];
}

export interface MaiBotPluginBuilderLibrarySaveRequest {
  blueprint: MaiBotPluginBlueprint;
  overwrite?: boolean;
}

export interface MaiBotPluginBuilderLibrarySaveResult {
  item: MaiBotPluginBuilderLibraryItem;
  files: MaiBotPluginBlueprintFile[];
  overwritten: boolean;
  savedAt: number;
}

export interface MaiBotPluginBuilderLibraryLoadResult {
  item: MaiBotPluginBuilderLibraryItem;
  blueprint: MaiBotPluginBlueprint;
  files: MaiBotPluginBlueprintFile[];
}

export interface MaiBotPluginBuilderLibraryDeleteResult {
  pluginId: string;
  path: string;
  deletedAt: number;
}

export interface MaiBotPluginBuilderBlueprintExportRequest {
  blueprint: MaiBotPluginBlueprint;
}

export interface MaiBotPluginBuilderBlueprintExportResult {
  pluginId: string;
  filePath: string;
  exportedAt: number;
}

export interface MaiBotPluginBuilderBlueprintImportResult {
  item: MaiBotPluginBuilderLibraryItem;
  blueprint: MaiBotPluginBlueprint;
  files: MaiBotPluginBlueprintFile[];
  sourcePath: string;
  overwritten: boolean;
  importedAt: number;
}

export type MaiBotPluginConfigPrimitive = string | number | boolean | null;

export type MaiBotPluginConfigValue =
  | MaiBotPluginConfigPrimitive
  | MaiBotPluginConfigValue[]
  | { [key: string]: MaiBotPluginConfigValue };

export type MaiBotPluginConfigLocalizedText = string | Record<string, string>;

export interface MaiBotPluginConfigField {
  name: string;
  label: MaiBotPluginConfigLocalizedText;
  path: string[];
  type: "string" | "number" | "boolean" | "array" | "object" | "null";
  value: MaiBotPluginConfigValue;
  description?: MaiBotPluginConfigLocalizedText;
  hint?: MaiBotPluginConfigLocalizedText;
  placeholder?: MaiBotPluginConfigLocalizedText;
  uiType?: string;
  inputType?: string;
  choices?: Array<MaiBotPluginConfigValue | { label?: MaiBotPluginConfigLocalizedText; value: MaiBotPluginConfigValue }>;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  required?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  order?: number;
  icon?: string;
  default?: MaiBotPluginConfigValue;
  itemType?: string;
  minItems?: number;
  maxItems?: number;
}

export interface MaiBotPluginConfigSection {
  name: string;
  title: MaiBotPluginConfigLocalizedText;
  description?: MaiBotPluginConfigLocalizedText;
  icon?: string;
  collapsed?: boolean;
  order?: number;
  fields: MaiBotPluginConfigField[];
}

export interface MaiBotPluginConfigTab {
  id: string;
  title: MaiBotPluginConfigLocalizedText;
  sections: string[];
  icon?: string;
  order?: number;
  badge?: string;
}

export interface MaiBotPluginConfigSchema {
  pluginInfo?: {
    name?: MaiBotPluginConfigLocalizedText;
    version?: string;
    description?: MaiBotPluginConfigLocalizedText;
    author?: string;
  };
  sections: MaiBotPluginConfigSection[];
  layout?: {
    type: "auto" | "tabs" | "pages";
    tabs: MaiBotPluginConfigTab[];
  };
  source?: "runtime" | "local";
}

export interface MaiBotPluginConfigState {
  pluginId: string;
  pluginPath: string;
  configPath: string;
  exists: boolean;
  config: Record<string, MaiBotPluginConfigValue>;
  schema: MaiBotPluginConfigSchema;
  raw: string;
}

export interface MaiBotPluginConfigSaveResult {
  pluginId: string;
  configPath: string;
  config: Record<string, MaiBotPluginConfigValue>;
  schema: MaiBotPluginConfigSchema;
  raw: string;
  backupPath?: string;
  savedAt: number;
}

export interface QqAccountSetupRequest {
  qqAccount: string;
  qqBackend?: QqBackend;
  websocketToken?: string;
  chat?: Partial<NapcatAdapterChatConfig>;
}

export interface ModuleUpdateResult {
  moduleId: "maibot" | "napcat-adapter";
  moduleName: string;
  cwd: string;
  gitPath: string;
  remote?: string;
  branch?: string;
  upstream?: string;
  before?: string;
  after?: string;
  changed: boolean;
  output: string[];
  updatedAt: number;
  /** 实际拉取来源：remote = GitHub 上游；bundled = 一键包内置兜底快照。 */
  source: "remote" | "bundled";
  /** 当回退到 bundled 时面向用户展示的提示文本。 */
  warning?: string;
  /** 当回退到 bundled 时，记录尝试 origin 失败的原始错误信息，便于排查网络问题。 */
  remoteError?: string;
  /** 仅 moduleId="maibot" 时携带；同次更新里同步的子插件结果（如 napcat-adapter）。 */
  plugins?: ModuleUpdateResult[];
}

export interface ModuleTagOption {
  name: string;
  isPrerelease: boolean;
}

export type ModuleSourcePreset = "ghproxy" | "official" | "custom";

export interface ModuleSourceOption {
  preset: Exclude<ModuleSourcePreset, "custom">;
  label: string;
  maibotUrl: string;
  napcatAdapterUrl: string;
}

export interface ModuleSourceConfig {
  preset: ModuleSourcePreset;
  maibotUrl: string;
  napcatAdapterUrl: string;
  options: ModuleSourceOption[];
}

export interface ModuleSourceUpdate {
  preset: ModuleSourcePreset;
  maibotUrl?: string;
  napcatAdapterUrl?: string;
}

export type ManagedPythonPackageName = "maibot-dashboard" | "maim-message";

export interface ManagedPythonPackage {
  name: ManagedPythonPackageName;
  label: string;
}

export type PythonPackageSourcePreset = "tuna" | "pypi" | "aliyun";

export interface PythonPackageSourceOption {
  preset: PythonPackageSourcePreset;
  label: string;
  url: string;
}

export interface PythonPackageVersion {
  version: string;
  isPrerelease: boolean;
  isDev: boolean;
  uploadedAt?: string;
  uploadedAtMs?: number;
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

export interface PythonOverridesState {
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

export interface PtyDataEvent {
  sessionId: string;
  data: string;
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
  getSnapshot: () => Promise<DesktopSnapshot>;
  openLogsDirectory: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  chooseCloseAction: (action: CloseAction) => Promise<void>;
  onCloseRequest: (callback: () => void) => () => void;
  onSnapshot: (callback: (snapshot: DesktopSnapshot) => void) => () => void;
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    setFloatingMode: (enabled: boolean) => Promise<WindowState>;
    setFloatingPanelExpanded: (expanded: boolean) => Promise<WindowState>;
    moveFloatingBy: (deltaX: number, deltaY: number) => Promise<WindowState>;
    moveFloatingTo: (screenX: number, screenY: number, offsetX: number, offsetY: number) => Promise<WindowState>;
    finishFloatingDrag: () => Promise<WindowState>;
    startResize: (edge: WindowResizeEdge, screenX: number, screenY: number) => Promise<WindowState>;
    resizeTo: (screenX: number, screenY: number) => Promise<WindowState>;
    finishResize: () => Promise<WindowState>;
    getState: () => Promise<WindowState>;
    onState: (callback: (state: WindowState) => void) => () => void;
  };
  init: {
    getState: () => Promise<InitState>;
    repair: () => Promise<InitRepairResult>;
    resetSnowLuma: () => Promise<SnowLumaResetResult>;
    setQqBackend: (backend: QqBackend) => Promise<InitState>;
    setQqAccount: (request: QqAccountSetupRequest) => Promise<InitState>;
  };
  agreements: {
    getState: () => Promise<StartupAgreementState>;
    confirm: () => Promise<StartupAgreementConfirmResult>;
  };
  modules: {
    updateMaiBot: (tag?: string) => Promise<ModuleUpdateResult>;
    listMaiBotTags: () => Promise<ModuleTagOption[]>;
    getSourceConfig: () => Promise<ModuleSourceConfig>;
    saveSourceConfig: (config: ModuleSourceUpdate) => Promise<ModuleSourceConfig>;
  };
  data: {
    importMaiBotDatabase: () => Promise<MaiBotDataImportResult | null>;
    importMaiBotConfig: (fileName: MaiBotConfigFileName) => Promise<MaiBotConfigImportResult | null>;
    resetMaiBotData: () => Promise<MaiBotDataResetResult>;
  };
  launcher: {
    saveNetworkProxySettings: (settings: NetworkProxySettings) => Promise<NetworkProxySettings>;
    resetSettings: () => Promise<LauncherResetResult>;
    resetAll: () => Promise<LauncherResetResult>;
  };
  live2d: {
    getLibraryRoot: () => Promise<string>;
    openLibrary: () => Promise<void>;
    importModel: (sourcePath?: string) => Promise<Live2dModelImportResult | null>;
  };
  plugins: {
    listMarket: (serviceUrl?: string, options?: MaiBotPluginListOptions) => Promise<MaiBotPluginListResult>;
    listInstalled: (serviceUrl?: string) => Promise<MaiBotInstalledPlugin[]>;
    install: (request: MaiBotPluginOperationRequest) => Promise<MaiBotPluginOperationResult>;
    update: (request: MaiBotPluginOperationRequest) => Promise<MaiBotPluginOperationResult>;
    uninstall: (pluginId: string) => Promise<MaiBotPluginOperationResult>;
    createFromBlueprint: (request: MaiBotPluginBlueprintCreateRequest) => Promise<MaiBotPluginBlueprintCreateResult>;
    parseToBlueprint: (pluginId: string) => Promise<MaiBotPluginBlueprintParseResult>;
    listBuilderLibrary: () => Promise<MaiBotPluginBuilderLibraryListResult>;
    saveBuilderLibrary: (
      request: MaiBotPluginBuilderLibrarySaveRequest,
    ) => Promise<MaiBotPluginBuilderLibrarySaveResult>;
    loadBuilderLibrary: (pluginId: string) => Promise<MaiBotPluginBuilderLibraryLoadResult>;
    deleteBuilderLibrary: (pluginId: string) => Promise<MaiBotPluginBuilderLibraryDeleteResult>;
    exportBuilderBlueprint: (
      request: MaiBotPluginBuilderBlueprintExportRequest,
    ) => Promise<MaiBotPluginBuilderBlueprintExportResult | null>;
    importBuilderBlueprint: (sourcePath?: string) => Promise<MaiBotPluginBuilderBlueprintImportResult | null>;
    openBuilderLibrary: () => Promise<void>;
    getConfig: (pluginId: string, serviceUrl?: string) => Promise<MaiBotPluginConfigState>;
    saveConfig: (
      pluginId: string,
      config: Record<string, MaiBotPluginConfigValue>,
      serviceUrl?: string,
    ) => Promise<MaiBotPluginConfigSaveResult>;
    getReadme: (pluginId: string, repositoryUrl?: string) => Promise<MaiBotPluginReadmeResult>;
    getStats: (pluginId: string) => Promise<MaiBotPluginStats | null>;
    getUserState: (pluginId: string, userId: string) => Promise<MaiBotPluginUserState | null>;
    like: (pluginId: string, userId: string) => Promise<MaiBotPluginVoteResult>;
    dislike: (pluginId: string, userId: string) => Promise<MaiBotPluginVoteResult>;
    rate: (
      pluginId: string,
      rating: number,
      comment: string | undefined,
      userId: string,
    ) => Promise<MaiBotPluginRatingResult>;
    recordDownload: (
      pluginId: string,
      userId?: string,
      fingerprint?: string,
    ) => Promise<MaiBotPluginDownloadResult>;
  };
  statistics: {
    getMaiBot: () => Promise<MaiBotStatisticSummary>;
  };
  pythonDeps: {
    getState: () => Promise<PythonOverridesState>;
    saveSourcePreset: (preset: PythonPackageSourcePreset) => Promise<PythonOverridesState>;
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
    saveRuntimePathConfig: (config: RuntimePathUpdate) => Promise<RuntimePathConfig[]>;
    resetRuntimePathConfig: (key: RuntimePathKey) => Promise<RuntimePathConfig[]>;
    listPythonRuntimeCandidates: () => Promise<PythonRuntimeCandidate[]>;
    selectPythonRuntimePath: () => Promise<string | null>;
    saveTerminalSettings: (settings: TerminalSettings) => Promise<TerminalSettings>;
    onSnapshot: (callback: (services: ServiceDescriptor[]) => void) => () => void;
  };
  resources: {
    migratePath: (key: RuntimeResourcePathKey) => Promise<RuntimeResourcePathChangeResult | null>;
    selectPath: (key: RuntimeResourcePathKey) => Promise<RuntimeResourcePathChangeResult | null>;
    savePath: (key: RuntimeResourcePathKey, path: string) => Promise<RuntimeResourcePathChangeResult>;
    resetPath: (key: RuntimeResourcePathKey) => Promise<RuntimeResourcePathChangeResult>;
  };
  logs: {
    list: () => Promise<LogEntry[]>;
    clear: () => Promise<void>;
    onEntry: (callback: (entry: LogEntry) => void) => () => void;
  };
  localChat: {
    connect: (request?: LocalChatConnectRequest) => Promise<LocalChatConnectionState>;
    disconnect: () => Promise<void>;
    send: (request: LocalChatSendRequest) => Promise<LocalChatMessageEvent>;
    listMessages: () => Promise<LocalChatMessageEvent[]>;
    onEvent: (callback: (event: LocalChatEvent) => void) => () => void;
  };
  pty: {
    start: (request: PtyStartRequest) => Promise<PtySessionSnapshot>;
    stop: (request: PtyStopRequest) => Promise<void>;
    kill: (sessionId: string) => Promise<void>;
    input: (request: PtyInputRequest) => Promise<void>;
    resize: (request: PtyResizeRequest) => Promise<void>;
    clear: (sessionId: string) => Promise<void>;
    list: () => Promise<PtySessionSnapshot[]>;
    getBuffer: (sessionId: string) => Promise<string>;
    onData: (callback: (event: PtyDataEvent) => void) => () => void;
    onExit: (callback: (event: PtyExitEvent) => void) => () => void;
    onError: (callback: (event: PtyErrorEvent) => void) => () => void;
    onSnapshot: (callback: (snapshot: PtySessionSnapshot) => void) => () => void;
  };
}
