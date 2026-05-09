import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import type {
  PtyDataEvent,
  PtyErrorEvent,
  PtyExitEvent,
  PtySessionSnapshot,
  RuntimePaths,
  RuntimePathConfig,
  RuntimePathKey,
  RuntimePathKind,
  RuntimePathUpdate,
  ServiceCommandConfig,
  ServiceCommandUpdate,
  ServiceDescriptor,
  ServiceHealth,
  ServiceId,
  ServiceStatus,
} from "../../shared/contracts";
import type { PtySessionManager } from "../pty/pty-session-manager";
import { InitManager } from "./init-manager";
import { LogStore } from "./log-store";
import { PythonDependencyManager } from "./python-dependency-manager";

interface ServiceDefinition {
  id: ServiceId;
  name: string;
  port: number;
  ports: number[];
  url: string;
  cwd: string;
  defaultRequiredPaths: string[];
  conflictPorts: number[];
  readyPorts: number[];
  buildDefaultCommand?: () => Promise<string[]>;
  buildDefaultCommandLine: () => Promise<string>;
  displayDefaultCommandLine?: () => Promise<string>;
}

interface RuntimePathDefinition {
  key: RuntimePathKey;
  label: string;
  kind: RuntimePathKind;
  defaultValue: string;
}

interface ResolvedServiceCommand {
  cwd: string;
  command?: string[];
  commandLine: string;
  requiredPaths: string[];
  customized: boolean;
}

interface ServiceState {
  status: ServiceStatus;
  health: ServiceHealth;
  managed: boolean;
  pid?: number;
  detail?: string;
  error?: string;
  desired?: boolean;
  restartAttempts?: number;
  command?: string[];
  cwd?: string;
  dynamicUrl?: string;
  startedAt?: number;
  stoppedAt?: number;
  ptySessionId?: string;
  stopTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  healthFailures?: number;
}

interface StoredServiceCommand {
  cwd?: string;
  commandLine?: string;
}

interface StoredCommandFile {
  version: 1;
  services: Partial<Record<ServiceId, StoredServiceCommand>>;
}

interface StoredRuntimePathFile {
  version: 1;
  paths: Partial<Record<RuntimePathKey, string>>;
}

const STOP_FORCE_AFTER_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 2_500;
const SERVICE_TERMINAL_COLS = 120;
const SERVICE_TERMINAL_ROWS = 36;
const COMMAND_CONFIG_FILE = "service-commands.json";
const RUNTIME_PATH_CONFIG_FILE = "runtime-paths.json";
const SERVICE_IDS: ServiceId[] = ["maibot", "napcat"];

