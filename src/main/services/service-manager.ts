import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import net from "node:net";
import { basename, join } from "node:path";
import type {
  RuntimePaths,
  ServiceDescriptor,
  ServiceHealth,
  ServiceId,
  ServiceStatus,
} from "../../shared/contracts";
import { InitManager } from "./init-manager";
import { LogStore } from "./log-store";

interface ServiceDefinition {
  id: ServiceId;
  name: string;
  port: number;
  ports: number[];
  url: string;
  cwd: string;
  buildCommand: () => Promise<string[]>;
  requiredPaths: string[];
  conflictPorts: number[];
  readyPorts: number[];
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
  dynamicUrl?: string;
  startedAt?: number;
  stoppedAt?: number;
  child?: ChildProcessWithoutNullStreams;
  stopTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  healthFailures?: number;
}

const STOP_FORCE_AFTER_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 2_500;

function isWindows(): boolean {
  return process.platform === "win32";
}

function splitLines(chunk: Buffer): string[] {
  return chunk.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0);
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

export class ServiceManager extends EventEmitter {
  private readonly states = new Map<ServiceId, ServiceState>();
  private readonly definitions: ServiceDefinition[];
  private readonly watchdogTimer: NodeJS.Timeout;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly initManager: InitManager,
    private readonly logs: LogStore,
  ) {
    super();
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
    this.watchdogTimer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.logs.append("desktop", "system", `service watchdog failed: ${String(error)}`);
      });
    }, WATCHDOG_INTERVAL_MS);
  }

  async startAll(): Promise<ServiceDescriptor[]> {
    for (const serviceId of ["napcat", "adapter", "maibot"] as ServiceId[]) {
      await this.start(serviceId);
    }
    return this.refresh();
  }

  async stopAll(): Promise<ServiceDescriptor[]> {
    for (const serviceId of ["adapter", "maibot", "napcat"] as ServiceId[]) {
      await this.stop(serviceId);
    }
    return this.snapshot();
  }

  async shutdownAll(timeoutMs = STOP_FORCE_AFTER_MS + 2_000): Promise<ServiceDescriptor[]> {
    await this.stopAll();

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const running = [...this.states.values()].some((state) => state.child);
      if (!running) {
        return this.snapshot();
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    for (const serviceId of ["adapter", "maibot", "napcat"] as ServiceId[]) {
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

    if ((state.status === "running" || state.status === "starting") && state.child) {
      this.setState(serviceId, {
        ...state,
        desired: true,
      });
      return this.toDescriptor(definition, state);
    }

    this.assertRequiredPaths(definition);
    await this.assertPortsFree(definition);

    let command: string[];
    try {
      command = await definition.buildCommand();
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

    const [file, ...args] = command;
    this.setState(serviceId, {
      ...state,
      status: "starting",
      health: "checking",
      desired: true,
      restartAttempts: resetRestartAttempts ? 0 : (state.restartAttempts ?? 0),
      healthFailures: 0,
      error: undefined,
      detail: `正在启动 ${basename(file)}`,
      stoppedAt: undefined,
      command,
    });

    this.logs.append(serviceId, "system", `start: ${command.join(" ")} cwd=${definition.cwd}`);

    const child = spawn(file, args, {
      cwd: definition.cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      windowsHide: true,
      stdio: "pipe",
      detached: !isWindows(),
    });

    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of splitLines(chunk)) {
        this.logs.append(serviceId, "stdout", line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of splitLines(chunk)) {
        this.logs.append(serviceId, "stderr", line);
      }
    });
    child.once("error", (error) => {
      this.logs.append(serviceId, "system", `process error: ${error.message}`);
      this.setState(serviceId, {
        ...this.getState(serviceId),
        status: "error",
        health: "unreachable",
        managed: false,
        error: error.message,
        detail: error.message,
        child: undefined,
        pid: undefined,
        stoppedAt: Date.now(),
      });
    });
    child.once("exit", (code, signal) => {
      const current = this.getState(serviceId);
      this.clearStopTimer(current);
      const shouldRestart = Boolean(current.desired && current.status !== "stopping");
      this.logs.append(serviceId, "system", `exit: code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.setState(serviceId, {
        ...current,
        status: code === 0 && !shouldRestart ? "stopped" : "error",
        health: "unknown",
        managed: false,
        child: undefined,
        pid: undefined,
        detail:
          code === 0 && !shouldRestart
            ? "已停止"
            : shouldRestart
              ? `进程退出，准备自动重启: ${code ?? "null"}`
              : `进程异常退出: ${code}`,
        error:
          code === 0 && !shouldRestart
            ? undefined
            : shouldRestart
              ? undefined
              : `进程异常退出: ${code}`,
        stoppedAt: Date.now(),
      });
      if (shouldRestart) {
        this.scheduleRestart(serviceId);
      }
    });

    this.setState(serviceId, {
      ...this.getState(serviceId),
      status: "running",
      health: definition.readyPorts.length > 0 ? "checking" : "ready",
      managed: true,
      desired: true,
      pid: child.pid,
      child,
      command,
      detail: "进程已启动，正在检测服务端口",
      startedAt: Date.now(),
    });

    void this.waitUntilReady(definition);
    return this.toDescriptor(definition, this.getState(serviceId));
  }

  async stop(serviceId: ServiceId): Promise<ServiceDescriptor> {
    const definition = this.getDefinition(serviceId);
    const state = this.getState(serviceId);
    if (!state.child || state.status === "stopped") {
      return this.toDescriptor(definition, state);
    }

    this.setState(serviceId, {
      ...state,
      status: "stopping",
      desired: false,
      detail: "正在温和停止，超时后会强制结束",
    });
    this.logs.append(serviceId, "system", "stop requested");
    this.clearRestartTimer(state);

    try {
      this.softTerminate(state);
    } catch (error) {
      this.logs.append(serviceId, "system", `soft stop failed: ${String(error)}`);
    }

    const nextState = this.getState(serviceId);
    this.clearStopTimer(nextState);
    nextState.stopTimer = setTimeout(() => {
      void this.kill(serviceId);
    }, STOP_FORCE_AFTER_MS);
    this.states.set(serviceId, nextState);
    return this.toDescriptor(definition, nextState);
  }

  async kill(serviceId: ServiceId): Promise<ServiceDescriptor> {
    const definition = this.getDefinition(serviceId);
    const state = this.getState(serviceId);
    if (!state.child || !state.pid) {
      return this.toDescriptor(definition, state);
    }

    this.logs.append(serviceId, "system", "force kill requested");
    this.clearRestartTimer(state);
    this.setState(serviceId, {
      ...state,
      desired: false,
      detail: "正在强制结束进程树",
    });
    this.forceKill(state);

    return this.toDescriptor(definition, state);
  }

  async refresh(): Promise<ServiceDescriptor[]> {
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

  dispose(): void {
    clearInterval(this.watchdogTimer);
    for (const serviceId of ["adapter", "maibot", "napcat"] as ServiceId[]) {
      const state = this.getState(serviceId);
      this.clearStopTimer(state);
      this.clearRestartTimer(state);
      void this.kill(serviceId);
    }
    this.removeAllListeners();
  }

  private createDefinitions(): ServiceDefinition[] {
    const python = this.initManager.getPythonPath();
    const maibotRoot = join(this.paths.modulesRoot, "MaiBot");
    const adapterRoot = join(this.paths.modulesRoot, "MaiBot-Napcat-Adapter");
    const napcatRoot = join(this.paths.modulesRoot, "napcat");

    return [
      {
        id: "maibot",
        name: "MaiBot Core",
        port: 8001,
        ports: [8001],
        url: "http://127.0.0.1:8001",
        cwd: maibotRoot,
        requiredPaths: [python, maibotRoot, join(maibotRoot, "bot.py")],
        conflictPorts: [8001],
        readyPorts: [8001],
        buildCommand: async () => [python, "bot.py"],
      },
      {
        id: "adapter",
        name: "NapCat Adapter",
        port: 8095,
        ports: [8095],
        url: "ws://127.0.0.1:8095",
        cwd: adapterRoot,
        requiredPaths: [python, adapterRoot, join(adapterRoot, "main.py")],
        conflictPorts: [8095],
        readyPorts: [],
        buildCommand: async () => [python, "main.py"],
      },
      {
        id: "napcat",
        name: "NapCat",
        port: 6099,
        ports: [6099],
        url: "http://127.0.0.1:6099/webui",
        cwd: napcatRoot,
        requiredPaths: [napcatRoot, join(napcatRoot, "NapCatWinBootMain.exe")],
        conflictPorts: [6099],
        readyPorts: [6099],
        buildCommand: async () => {
          const qq = await this.initManager.readQqAccount();
          if (!qq) {
            throw new Error("请先在初始化向导中配置机器人 QQ 号");
          }
          await this.initManager.ensureNapCatWebUiConfig();
          return [join(napcatRoot, "NapCatWinBootMain.exe"), qq];
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
      detail: ready ? "服务端口可访问" : "进程已启动，但端口暂不可访问",
      dynamicUrl: definition.id === "napcat" ? await this.resolveNapCatUrl(definition.url) : definition.url,
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

  private assertRequiredPaths(definition: ServiceDefinition): void {
    const missing = definition.requiredPaths.find((path) => !existsSync(path));
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

  private async resolveNapCatUrl(fallback: string): Promise<string> {
    const { token } = await this.initManager.readNapCatWebUiToken();
    return token ? `http://127.0.0.1:6099/webui/web_login?token=${encodeURIComponent(token)}` : fallback;
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

  private softTerminate(state: ServiceState): void {
    if (!state.child || !state.pid) {
      return;
    }

    if (isWindows()) {
      state.child.kill();
      return;
    }

    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      state.child.kill("SIGTERM");
    }
  }

  private forceKill(state: ServiceState): void {
    if (!state.child || !state.pid) {
      return;
    }

    if (isWindows()) {
      spawn("taskkill", ["/F", "/T", "/PID", String(state.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }

    try {
      process.kill(-state.pid, "SIGKILL");
    } catch {
      state.child.kill("SIGKILL");
    }
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
      cwd: definition.cwd,
      command: state.command,
      logPath: this.logs.getServiceLogPath(definition.id),
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      error: state.error,
    };
  }
}
