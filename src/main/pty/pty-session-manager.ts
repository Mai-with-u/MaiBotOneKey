import { EventEmitter } from "node:events";
import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as nodePty from "node-pty";
import type {
  PtyDataEvent,
  PtyEncoding,
  PtyErrorEvent,
  PtyExitEvent,
  PtyResizeRequest,
  PtySessionSnapshot,
  PtyStartRequest,
  PtyStopRequest,
} from "../../shared/contracts";
import { decodePtyData, encodePtyInput, getNodePtyEncoding, getWindowsCodePage } from "./encoding";

const MIN_COLS = 5;
const MIN_ROWS = 5;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 32;
const DEFAULT_FORCE_AFTER_MS = 10_000;
const BUFFER_LIMIT = 5_000_000;
const require = createRequire(import.meta.url);

type PtySessionEventMap = {
  data: [PtyDataEvent];
  exit: [PtyExitEvent];
  error: [PtyErrorEvent];
  snapshot: [PtySessionSnapshot];
};

function clampDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value) {
    return fallback;
  }

  return Math.max(Math.floor(value), value === fallback ? fallback : MIN_COLS);
}

function normalizeRows(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) {
    return DEFAULT_ROWS;
  }

  return Math.max(Math.floor(value), MIN_ROWS);
}

function normalizeEncoding(encoding: PtyEncoding | undefined): PtyEncoding {
  return encoding ?? "auto";
}

function resolveDefaultCwd(cwd: string | undefined): string {
  if (!cwd) {
    return process.cwd();
  }

  const absolute = resolve(cwd);
  try {
    return statSync(absolute).isDirectory() ? absolute : process.cwd();
  } catch {
    return process.cwd();
  }
}

interface ResolvedCommand {
  file: string;
  args: string[];
  displayCommand: string[];
  title: string;
}

function resolveExistingExecutable(candidates: Array<string | undefined>, fallback: string): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      continue;
    }

    if (existsSync(trimmed)) {
      return trimmed;
    }
  }

  return fallback;
}

function resolveWindowsShell(requestedShell: string | undefined): string {
  return resolveExistingExecutable([requestedShell, process.env.ComSpec], "cmd.exe");
}