function quoteCommandPart(value: string): string {
  const normalized = normalizePathLikeValue(value);
  if (!/[ \t&()^|<>"]/u.test(normalized)) {
    return normalized;
  }

  return `"${normalized.replace(/"/g, '\\"')}"`;
}

function normalizePathLikeValue(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^\\(["'])/u, "$1").replace(/\\(["'])$/u, "$1");

  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}

function normalizeCommandLine(value: string): string {
  return value
    .trim()
    .replace(/(^|\s)\\(["'])/gu, "$1$2")
    .replace(/\\(["'])(?=\s|$)/gu, "$1");
}

function normalizePathSeparators(value: string): string {
  return normalizePathLikeValue(value)
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/")
    .replace(/\/$/u, "");
}

function normalizePathForMatch(value: string): string {
  const normalized = normalizePathSeparators(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceAllPathVariants(value: string, search: string, replacement: string): string {
  const flags = process.platform === "win32" ? "giu" : "gu";
  const variants = new Set([
    search,
    search.replace(/\\/gu, "/"),
    search.replace(/\//gu, "\\"),
  ]);

  let nextValue = value;
  for (const variant of variants) {
    if (!variant) {
      continue;
    }

    nextValue = nextValue.replace(new RegExp(escapeRegExp(variant), flags), replacement);
  }

  return nextValue;
}

function relocateBundledModulePath(value: string, paths: RuntimePaths): string {
  const normalized = normalizePathLikeValue(value);
  const normalizedWithSlashes = normalizePathSeparators(normalized);
  const bundledWithSlashes = normalizePathSeparators(paths.bundledModulesRoot);
  const valueForMatch = normalizePathForMatch(normalized);
  const bundledForMatch = normalizePathForMatch(paths.bundledModulesRoot);
  const isBundledRoot = valueForMatch === bundledForMatch;
  const isBundledChild = valueForMatch.startsWith(`${bundledForMatch}/`);

  if (!isBundledRoot && !isBundledChild) {
    return normalized;
  }

  const suffix = normalizedWithSlashes.slice(bundledWithSlashes.length);
  const suffixParts = suffix.split("/").filter(Boolean);
  return join(paths.modulesRoot, ...suffixParts);
}

function relocateBundledModuleReferences(value: string, paths: RuntimePaths): string {
  return replaceAllPathVariants(value, paths.bundledModulesRoot, paths.modulesRoot);
}

function extractLeadingExecutablePath(commandLine: string): string | undefined {
  const trimmed = commandLine.trim();
  if (!trimmed) {
    return undefined;
  }

  const quoted = trimmed.match(/^"([^"]+)"/u) ?? trimmed.match(/^'([^']+)'/u);
  const candidate = quoted?.[1] ?? trimmed.split(/\s+/u)[0];
  if (!candidate) {
    return undefined;
  }

  const looksLikePath =
    /^[a-zA-Z]:[\\/]/u.test(candidate) ||
    /^\\\\/u.test(candidate) ||
    candidate.includes("/") ||
    candidate.includes("\\");
  return looksLikePath ? candidate : undefined;
}

function serviceSessionId(serviceId: ServiceId): string {
  return `service:${serviceId}`;
}

function serviceIdFromSession(sessionId: string): ServiceId | undefined {
  const id = sessionId.replace(/^service:/u, "");
  return SERVICE_IDS.includes(id as ServiceId) ? (id as ServiceId) : undefined;
}

function isLivePtyStatus(status: PtySessionSnapshot["status"]): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

function probePort(port: number, host = "127.0.0.1", timeoutMs = 450): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function waitForPort(port: number, timeoutMs = 18_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probePort(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

class ServiceCommandStore {
  private readonly path: string;
  private cache: StoredCommandFile | null = null;

  constructor(private readonly paths: RuntimePaths) {
    this.path = join(paths.userDataRoot, COMMAND_CONFIG_FILE);
  }

  async get(serviceId: ServiceId): Promise<StoredServiceCommand | undefined> {
    const command = (await this.read()).services[serviceId];
    if (!command) {
      return undefined;
    }

    return {
      cwd: command.cwd ? relocateBundledModulePath(command.cwd, this.paths) : undefined,
      commandLine: command.commandLine
        ? relocateBundledModuleReferences(normalizeCommandLine(command.commandLine), this.paths)
        : undefined,
    };
  }

  async set(serviceId: ServiceId, command: StoredServiceCommand): Promise<void> {
    const file = await this.read();
    file.services[serviceId] = {
      cwd: command.cwd ? relocateBundledModulePath(command.cwd, this.paths) || undefined : undefined,
      commandLine: command.commandLine
        ? relocateBundledModuleReferences(normalizeCommandLine(command.commandLine), this.paths) || undefined
        : undefined,
    };
    await this.write(file);
  }

  async reset(serviceId: ServiceId): Promise<void> {
    const file = await this.read();
    delete file.services[serviceId];
    await this.write(file);
  }

  private async read(): Promise<StoredCommandFile> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as StoredCommandFile;
      this.cache = {
        version: 1,
        services: raw.services ?? {},
      };
    } catch {
      this.cache = { version: 1, services: {} };
    }

    return this.cache;
  }

  private async write(file: StoredCommandFile): Promise<void> {
    this.cache = file;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}

class RuntimePathStore {
  private readonly path: string;
  private cache: StoredRuntimePathFile;

  constructor(private readonly paths: RuntimePaths) {
    this.path = join(paths.userDataRoot, RUNTIME_PATH_CONFIG_FILE);
    this.cache = this.read();
  }

  get(key: RuntimePathKey): string | undefined {
    const value = this.cache.paths[key];
    return value ? relocateBundledModulePath(value, this.paths) || undefined : undefined;
  }

  async set(key: RuntimePathKey, value: string): Promise<void> {
    this.cache.paths[key] = relocateBundledModulePath(value, this.paths) || undefined;
    await this.write();
  }

  async reset(key: RuntimePathKey): Promise<void> {
    delete this.cache.paths[key];
    await this.write();
  }

  private read(): StoredRuntimePathFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as StoredRuntimePathFile;
      return {
        version: 1,
        paths: raw.paths ?? {},
      };
    } catch {
      return { version: 1, paths: {} };
    }
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
  }
}

export class ServiceManager extends EventEmitter {
  private readonly states = new Map<ServiceId, ServiceState>();
  private definitions: ServiceDefinition[];
  private readonly watchdogTimer: NodeJS.Timeout;
  private readonly commandStore: ServiceCommandStore;
  private readonly runtimePathStore: RuntimePathStore;
  private readonly logLineBuffers = new Map<ServiceId, string>();

  constructor(
    private readonly paths: RuntimePaths,
    private readonly initManager: InitManager,
    private readonly logs: LogStore,
    private readonly pty: PtySessionManager,
    private readonly pythonDependencyManager?: PythonDependencyManager,
  ) {
    super();
    this.commandStore = new ServiceCommandStore(paths);
    this.runtimePathStore = new RuntimePathStore(paths);
    this.definitions = this.createDefinitions();
    for (const definition of this.definitions) {
      this.states.set(definition.id, {
        status: "stopped",
        health: "unknown",
        managed: false,
        desired: false,
        restartAttempts: 0,
        healthFailures: 0,
        detail: "等待启动",
      });
    }

    this.pty.on("data", (event) => this.handlePtyData(event));
    this.pty.on("exit", (event) => this.handlePtyExit(event));
    this.pty.on("error", (event) => this.handlePtyError(event));
    this.pty.on("snapshot", (snapshot) => this.handlePtySnapshot(snapshot));

    this.watchdogTimer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.logs.append("desktop", "system", `service watchdog failed: ${String(error)}`);
      });
    }, WATCHDOG_INTERVAL_MS);
  }

  async startAll(): Promise<ServiceDescriptor[]> {
    await this.initManager.assertAgreementsConfirmed();
    for (const serviceId of ["napcat", "maibot"] as ServiceId[]) {
      await this.start(serviceId);
    }
    return this.refresh();
  }

  async stopAll(): Promise<ServiceDescriptor[]> {
    for (const serviceId of ["maibot", "napcat"] as ServiceId[]) {
      await this.stop(serviceId);
    }
    return this.snapshot();
  }

  async shutdownAll(timeoutMs = STOP_FORCE_AFTER_MS + 2_000): Promise<ServiceDescriptor[]> {
    await this.stopAll();

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const running = [...this.states.values()].some((state) => state.ptySessionId && state.status !== "stopped");
      if (!running) {
        return this.snapshot();
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    for (const serviceId of ["maibot", "napcat"] as ServiceId[]) {
      await this.kill(serviceId);
    }
    return this.snapshot();
  }

  async restart(serviceId: ServiceId): Promise<ServiceDescriptor> {
    await this.stop(serviceId);
    return this.start(serviceId);
  }

  async start(serviceId: ServiceId, resetRestartAttempts = true): Promise<ServiceDescriptor> {
    const definition = this.getDefinition(serviceId);
    const state = this.getState(serviceId);
    const sessionId = serviceSessionId(serviceId);
    const existingSession = this.pty.list().find((session) => session.id === sessionId);

    if (serviceId === "maibot") {
      await this.initManager.assertAgreementsConfirmed();
    }

    if (existingSession && isLivePtyStatus(existingSession.status)) {
      this.setState(serviceId, {
        ...state,
        status: "running",
        health: definition.readyPorts.length > 0 ? "checking" : "ready",
        managed: true,
        desired: true,
        pid: existingSession.pid,
        ptySessionId: existingSession.id,
        detail: `已附加到后台 PTY，PID ${existingSession.pid ?? "未知"}`,
      });
      return this.toDescriptor(definition, this.getState(serviceId));
    }

    let resolved: ResolvedServiceCommand;
    try {
      const changedFiles = await this.initManager.ensureServiceReady(serviceId);
      if (changedFiles.length > 0) {
        this.logs.append(serviceId, "system", `prepared writable modules: ${changedFiles.join(", ")}`);
      }
      resolved = await this.resolveStartCommand(definition);
      this.assertRequiredPaths(definition, resolved.requiredPaths);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logs.append(serviceId, "system", `start failed: ${message}`);
      this.setState(serviceId, {
        ...state,
        status: "error",
        health: "unreachable",
        desired: false,
        error: message,
        detail: message,
        managed: false,
      });
      throw error;
    }

    await this.assertPortsFree(definition);

    const displayCommand = resolved.command ?? [resolved.commandLine];

    this.setState(serviceId, {
      ...state,
      status: "starting",
      health: "checking",
      desired: true,
      restartAttempts: resetRestartAttempts ? 0 : (state.restartAttempts ?? 0),
      healthFailures: 0,
      error: undefined,
      detail: `正在启动 ${definition.name} PTY`,
      stoppedAt: undefined,
      ptySessionId: sessionId,
      command: displayCommand,
      cwd: resolved.cwd,
    });

    this.logs.append(
      serviceId,
      "system",
      `start: ${resolved.commandLine} cwd=${resolved.cwd}${resolved.customized ? " customized=true" : ""}`,
    );

    try {
      const useCommandLine = !resolved.command;
      const agreementEnv = await this.initManager.getAgreementEnvVars();
      const baseEnv =
        definition.id === "maibot" ? this.pythonDependencyManager?.buildPythonPathEnv() : undefined;
      const mergedEnv: Record<string, string> = { ...(baseEnv ?? {}), ...agreementEnv };
      if (definition.id === "maibot" && this.pythonDependencyManager) {
        this.logs.append("maibot", "system", "startup dependency upgrade: checking MaiBot dependency files");
        const upgradeResult = await this.pythonDependencyManager.upgradeStartupDependencies();
        for (const line of upgradeResult.output) {
          this.logs.append("maibot", "system", `startup dependency upgrade: ${line}`);
        }
        this.logs.append(
          "maibot",
          "system",
          `startup dependency upgrade completed: ${upgradeResult.sourceFile} -> ${upgradeResult.targetDir}`,
        );
      }
      const session = this.pty.start({
        id: sessionId,
        title: definition.name,
        cwd: resolved.cwd,
        command: useCommandLine ? undefined : resolved.command,
        commandLine: useCommandLine ? resolved.commandLine : undefined,
        cols: SERVICE_TERMINAL_COLS,
        rows: SERVICE_TERMINAL_ROWS,
        encoding: "auto",
        env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      });

      this.setState(serviceId, {
        ...this.getState(serviceId),
        status: "running",
        health: definition.readyPorts.length > 0 ? "checking" : "ready",
        managed: true,
        desired: true,
        pid: session.pid,
        ptySessionId: session.id,
        command: displayCommand,
        cwd: resolved.cwd,
        detail: "PTY 已启动，正在检测服务端口",
        startedAt: Date.now(),
      });

      void this.waitUntilReady(definition);
      return this.toDescriptor(definition, this.getState(serviceId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logs.append(serviceId, "system", `start process failed: ${message}`);
      this.setState(serviceId, {
        ...this.getState(serviceId),
        status: "error",
        health: "unreachable",
        managed: false,
        desired: false,
        error: message,
        detail: message,
        pid: undefined,
        stoppedAt: Date.now(),
      });
      throw error;
    }
  }

  async stop(serviceId: ServiceId): Promise<ServiceDescriptor> {
    const definition = this.getDefinition(serviceId);
    const state = this.getState(serviceId);
    if (!state.ptySessionId || state.status === "stopped") {
      return this.toDescriptor(definition, state);
    }

    this.setState(serviceId, {
      ...state,
      status: "stopping",
      desired: false,
      detail: "正在温和停止后台 PTY，超时后会强制结束",
    });
    this.logs.append(serviceId, "system", "stop requested");
    this.clearRestartTimer(state);

    try {
      this.pty.stop({ sessionId: state.ptySessionId, forceAfterMs: STOP_FORCE_AFTER_MS });
    } catch (error) {
      this.logs.append(serviceId, "system", `soft stop failed: ${String(error)}`);
      this.setState(serviceId, {
        ...this.getState(serviceId),
        status: "stopped",
        health: "unknown",
        managed: false,
        desired: false,
        pid: undefined,
        detail: "PTY 会话不存在，已标记为停止",
        stoppedAt: Date.now(),
      });
    }

    const nextState = this.getState(serviceId);
    this.clearStopTimer(nextState);
    nextState.stopTimer = setTimeout(() => {
      void this.kill(serviceId);
    }, STOP_FORCE_AFTER_MS + 500);
    this.states.set(serviceId, nextState);
    return this.toDescriptor(definition, nextState);
  }

  async kill(serviceId: ServiceId): Promise<ServiceDescriptor> {
    const definition = this.getDefinition(serviceId);
    const state = this.getState(serviceId);
    if (!state.ptySessionId) {
      return this.toDescriptor(definition, state);
    }

    this.logs.append(serviceId, "system", "force kill requested");
    this.clearRestartTimer(state);
    this.setState(serviceId, {
      ...state,
      desired: false,
      detail: "正在强制结束后台 PTY 进程树",
    });

    try {
      this.pty.kill(state.ptySessionId);
    } catch (error) {
      this.logs.append(serviceId, "system", `force kill failed: ${String(error)}`);
      this.setState(serviceId, {
        ...this.getState(serviceId),
        status: "stopped",
        health: "unknown",
        managed: false,
        pid: undefined,
        detail: "PTY 会话不存在，已标记为停止",
        stoppedAt: Date.now(),
      });
    }

    return this.toDescriptor(definition, this.getState(serviceId));
  }

  async refresh(): Promise<ServiceDescriptor[]> {
    this.attachLivePtySessions();
    this.reconcileExitedPtySessions();

    for (const definition of this.definitions) {
      const state = this.getState(definition.id);
      if (state.managed && state.status === "running") {
        const ready = await this.areReadyPortsOpen(definition);
        const healthFailures = ready ? 0 : (state.healthFailures ?? 0) + 1;
        this.setState(definition.id, {
          ...state,
          health: ready ? "ready" : healthFailures >= 3 ? "unreachable" : "checking",
          healthFailures,
          detail: ready ? "服务端口可访问" : healthFailures >= 3 ? "服务端口连续不可达" : state.detail,
        });
      } else if (!state.managed && definition.readyPorts.length > 0) {
        const occupied = await this.areReadyPortsOpen(definition);
        if (occupied) {
          this.setState(definition.id, {
            ...state,
            health: "conflict",
            detail: "默认端口已被外部进程占用",
          });
        }
      }
    }
    return this.snapshot();
  }

  snapshot(): ServiceDescriptor[] {
    return this.definitions.map((definition) => this.toDescriptor(definition, this.getState(definition.id)));
  }

  async getCommandConfigs(): Promise<ServiceCommandConfig[]> {
    return Promise.all(this.definitions.map((definition) => this.getCommandConfig(definition)));
  }

  async saveCommandConfig(update: ServiceCommandUpdate): Promise<ServiceCommandConfig[]> {
    this.getDefinition(update.serviceId);
    await this.commandStore.set(update.serviceId, {
      cwd: update.cwd,
      commandLine: update.commandLine,
    });
    this.emit("snapshot", this.snapshot());
    return this.getCommandConfigs();
  }

  async resetCommandConfig(serviceId: ServiceId): Promise<ServiceCommandConfig[]> {
    this.getDefinition(serviceId);
    await this.commandStore.reset(serviceId);
    this.emit("snapshot", this.snapshot());
    return this.getCommandConfigs();
  }

  getRuntimePathConfigs(): RuntimePathConfig[] {
    return this.getRuntimePathDefinitions().map((definition) => this.toRuntimePathConfig(definition));
  }

  async saveRuntimePathConfig(update: RuntimePathUpdate): Promise<RuntimePathConfig[]> {
    this.getRuntimePathDefinition(update.key);
    await this.runtimePathStore.set(update.key, update.value);
    this.definitions = this.createDefinitions();
    this.emit("snapshot", this.snapshot());
    return this.getRuntimePathConfigs();
  }

  async resetRuntimePathConfig(key: RuntimePathKey): Promise<RuntimePathConfig[]> {
    this.getRuntimePathDefinition(key);
    await this.runtimePathStore.reset(key);
    this.definitions = this.createDefinitions();
    this.emit("snapshot", this.snapshot());
    return this.getRuntimePathConfigs();
  }

  dispose(): void {
    clearInterval(this.watchdogTimer);
    for (const serviceId of SERVICE_IDS) {
      const state = this.getState(serviceId);
      this.clearStopTimer(state);
      this.clearRestartTimer(state);
      void this.kill(serviceId);
    }
    this.removeAllListeners();
  }

  private createDefinitions(): ServiceDefinition[] {
    const python = this.getRuntimePath("python");
    const maibotRoot = this.getRuntimePath("maibot");
    const napcatRoot = this.getRuntimePath("napcat");
    const napcatExe = join(napcatRoot, "NapCatWinBootMain.exe");
    const napcatLauncherName = "napcat-launch.cmd";
    const napcatLauncherPath = join(napcatRoot, napcatLauncherName);
    const cmdShell = process.env.ComSpec || "cmd.exe";

    return [
      {
        id: "maibot",
        name: "MaiBot Core",
        port: 8001,
        ports: [8001],
        url: "http://127.0.0.1:8001",
        cwd: maibotRoot,
        defaultRequiredPaths: [python, maibotRoot, join(maibotRoot, "bot.py")],
        conflictPorts: [8001],
        readyPorts: [8001],
        buildDefaultCommand: async () => [python, "bot.py"],
        buildDefaultCommandLine: async () => `${quoteCommandPart(python)} bot.py`,
      },
      {
        id: "napcat",
        name: "NapCat",
        port: 6099,
        ports: [6099],
        url: "http://127.0.0.1:6099/webui",
        cwd: napcatRoot,
        defaultRequiredPaths: [napcatRoot, napcatExe],
        conflictPorts: [6099],
        readyPorts: [6099],
        displayDefaultCommandLine: async () => {
          return `${quoteCommandPart(napcatExe)} <QQ>`;
        },
        buildDefaultCommand: async () => {
          const qq = await this.initManager.readQqAccount();
          await this.initManager.ensureNapCatWebUiConfig();
          if (process.platform === "win32" && existsSync(napcatLauncherPath)) {
            // 通过 cmd.exe 调用磁盘上的 napcat-launch.cmd（已固定 chcp 65001），
            // argv 各元素独立传递，不会触发 cmd /C 字符串拼接的引号歧义。
            const args = ["/D", "/S", "/C", napcatLauncherName];
            if (qq) {
              args.push(qq);
            }
            return [cmdShell, ...args];
          }
          return qq ? [napcatExe, qq] : [napcatExe];
        },
        buildDefaultCommandLine: async () => {
          await this.initManager.ensureNapCatWebUiConfig();
          return this.applyServicePlaceholders("napcat", `${quoteCommandPart(napcatExe)} <QQ>`);
        },
      },
    ];
  }

  private async waitUntilReady(definition: ServiceDefinition): Promise<void> {
    if (definition.readyPorts.length === 0) {
      return;
    }

    const ready = await this.areReadyPortsOpen(definition, 20_000);
    const state = this.getState(definition.id);
    if (state.status !== "running") {
      return;
    }

    this.setState(definition.id, {
      ...state,
      health: ready ? "ready" : "unreachable",
      healthFailures: ready ? 0 : (state.healthFailures ?? 0) + 1,
      detail: ready ? "服务端口可访问" : "PTY 已启动，但端口暂不可访问",
      dynamicUrl: await this.resolveServiceUrl(definition.id, definition.url),
    });
  }

  private async areReadyPortsOpen(definition: ServiceDefinition, timeoutMs?: number): Promise<boolean> {
    if (definition.readyPorts.length === 0) {
      return true;
    }

    const results = await Promise.all(
      definition.readyPorts.map((port) => (timeoutMs ? waitForPort(port, timeoutMs) : probePort(port))),
    );
    return results.every(Boolean);
  }

  private async assertPortsFree(definition: ServiceDefinition): Promise<void> {
    for (const port of definition.conflictPorts) {
      if (await probePort(port)) {
        this.setState(definition.id, {
          ...this.getState(definition.id),
          health: "conflict",
          status: "error",
          error: `端口 ${port} 已被占用`,
          detail: `端口 ${port} 已被外部进程占用，请手动处理`,
        });
        throw new Error(`端口 ${port} 已被占用，请手动处理`);
      }
    }
  }

  private assertRequiredPaths(definition: ServiceDefinition, paths: string[]): void {
    const missing = paths.find((path) => !existsSync(path));
    if (!missing) {
      return;
    }

    this.setState(definition.id, {
      ...this.getState(definition.id),
      status: "error",
      health: "unreachable",
      error: `缺失路径: ${missing}`,
      detail: `缺失路径: ${missing}`,
    });
    throw new Error(`缺失路径: ${missing}`);
  }

  private async resolveStartCommand(definition: ServiceDefinition): Promise<ResolvedServiceCommand> {
    const override = await this.commandStore.get(definition.id);
    const cwd = override?.cwd ? normalizePathLikeValue(override.cwd) || definition.cwd : definition.cwd;
    const commandLine = override?.commandLine ? normalizeCommandLine(override.commandLine) : undefined;
    if (commandLine) {
      const executablePath = extractLeadingExecutablePath(commandLine);
      return {
        cwd,
        commandLine: await this.applyServicePlaceholders(definition.id, commandLine),
        requiredPaths: executablePath ? [cwd, executablePath] : [cwd],
        customized: true,
      };
    }

    const command = definition.buildDefaultCommand ? await definition.buildDefaultCommand() : undefined;
    return {
      cwd,
      command,
      commandLine: command ? command.map(quoteCommandPart).join(" ") : await definition.buildDefaultCommandLine(),
      requiredPaths: [...definition.defaultRequiredPaths, cwd],
      customized: false,
    };
  }

  private async getCommandConfig(definition: ServiceDefinition): Promise<ServiceCommandConfig> {
    const override = await this.commandStore.get(definition.id);
    const defaultCommandLine = definition.displayDefaultCommandLine
      ? await definition.displayDefaultCommandLine()
      : await definition.buildDefaultCommandLine();

    return {
      serviceId: definition.id,
      serviceName: definition.name,
      cwd: override?.cwd?.trim() || definition.cwd,
      commandLine: override?.commandLine?.trim() || defaultCommandLine,
      defaultCwd: definition.cwd,
      defaultCommandLine,
      customized: Boolean(override?.cwd?.trim() || override?.commandLine?.trim()),
    };
  }

  private getRuntimePathDefinitions(): RuntimePathDefinition[] {
    return [
      {
        key: "python",
        label: "Python",
        kind: "file",
        defaultValue: this.initManager.getPythonPath(),
      },
      {
        key: "git",
        label: "Git",
        kind: "file",
        defaultValue: this.initManager.getGitPath(),
      },
      {
        key: "maibot",
        label: "麦麦 MaiBot",
        kind: "dir",
        defaultValue: join(this.paths.modulesRoot, "MaiBot"),
      },
      {
        key: "napcat",
        label: "NapCat",
        kind: "dir",
        defaultValue: join(this.paths.modulesRoot, "napcat"),
      },
    ];
  }

  private getRuntimePathDefinition(key: RuntimePathKey): RuntimePathDefinition {
    const definition = this.getRuntimePathDefinitions().find((item) => item.key === key);
    if (!definition) {
      throw new Error(`未知路径配置: ${key}`);
    }
    return definition;
  }

  private getRuntimePath(key: RuntimePathKey): string {
    const definition = this.getRuntimePathDefinition(key);
    return this.runtimePathStore.get(key) ?? definition.defaultValue;
  }

  private toRuntimePathConfig(definition: RuntimePathDefinition): RuntimePathConfig {
    const customValue = this.runtimePathStore.get(definition.key);
    return {
      key: definition.key,
      label: definition.label,
      kind: definition.kind,
      value: customValue ?? definition.defaultValue,
      defaultValue: definition.defaultValue,
      customized: Boolean(customValue),
    };
  }

  private async applyServicePlaceholders(serviceId: ServiceId, commandLine: string): Promise<string> {
    if (serviceId !== "napcat" || !commandLine.includes("<QQ>")) {
      return commandLine;
    }

    const qq = await this.initManager.readQqAccount();
    return commandLine
      .replace(/(["'])<QQ>\1/gu, qq ? quoteCommandPart(qq) : "")
      .replace(/<QQ>/gu, qq ? quoteCommandPart(qq) : "")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private async resolveServiceUrl(serviceId: ServiceId, fallback: string): Promise<string> {
    if (serviceId === "napcat") {
      return this.resolveNapCatUrl(fallback);
    }
    if (serviceId === "maibot") {
      return this.resolveMaiBotUrl(fallback);
    }
    return fallback;
  }

  private async resolveNapCatUrl(fallback: string): Promise<string> {
    try {
      const { token } = await this.initManager.readNapCatWebUiToken();
      return token ? `http://127.0.0.1:6099/webui/web_login?token=${encodeURIComponent(token)}` : fallback;
    } catch {
      // 任何读取异常都直接回退到普通登录页，避免阻塞主面板。
      return fallback;
    }
  }

  /**
   * MaiBot Core WebUI 支持 `/auth?token=<access_token>` 直接登录；
   * webui.json 还未生成或字段缺失时直接回退为根地址，由用户走普通登录流程。
   */
  private async resolveMaiBotUrl(fallback: string): Promise<string> {
    try {
      const { token } = await this.initManager.readMaiBotWebUiToken();
      if (!token) {
        return fallback;
      }
      const base = fallback.replace(/\/+$/u, "");
      return `${base}/auth?token=${encodeURIComponent(token)}`;
    } catch {
      return fallback;
    }
  }

  private attachLivePtySessions(): void {
    for (const session of this.pty.list()) {
      const serviceId = serviceIdFromSession(session.id);
      if (!serviceId || !isLivePtyStatus(session.status)) {
        continue;
      }

      const definition = this.getDefinition(serviceId);
      const state = this.getState(serviceId);
      if (state.managed && state.ptySessionId === session.id) {
        continue;
      }

      this.setState(serviceId, {
        ...state,
        status: "running",
        health: definition.readyPorts.length > 0 ? "checking" : "ready",
        managed: true,
        desired: state.desired ?? true,
        pid: session.pid,
        ptySessionId: session.id,
        command: session.command,
        cwd: session.cwd,
        detail: `已附加到后台 PTY，PID ${session.pid ?? "未知"}`,
        startedAt: state.startedAt ?? session.startedAt,
      });
    }
  }

  private reconcileExitedPtySessions(): void {
    const sessions = new Map(this.pty.list().map((session) => [session.id, session]));

    for (const definition of this.definitions) {
      const state = this.getState(definition.id);
      if (!state.ptySessionId || state.status === "stopped" || state.status === "error") {
        continue;
      }

      const session = sessions.get(state.ptySessionId);
      if (!session || session.status === "starting" || session.status === "running" || session.status === "stopping") {
        continue;
      }

      const stoppedByRequest = state.status === "stopping" || !state.desired;
      this.setState(definition.id, {
        ...state,
        status: stoppedByRequest ? "stopped" : "error",
        health: "unknown",
        managed: false,
        desired: stoppedByRequest ? false : state.desired,
        pid: undefined,
        ptySessionId: undefined,
        error: stoppedByRequest ? undefined : (session.error ?? `进程异常退出: ${session.exitCode ?? "未知"}`),
        detail: stoppedByRequest ? "已停止" : `进程异常退出: ${session.exitCode ?? "未知"}`,
        stoppedAt: session.endedAt ?? Date.now(),
      });
    }
  }

  private handlePtyData(event: PtyDataEvent): void {
    const serviceId = serviceIdFromSession(event.sessionId);
    if (!serviceId) {
      return;
    }

    let buffered = `${this.logLineBuffers.get(serviceId) ?? ""}${event.data}`;
    buffered = buffered.replace(/\r(?!\n)/gu, "\n");
    const lines = buffered.split(/\n/u);
    this.logLineBuffers.set(serviceId, lines.pop() ?? "");

    for (const line of lines) {
      if (line.length > 0) {
        this.logs.append(serviceId, "stdout", line);
      }
    }
  }

  private handlePtyExit(event: PtyExitEvent): void {
    const serviceId = serviceIdFromSession(event.sessionId);
    if (!serviceId) {
      return;
    }

    const remaining = this.logLineBuffers.get(serviceId);
    if (remaining) {
      this.logs.append(serviceId, "stdout", remaining);
      this.logLineBuffers.delete(serviceId);
    }

    const current = this.getState(serviceId);
    if (current.ptySessionId !== event.sessionId) {
      return;
    }

    this.clearStopTimer(current);
    const shouldRestart = Boolean(current.desired && current.status !== "stopping");
    const stoppedByRequest = current.status === "stopping" || !current.desired;
    this.logs.append(serviceId, "system", `exit: code=${event.exitCode} signal=${event.signal ?? "null"}`);
    this.setState(serviceId, {
      ...current,
      status: stoppedByRequest ? "stopped" : "error",
      health: "unknown",
      managed: false,
      pid: undefined,
      ptySessionId: undefined,
      detail: stoppedByRequest
        ? "已停止"
        : shouldRestart
          ? `进程退出，准备自动重启: ${event.exitCode}`
          : `进程异常退出: ${event.exitCode}`,
      error: stoppedByRequest ? undefined : shouldRestart ? undefined : `进程异常退出: ${event.exitCode}`,
      stoppedAt: Date.now(),
    });

    if (shouldRestart) {
      this.scheduleRestart(serviceId);
    }
  }

  private handlePtyError(event: PtyErrorEvent): void {
    const serviceId = serviceIdFromSession(event.sessionId);
    if (!serviceId) {
      return;
    }

    this.logs.append(serviceId, "system", `pty error: ${event.message}`);
    this.setState(serviceId, {
      ...this.getState(serviceId),
      status: "error",
      health: "unreachable",
      managed: false,
      desired: false,
      pid: undefined,
      error: event.message,
      detail: event.message,
      stoppedAt: Date.now(),
    });
  }

  private handlePtySnapshot(snapshot: PtySessionSnapshot): void {
    const serviceId = serviceIdFromSession(snapshot.id);
    if (!serviceId) {
      return;
    }

    const state = this.getState(serviceId);
    if (state.ptySessionId !== snapshot.id) {
      return;
    }

    if (snapshot.status === "exited" || snapshot.status === "error") {
      const stoppedByRequest = state.status === "stopping" || !state.desired;
      this.setState(serviceId, {
        ...state,
        status: stoppedByRequest ? "stopped" : "error",
        health: "unknown",
        managed: false,
        desired: stoppedByRequest ? false : state.desired,
        pid: undefined,
        ptySessionId: undefined,
        error: stoppedByRequest ? undefined : (snapshot.error ?? `进程异常退出: ${snapshot.exitCode ?? "未知"}`),
        detail: stoppedByRequest ? "已停止" : `进程异常退出: ${snapshot.exitCode ?? "未知"}`,
        stoppedAt: snapshot.endedAt ?? Date.now(),
      });
      return;
    }

    this.setState(serviceId, {
      ...state,
      pid: snapshot.pid,
      command: snapshot.command,
      managed: isLivePtyStatus(snapshot.status),
      status: snapshot.status === "starting" ? "starting" : snapshot.status === "running" ? "running" : state.status,
    });
  }

  private setState(serviceId: ServiceId, state: ServiceState): void {
    this.clearStopTimer(this.getState(serviceId));
    this.states.set(serviceId, state);
    this.emit("snapshot", this.snapshot());
  }

  private clearStopTimer(state: ServiceState): void {
    if (!state.stopTimer) {
      return;
    }

    clearTimeout(state.stopTimer);
    state.stopTimer = undefined;
  }

  private clearRestartTimer(state: ServiceState): void {
    if (!state.restartTimer) {
      return;
    }

    clearTimeout(state.restartTimer);
    state.restartTimer = undefined;
  }

  private scheduleRestart(serviceId: ServiceId): void {
    const definition = this.getDefinition(serviceId);
    const state = this.getState(serviceId);
    const restartAttempts = (state.restartAttempts ?? 0) + 1;

    if (restartAttempts > MAX_RESTART_ATTEMPTS) {
      this.setState(serviceId, {
        ...state,
        desired: false,
        restartAttempts,
        status: "error",
        health: "unreachable",
        error: `自动重启超过 ${MAX_RESTART_ATTEMPTS} 次，已停止守护`,
        detail: `自动重启超过 ${MAX_RESTART_ATTEMPTS} 次，已停止守护`,
      });
      return;
    }

    this.clearRestartTimer(state);
    const restartTimer = setTimeout(() => {
      void this.start(serviceId, false).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logs.append(serviceId, "system", `restart failed: ${message}`);
        this.setState(serviceId, {
          ...this.getState(serviceId),
          status: "error",
          health: "unreachable",
          error: message,
          detail: message,
        });
      });
    }, RESTART_DELAY_MS);

    this.setState(serviceId, {
      ...state,
      desired: true,
      restartAttempts,
      restartTimer,
      status: "stopped",
      health: "checking",
      managed: false,
      pid: undefined,
      detail: `${definition.name} 异常退出，${Math.round(RESTART_DELAY_MS / 1000)} 秒后自动重启 (${restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
    });
  }

  private getDefinition(serviceId: ServiceId): ServiceDefinition {
    const definition = this.definitions.find((item) => item.id === serviceId);
    if (!definition) {
      throw new Error(`未知服务: ${serviceId}`);
    }
    return definition;
  }

  private getState(serviceId: ServiceId): ServiceState {
    const state = this.states.get(serviceId);
    if (!state) {
      throw new Error(`未知服务状态: ${serviceId}`);
    }
    return state;
  }

  private toDescriptor(definition: ServiceDefinition, state: ServiceState): ServiceDescriptor {
    return {
      id: definition.id,
      name: definition.name,
      port: definition.port,
      ports: definition.ports,
      url: state.dynamicUrl ?? definition.url,
      status: state.status,
      health: state.health,
      managed: state.managed,
      desired: state.desired,
      restartAttempts: state.restartAttempts,
      pid: state.pid,
      detail: state.detail,
      cwd: state.cwd ?? definition.cwd,
      command: state.command,
      logPath: this.logs.getServiceLogPath(definition.id),
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      error: state.error,
    };
  }
}
