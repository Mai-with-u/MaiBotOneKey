export type ServiceId = "maibot" | "napcat";

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

export type RuntimePathKey = "python" | "git" | "maibot" | "napcat";

export type RuntimePathKind = "file" | "dir";

export type InitCheckStatus = "ok" | "warning" | "error";

export type CloseAction = "minimize" | "quit";

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

export interface RuntimePaths {
  installRoot: string;
  userDataRoot: string;
  modulesRoot: string;
  bundledModulesRoot: string;
  runtimeRoot: string;
  logsRoot: string;
}

export interface DesktopSnapshot {
  paths: RuntimePaths;
  services: ServiceDescriptor[];
  serviceCommands: ServiceCommandConfig[];
  runtimePathConfigs: RuntimePathConfig[];
  appVersion: string;
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
}

export interface InitCheck {
  id: string;
  label: string;
  status: InitCheckStatus;
  detail: string;
  path?: string;
}

export interface InitState {
  isReady: boolean;
  qqAccount?: string;
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

export interface ModuleUpdateResult {
  moduleId: "maibot";
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
}

export type ManagedPythonPackageName = "maibot-dashboard" | "maim-message";

export interface ManagedPythonPackage {
  name: ManagedPythonPackageName;
  label: string;
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
  sourceUrl: string;
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
    getState: () => Promise<WindowState>;
    onState: (callback: (state: WindowState) => void) => () => void;
  };
  init: {
    getState: () => Promise<InitState>;
    repair: () => Promise<InitRepairResult>;
    setQqAccount: (qqAccount: string, websocketToken?: string) => Promise<InitState>;
  };
  agreements: {
    getState: () => Promise<StartupAgreementState>;
    confirm: () => Promise<StartupAgreementConfirmResult>;
  };
  modules: {
    updateMaiBot: () => Promise<ModuleUpdateResult>;
  };
  pythonDeps: {
    getState: () => Promise<PythonOverridesState>;
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
    onSnapshot: (callback: (services: ServiceDescriptor[]) => void) => () => void;
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