function resolveUnixShell(requestedShell: string | undefined): string {
  const fallback = existsSync("/bin/sh") ? "/bin/sh" : "sh";
  return resolveExistingExecutable(
    [requestedShell, process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"],
    fallback,
  );
}

function resolveCommand(request: PtyStartRequest, encoding: PtyEncoding): ResolvedCommand {
  const requestedCommand = request.command?.filter(Boolean);
  const codePage = getWindowsCodePage(encoding);

  if (request.commandLine) {
    if (process.platform === "win32") {
      return {
        file: resolveWindowsShell(request.shell),
        args: ["/D", "/S", "/C", `chcp ${codePage} > nul & ${request.commandLine}`],
        displayCommand: [request.commandLine],
        title: request.title ?? request.commandLine,
      };
    }

    const shell = resolveUnixShell(request.shell);
    return {
      file: shell,
      args: ["-lc", request.commandLine],
      displayCommand: [request.commandLine],
      title: request.title ?? request.commandLine,
    };
  }

  if (requestedCommand && requestedCommand.length > 0) {
    if (process.platform === "win32") {
      return {
        file: requestedCommand[0],
        args: requestedCommand.slice(1),
        displayCommand: requestedCommand,
        title: request.title ?? basename(requestedCommand[0]),
      };
    }

    return {
      file: requestedCommand[0],
      args: requestedCommand.slice(1),
      displayCommand: requestedCommand,
      title: request.title ?? basename(requestedCommand[0]),
    };
  }

  if (process.platform === "win32") {
    const shell = resolveWindowsShell(request.shell);
    return {
      file: shell,
      args: ["/K", `chcp ${codePage} > nul`],
      displayCommand: [shell],
      title: request.title ?? "Windows Shell",
    };
  }

  const shell = resolveUnixShell(request.shell);
  return {
    file: shell,
    args: process.platform === "darwin" ? ["-l"] : [],
    displayCommand: [shell],
    title: request.title ?? basename(shell),
  };
}

function createEnvironment(extraEnv: Record<string, string> | undefined): Record<string, string> {
  const source = {
    ...process.env,
    TERM: process.platform === "win32" ? "xterm-256color" : (process.env.TERM ?? "xterm-256color"),
    COLORTERM: "truecolor",
    FORCE_COLOR: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...extraEnv,
  };
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

function toUnpackedAsarPath(path: string): string {
  return path.replace("app.asar", "app.asar.unpacked").replace("node_modules.asar", "node_modules.asar.unpacked");
}

function ensureExecutable(path: string): void {
  const stat = statSync(path);
  if ((stat.mode & 0o111) !== 0) {
    return;
  }

  chmodSync(path, stat.mode | 0o755);
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform === "win32") {
    return;
  }

  let nodePtyPackagePath: string;
  try {
    nodePtyPackagePath = require.resolve("node-pty/package.json");
  } catch {
    return;
  }

  const packageRoot = dirname(nodePtyPackagePath);
  const helperPath = toUnpackedAsarPath(
    join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  );
  if (existsSync(helperPath)) {
    ensureExecutable(helperPath);
  }
}

class PtySession {
  private ptyProcess: nodePty.IPty | null = null;
  private outputBuffer = "";
  private stopTimer: NodeJS.Timeout | null = null;
  private readonly createdAt = Date.now();
  private snapshot: PtySessionSnapshot;

  constructor(
    private readonly request: PtyStartRequest,
    private readonly emitEvent: <K extends keyof PtySessionEventMap>(
      event: K,
      ...args: PtySessionEventMap[K]
    ) => void,
  ) {
    const encoding = normalizeEncoding(request.encoding);
    const cwd = resolveDefaultCwd(request.cwd);
    const command = resolveCommand(request, encoding);

    this.snapshot = {
      id: request.id ?? randomUUID(),
      title: command.title,
      cwd,
      command: command.displayCommand,
      cols: clampDimension(request.cols, DEFAULT_COLS),
      rows: normalizeRows(request.rows),
      encoding,
      status: "starting",
      startedAt: this.createdAt,
    };
  }

  get id(): string {
    return this.snapshot.id;
  }

  get status(): PtySessionSnapshot["status"] {
    return this.snapshot.status;
  }

  get pid(): number | undefined {
    return this.snapshot.pid;
  }

  getBuffer(): string {
    return this.outputBuffer;
  }

  start(): PtySessionSnapshot {
    const encoding = this.snapshot.encoding;
    const command = resolveCommand(this.request, encoding);

    try {
      ensureNodePtySpawnHelperExecutable();
      this.ptyProcess = nodePty.spawn(command.file, command.args, {
        name: "xterm-256color",
        cols: this.snapshot.cols,
        rows: this.snapshot.rows,
        cwd: this.snapshot.cwd,
        env: createEnvironment(this.request.env),
        encoding: getNodePtyEncoding(encoding),
        handleFlowControl: true,
        useConpty: true,
      });
    } catch (error) {
      this.markError(error);
      throw error;
    }

    this.snapshot = {
      ...this.snapshot,
      pid: this.ptyProcess.pid,
      status: "running",
    };
    this.emitSnapshot();

    this.ptyProcess.onData((data) => {
      const decoded = decodePtyData(data as string | Buffer, encoding);
      this.appendOutput(decoded);
      this.emitEvent("data", {
        sessionId: this.id,
        data: decoded,
      });
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.clearStopTimer();
      this.snapshot = {
        ...this.snapshot,
        status: "exited",
        exitCode,
        signal,
        endedAt: Date.now(),
      };
      this.emitEvent("exit", {
        sessionId: this.id,
        exitCode,
        signal,
      });
      this.emitSnapshot();
    });

    return this.getSnapshot();
  }

  write(data: string): void {
    if (!this.ptyProcess || this.status !== "running") {
      throw new Error("PTY session is not running");
    }

    this.ptyProcess.write(encodePtyInput(data, this.snapshot.encoding));
  }

  resize(request: Omit<PtyResizeRequest, "sessionId">): void {
    const cols = clampDimension(request.cols, this.snapshot.cols);
    const rows = normalizeRows(request.rows);
    if (cols === this.snapshot.cols && rows === this.snapshot.rows) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      cols,
      rows,
    };

    if (this.ptyProcess && this.status === "running") {
      this.ptyProcess.resize(cols, rows);
    }

    this.emitSnapshot();
  }

  clear(): void {
    this.outputBuffer = "";
    this.ptyProcess?.clear();
  }

  stop(forceAfterMs = DEFAULT_FORCE_AFTER_MS): void {
    if (!this.ptyProcess || this.status === "exited") {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      status: "stopping",
    };
    this.emitSnapshot();

    try {
      this.ptyProcess.write("\x03");
    } catch (error) {
      this.emitError(error);
    }

    this.clearStopTimer();
    this.stopTimer = setTimeout(() => {
      if (this.status !== "exited") {
        this.kill();
      }
    }, forceAfterMs);
  }

  kill(): void {
    this.clearStopTimer();

    if (!this.ptyProcess || this.status === "exited") {
      return;
    }

    if (process.platform === "win32" && this.pid) {
      const killer = spawnChild("taskkill", ["/F", "/T", "/PID", String(this.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", (error) => {
        this.emitError(error);
        this.ptyProcess?.kill();
      });
      return;
    }

    this.ptyProcess.kill();
  }

  getSnapshot(): PtySessionSnapshot {
    return { ...this.snapshot };
  }

  private appendOutput(data: string): void {
    this.outputBuffer += data;
    if (this.outputBuffer.length > BUFFER_LIMIT) {
      this.outputBuffer = this.outputBuffer.slice(-BUFFER_LIMIT);
    }
  }

  private markError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.snapshot = {
      ...this.snapshot,
      status: "error",
      error: message,
      endedAt: Date.now(),
    };
    this.emitEvent("error", {
      sessionId: this.id,
      message,
    });
    this.emitSnapshot();
  }

  private emitError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emitEvent("error", {
      sessionId: this.id,
      message,
    });
  }

  private emitSnapshot(): void {
    this.emitEvent("snapshot", this.getSnapshot());
  }

  private clearStopTimer(): void {
    if (!this.stopTimer) {
      return;
    }

    clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }
}

export class PtySessionManager extends EventEmitter {
  private readonly sessions = new Map<string, PtySession>();

  start(request: PtyStartRequest): PtySessionSnapshot {
    const session = new PtySession(
      {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: process.platform === "win32" ? process.cwd() : homedir(),
        ...request,
      },
      (event, ...args) => {
        this.emit(event, ...args);
      },
    );

    const existing = this.sessions.get(session.id);
    if (existing?.status === "exited" || existing?.status === "error") {
      this.sessions.delete(session.id);
    } else if (existing) {
      throw new Error(`PTY session already exists: ${session.id}`);
    }

    this.sessions.set(session.id, session);

    try {
      return session.start();
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
  }

  input({ sessionId, data }: { sessionId: string; data: string }): void {
    this.getRequired(sessionId).write(data);
  }

  resize({ sessionId, cols, rows }: PtyResizeRequest): void {
    this.getRequired(sessionId).resize({ cols, rows });
  }

  stop({ sessionId, forceAfterMs }: PtyStopRequest): void {
    this.getRequired(sessionId).stop(forceAfterMs);
  }

  kill(sessionId: string): void {
    this.getRequired(sessionId).kill();
  }

  close(sessionId: string): void {
    const session = this.getRequired(sessionId);
    session.kill();
    this.sessions.delete(sessionId);
  }

  clear(sessionId: string): void {
    this.getRequired(sessionId).clear();
  }

  list(): PtySessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.getSnapshot());
  }

  getBuffer(sessionId: string): string {
    return this.getRequired(sessionId).getBuffer();
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
    this.removeAllListeners();
  }

  private getRequired(sessionId: string): PtySession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`PTY session not found: ${sessionId}`);
    }

    return session;
  }
}
