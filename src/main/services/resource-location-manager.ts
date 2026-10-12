import { RESOURCE_PATH_CANCELLED_MESSAGE } from "../../shared/resource-path-operation";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, statfs, unlink, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RuntimePaths, RuntimeResourcePathChangeResult, RuntimeResourcePathConfig, RuntimeResourcePathKey, ResourcePathMode, ResourcePathPlan, ResourcePathProgress } from "../../shared/contracts";
import { applyRuntimeResourcePaths, LEGACY_RESOURCE_LOCATION_FILE, RESOURCE_PATHS_FILE } from "./runtime-resource-paths";
import { RuntimeOperationLock } from "./runtime-operation-lock";

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
}
function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(RESOURCE_PATH_CANCELLED_MESSAGE);
}
interface CopyEntry { relative: string; directory: boolean; size: number; mtime: number; atime: Date; mode: number; }
interface PreparedPath { plan: ResourcePathPlan; entries: CopyEntry[]; }

type RuntimeResourcePathMap = Record<RuntimeResourcePathKey, string>;

interface ResourceLockPayload {
  pid: number;
  installRoot: string;
  key: RuntimeResourcePathKey;
  path: string;
  startedAt: number;
}

interface ResourceLock {
  lockPath: string;
  release: () => void;
}

interface ResourceLockAcquireResult {
  acquired: boolean;
  lock?: ResourceLock;
  existing?: ResourceLockPayload;
}

interface StoredResourcePathsFile {
  version: 1;
  paths: Partial<RuntimeResourcePathMap>;
  updatedAt: number;
}

const RESOURCE_LOCK_FILE = "resource.lock";
const RESOURCE_KEYS: RuntimeResourcePathKey[] = ["maibot", "napcat", "snowluma"];

function normalizePathForCompare(path: string): string {
  const resolved = canonicalPath(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = canonicalPath(parent);
  const resolvedChild = canonicalPath(child);
  const diff = relative(resolvedParent, resolvedChild);
  return Boolean(diff) && diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff);
}

function isPathNestedEitherWay(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPayload(lockPath: string): ResourceLockPayload | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as ResourceLockPayload;
  } catch {
    return undefined;
  }
}

function labelForKey(key: RuntimeResourcePathKey): string {
  switch (key) {
    case "maibot":
      return "MaiBot路径";
    case "napcat":
      return "NapCat路径";
    case "snowluma":
      return "SnowLuma路径";
  }
}

export class ResourceLocationManager extends EventEmitter {
  private locks: ResourceLock[] = [];
  private controller?: AbortController;
  private progress: ResourcePathProgress | null = null;
  private lastProgressAt = 0;
  private applyHandler?: () => Promise<void>;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly lockEnabled: boolean,
    private readonly operationLock = new RuntimeOperationLock(),
    private readonly assertStopped: () => void = () => {},
  ) {
    super();
    this.operationLock.on("change", () => this.emit("operation-change"));
  }

  withRuntimeActivity<T>(action: () => Promise<T>): Promise<T> { return this.operationLock.shared(action); }
  async finishBeforeQuit(): Promise<void> {
    if (this.progress) this.cancelOperation(this.progress.operationId);
    await this.operationLock.waitForIdle();
  }
  getOperationLabel(): string | null { return this.operationLock.label; }
  getProgress(): ResourcePathProgress | null { return this.progress ? { ...this.progress } : null; }
  setApplyHandler(handler: () => Promise<void>): void { this.applyHandler = handler; }
  withPathOperation<T>(action: () => Promise<T>): Promise<T> {
    return this.operationLock.exclusive("处理实例目录", this.assertStopped, action);
  }
  cancelOperation(operationId: string): boolean {
    if (!this.controller || this.progress?.operationId !== operationId || !["checking", "copying"].includes(this.progress.stage)) return false;
    this.controller.abort();
    return true;
  }

  getPathConfigs(): RuntimeResourcePathConfig[] {
    return RESOURCE_KEYS.map((key) => {
      const value = this.getPath(key), defaultValue = this.getDefaultPath(key);
      return { key, label: labelForKey(key), value, defaultValue, customized: !samePath(value, defaultValue) };
    });
  }

  acquireInitialLock(): ResourceLockAcquireResult {
    this.assertUniquePathSet(this.currentPathSet());
    if (!this.lockEnabled) return { acquired: true };
    const acquired: ResourceLock[] = [];
    for (const key of RESOURCE_KEYS) {
      const result = this.acquireLockForPath(key, this.getPath(key));
      if (!result.acquired) { for (const lock of acquired) lock.release(); return result; }
      if (result.lock) acquired.push(result.lock);
    }
    this.release(); this.locks = acquired;
    return { acquired: true };
  }
  release(): void { for (const lock of this.locks) lock.release(); this.locks = []; }

  inspectPath(key: RuntimeResourcePathKey, target: string, mode: ResourcePathMode): Promise<ResourcePathPlan> {
    return this.activity(key, async (signal) => (await this.prepare(key, target, mode, signal)).plan);
  }
  applyPlan(plan: ResourcePathPlan): Promise<RuntimeResourcePathChangeResult> {
    return this.changePath(plan.key, plan.targetPath, plan.mode, plan);
  }
  migratePath(key: RuntimeResourcePathKey, target: string): Promise<RuntimeResourcePathChangeResult> {
    return this.changePath(key, target, "copy");
  }
  selectPath(key: RuntimeResourcePathKey, target: string): Promise<RuntimeResourcePathChangeResult> {
    return this.changePath(key, target, "existing");
  }
  // Launcher-wide reset explicitly reinitializes its default directory on next startup.
  resetPath(key: RuntimeResourcePathKey): Promise<RuntimeResourcePathChangeResult> {
    return this.changePath(key, this.getDefaultPath(key), "existing", undefined, true);
  }

  private activity<T>(key: RuntimeResourcePathKey, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withPathOperation(async () => {
      if (!RESOURCE_KEYS.includes(key)) throw new Error("不支持的组件目录");
      if (this.controller) throw new Error("另一个组件目录操作正在进行，请等待完成或取消。");
      const controller = new AbortController(); this.controller = controller;
      this.progress = { operationId: randomUUID(), key, stage: "checking", copiedFiles: 0, copiedBytes: 0, totalFiles: 0, totalBytes: 0 };
      this.publish({}, true);
      try {
        const result = await action(controller.signal);
        this.publish({ stage: "completed", currentFile: undefined }, true);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.publish({ stage: controller.signal.aborted && message === RESOURCE_PATH_CANCELLED_MESSAGE ? "cancelled" : "failed", error: message }, true);
        throw error;
      } finally { this.controller = undefined; }
    });
  }
  private publish(update: Partial<ResourcePathProgress>, force = false): void {
    if (!this.progress) return;
    this.progress = { ...this.progress, ...update };
    if (force || Date.now() - this.lastProgressAt >= 100) {
      this.lastProgressAt = Date.now(); this.emit("progress", { ...this.progress });
    }
  }

  private normalizeTargetPath(target: string): string {
    const text = target.trim().replace(/^"(.*)"$/u, "$1");
    if (!text || !isAbsolute(text)) throw new Error("请输入完整的绝对目录路径，或点击浏览目录。");
    const normalized = canonicalPath(text);
    if (dirname(normalized) === normalized) throw new Error("不能直接使用磁盘根目录作为组件目录。");
    return normalized;
  }
  private assertCanUsePathSet(key: RuntimeResourcePathKey, paths: RuntimeResourcePathMap): void {
    this.assertUniquePathSet(paths);
    const target = paths[key];
    if (!samePath(target, this.getDefaultPath(key)) && (samePath(this.paths.bundledModulesRoot, target) || isPathNestedEitherWay(this.paths.bundledModulesRoot, target))) {
      throw new Error("不能使用一键包内置 modules 模板目录及其上级或子目录。");
    }
  }
  private assertUniquePathSet(paths: RuntimeResourcePathMap): void {
    for (let i = 0; i < RESOURCE_KEYS.length; i++) {
      for (const right of RESOURCE_KEYS.slice(i + 1)) {
        const left = RESOURCE_KEYS[i];
        if (samePath(paths[left], paths[right]) || isPathNestedEitherWay(paths[left], paths[right])) throw new Error(`${labelForKey(left)} 与 ${labelForKey(right)} 必须使用彼此独立的目录`);
      }
    }
  }
  private async validateDirectory(key: RuntimeResourcePathKey, path: string): Promise<void> {
    const directory = await lstat(path).catch(() => null);
    if (!directory?.isDirectory()) throw new Error(`目录不存在或不是文件夹: ${path}`);
    const file = async (name: string): Promise<boolean> => (await stat(join(path, name)).catch(() => null))?.isFile() === true;
    const dir = async (name: string): Promise<boolean> => (await stat(join(path, name)).catch(() => null))?.isDirectory() === true;
    let valid: boolean, hint: string;
    if (key === "maibot") { valid = await file("bot.py") && await dir("src"); hint = "bot.py 和 src"; }
    else if (key === "snowluma") { valid = await file("index.mjs") && await dir("native") && (process.platform !== "win32" || await file("node.exe")); hint = "index.mjs、native 和配套运行时"; }
    else { valid = (await file("index.js") && (process.platform !== "win32" || await file("node.exe"))) || (await file("NapCatWinBootMain.exe") && await dir("napcat")) || (process.platform === "darwin" && await file("napcat-macos-launch.sh") && await dir("napcat")); hint = "NapCat 的入口和配套运行时"; }
    if (!valid) throw new Error(`这不是有效的 ${labelForKey(key).replace("路径", "")} 目录：缺少 ${hint}。请选择直接包含这些文件的目录，而不是上级目录。`);
  }
  private assertNotInUse(target: string): void {
    const existing = readLockPayload(join(target, RESOURCE_LOCK_FILE));
    if (this.lockEnabled && isProcessAlive(existing?.pid)) throw new Error(`目标目录正在被另一个启动器使用（PID ${existing?.pid}）。`);
  }
  private async assertEmptyTarget(target: string): Promise<void> {
    if (!existsSync(target)) return;
    if (!(await lstat(target)).isDirectory()) throw new Error(`目标不是文件夹: ${target}`);
    const entries = (await readdir(target)).filter((name) => name !== RESOURCE_LOCK_FILE);
    if (entries.length) throw new Error(`复制目标必须是空目录，以免混合两套配置。已有内容: ${entries.slice(0, 5).join("、")}${entries.length > 5 ? "…" : ""}。要使用此目录中的实例，请选择“使用已有目录”。`);
  }
  private async scan(source: string, key: RuntimeResourcePathKey, signal: AbortSignal, reportProgress = true): Promise<CopyEntry[]> {
    const entries: CopyEntry[] = [];
    let fileCount = 0, totalBytes = 0;
    const visit = async (dir: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        checkCancelled(signal);
        if (!prefix && (name === RESOURCE_LOCK_FILE || (key === "snowluma" && name === ".maibot-target-runtime.mjs"))) continue;
        const rel = prefix ? join(prefix, name) : name;
        const info = await lstat(join(source, rel));
        if (info.isSymbolicLink()) throw new Error(`复制目录含符号链接或目录联接，无法保证独立副本: ${rel}。请移除链接或使用已有目录。`);
        if (!info.isDirectory() && !info.isFile()) throw new Error(`无法复制特殊文件: ${rel}`);
        entries.push({ relative: rel, directory: info.isDirectory(), size: info.isFile() ? info.size : 0, mtime: info.mtimeMs, atime: info.atime, mode: info.mode });
        if (info.isFile()) { fileCount += 1; totalBytes += info.size; }
        if (reportProgress) this.publish({ currentFile: rel, totalFiles: fileCount, totalBytes });
        if (info.isDirectory()) await visit(join(source, rel), rel);
      }
    };
    await visit(source, ""); checkCancelled(signal); return entries;
  }
  protected async getAvailableBytes(path: string): Promise<number> {
    try {
      const space = await statfs(path, { bigint: true });
      return Number(space.bavail * space.bsize);
    } catch (error) { throw new Error(`无法检查目标磁盘剩余空间，请检查目录权限：${String(error)}`); }
  }
  private fingerprint(entries: CopyEntry[]): string {
    return createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.relative, entry.directory, entry.size, entry.mtime]))).digest("hex");
  }
  private async prepare(key: RuntimeResourcePathKey, targetText: string, mode: ResourcePathMode, signal: AbortSignal, initializeDefault = false): Promise<PreparedPath> {
    if (!RESOURCE_KEYS.includes(key) || !["copy", "existing"].includes(mode)) throw new Error("无效的目录操作");
    const target = this.normalizeTargetPath(targetText), source = this.getPath(key);
    this.assertCanUsePathSet(key, { ...this.currentPathSet(), [key]: target });
    if (!samePath(source, target) && isPathNestedEitherWay(source, target)) throw new Error("目标目录不能是当前目录的上级或子目录，请选择彼此独立的目录。");
    if (mode === "copy" && samePath(source, target)) throw new Error("复制目标与当前目录相同，请选择一个新的空目录。");
    this.assertNotInUse(target);
    if (mode === "existing") {
      if (!initializeDefault) await this.validateDirectory(key, target);
      checkCancelled(signal);
      return { plan: { key, mode, sourcePath: source, targetPath: target, fileCount: 0, totalBytes: 0, unchanged: samePath(source, target) }, entries: [] };
    }
    try { await this.validateDirectory(key, source); } catch (error) { throw new Error(`当前组件目录尚未准备好，无法复制。请先初始化，或选择使用已有目录。${String(error)}`); }
    await this.assertEmptyTarget(target);
    const entries = await this.scan(source, key, signal);
    let ancestor = dirname(target); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const availableBytes = await this.getAvailableBytes(ancestor), totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (availableBytes < totalBytes + 16 * 1024 * 1024) throw new Error("目标磁盘剩余空间不足：需要容纳完整副本并预留至少 16 MiB。");
    checkCancelled(signal);
    return { plan: { key, mode, sourcePath: source, targetPath: target, fileCount: entries.filter((entry) => !entry.directory).length, totalBytes, availableBytes, unchanged: false, sourceFingerprint: this.fingerprint(entries) }, entries };
  }

  private async copyToStage(source: string, stage: string, entries: CopyEntry[], signal: AbortSignal): Promise<void> {
    for (const entry of entries) {
      checkCancelled(signal); this.publish({ currentFile: entry.relative });
      const destination = join(stage, entry.relative);
      if (entry.directory) { await mkdir(destination, { recursive: true, mode: entry.mode }); continue; }
      const before = await lstat(join(source, entry.relative));
      if (before.size !== entry.size || before.mtimeMs !== entry.mtime) throw new Error(`源文件已变化，请重新检查后重试: ${entry.relative}`);
      const counter = new Transform({ transform: (chunk, _encoding, callback) => {
        this.publish({ copiedBytes: (this.progress?.copiedBytes ?? 0) + chunk.length }); callback(null, chunk);
      } });
      await pipeline(createReadStream(join(source, entry.relative)), counter, createWriteStream(destination, { flags: "wx", mode: entry.mode }), { signal });
      await utimes(destination, entry.atime, new Date(entry.mtime));
      this.publish({ copiedFiles: (this.progress?.copiedFiles ?? 0) + 1 });
    }
    for (const entry of entries.filter((entry) => entry.directory).reverse()) await utimes(join(stage, entry.relative), entry.atime, new Date(entry.mtime));
  }

  private async changePath(key: RuntimeResourcePathKey, target: string, mode: ResourcePathMode, expected?: ResourcePathPlan, initializeDefault = false): Promise<RuntimeResourcePathChangeResult> {
    return this.activity(key, async (signal) => {
      const { plan, entries } = await this.prepare(key, target, mode, signal, initializeDefault);
      if (expected && (!samePath(expected.sourcePath, plan.sourcePath) || expected.sourceFingerprint !== plan.sourceFingerprint)) throw new Error("当前目录或源文件已变化，请重新检查目录后再操作。");
      const previous = this.currentPathSet();
      const result = (): RuntimeResourcePathChangeResult => ({ key, previousPath: plan.sourcePath, path: plan.targetPath, defaultPath: this.getDefaultPath(key), copiedEntries: mode === "copy" ? entries.filter((entry) => !entry.relative.includes(sep)).map((entry) => entry.relative) : [], copiedFiles: mode === "copy" ? plan.fileCount : 0, copiedBytes: mode === "copy" ? plan.totalBytes : 0, changedAt: Date.now() });
      if (plan.unchanged) return result();
      const stores = await this.readStores();
      const createdDirectories: string[] = []; let missing = plan.targetPath;
      while (!existsSync(missing)) { createdDirectories.push(missing); missing = dirname(missing); }
      const stage = mode === "copy" ? join(dirname(plan.targetPath), `.maibot-migration-${randomUUID()}`) : undefined;
      let nextLock: ResourceLock | undefined, persistenceStarted = false, applied = false, stageCreated = false;
      const installed: string[] = [];
      try {
        checkCancelled(signal);
        await mkdir(plan.targetPath, { recursive: true });
        if (this.lockEnabled) {
          const acquired = this.acquireLockForPath(key, plan.targetPath);
          if (!acquired.acquired) throw new Error("目标目录正在被另一个启动器使用。");
          nextLock = acquired.lock;
        }
        if (mode === "copy") await this.assertEmptyTarget(plan.targetPath);
        if (stage) {
          await mkdir(stage, { recursive: false }); stageCreated = true;
          this.publish({ stage: "copying", totalFiles: plan.fileCount, totalBytes: plan.totalBytes }, true);
          await this.copyToStage(plan.sourcePath, stage, entries, signal);
          const fresh = await this.scan(plan.sourcePath, key, signal, false);
          if (this.fingerprint(fresh) !== plan.sourceFingerprint) throw new Error("复制期间源目录发生变化，请重新检查后重试。");
          await this.validateDirectory(key, stage); await this.assertEmptyTarget(plan.targetPath);
        }
        checkCancelled(signal); this.publish({ stage: "committing", currentFile: undefined }, true);
        if (stage) {
          for (const name of await readdir(stage)) {
            if (existsSync(join(plan.targetPath, name))) throw new Error(`目标目录出现新文件，已中止复制: ${name}`);
            await rename(join(stage, name), join(plan.targetPath, name)); installed.push(name);
          }
        }
        persistenceStarted = true;
        const next = { ...previous, [key]: plan.targetPath };
        await this.writePathSet(next);
        applyRuntimeResourcePaths(this.paths, next); applied = true;
        await this.applyHandler?.();
        if (stage) await this.removeStage(stage, dirname(plan.targetPath));
        this.replaceLock(key, nextLock);
        return result();
      } catch (error) {
        this.publish({ stage: "rolling-back" }, true);
        const failures: string[] = [];
        if (persistenceStarted) { try { await this.restoreStores(stores); } catch (rollback) { failures.push(`路径记录恢复失败: ${String(rollback)}`); } }
        applyRuntimeResourcePaths(this.paths, previous);
        if (applied) { try { await this.applyHandler?.(); } catch (rollback) { failures.push(`运行状态恢复失败: ${String(rollback)}`); } }
        if (stage && stageCreated && failures.length === 0) {
          for (const name of installed.reverse()) {
            try {
              const published = join(plan.targetPath, name), staged = join(stage, name);
              if (!isPathInside(plan.targetPath, published) || !isPathInside(stage, staged)) throw new Error("拒绝回滚越界路径");
              await rename(published, staged);
            } catch (rollback) { failures.push(`目标文件回滚失败: ${String(rollback)}`); }
          }
        }
        nextLock?.release();
        if (stage && stageCreated && failures.length === 0) { try { await this.removeStage(stage, dirname(plan.targetPath)); } catch (rollback) { failures.push(String(rollback)); } }
        for (const directory of createdDirectories) {
          try { await rmdir(directory); } catch (rollback) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((rollback as NodeJS.ErrnoException).code ?? "")) failures.push(String(rollback)); }
        }
        if (failures.length) throw new Error(`${String(error)}；${failures.join("；")}。已保留原目录及未能清理的目标副本，请检查后重试。`);
        if (signal.aborted) throw new Error(RESOURCE_PATH_CANCELLED_MESSAGE);
        throw error;
      }
    });
  }

  private async removeStage(stage: string, parent: string): Promise<void> {
    const absolute = resolve(stage), expectedParent = resolve(parent);
    if (!samePath(dirname(absolute), expectedParent) || !basename(absolute).startsWith(".maibot-migration-") || !isPathInside(expectedParent, absolute)) throw new Error("拒绝清理不在预期目录中的临时副本");
    await rm(absolute, { recursive: true, force: true });
  }
  private currentPathSet(): RuntimeResourcePathMap { return { maibot: canonicalPath(this.paths.maibotRoot), napcat: canonicalPath(this.paths.napcatRoot), snowluma: canonicalPath(this.paths.snowlumaRoot) }; }
  private getPath(key: RuntimeResourcePathKey): string { return this.currentPathSet()[key]; }
  private getDefaultPath(key: RuntimeResourcePathKey): string { return { maibot: this.paths.defaultMaibotRoot, napcat: this.paths.defaultNapcatRoot, snowluma: this.paths.defaultSnowlumaRoot }[key]; }
  private locationPath(): string { return join(this.paths.userDataRoot, RESOURCE_PATHS_FILE); }
  private legacyLocationPath(): string { return join(this.paths.userDataRoot, LEGACY_RESOURCE_LOCATION_FILE); }
  private async readStores(): Promise<Map<string, Buffer | undefined>> {
    const result = new Map<string, Buffer | undefined>();
    for (const path of [this.locationPath(), this.legacyLocationPath()]) {
      try { result.set(path, await readFile(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; result.set(path, undefined); }
    }
    return result;
  }
  private async atomicWrite(path: string, content: Buffer | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx");
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
  }
  private async restoreStores(stores: Map<string, Buffer | undefined>): Promise<void> {
    for (const [path, content] of stores) {
      const current = await readFile(path).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (content?.equals(current ?? Buffer.alloc(0)) || (content === undefined && current === undefined)) continue;
      if (content === undefined) await unlink(path); else await this.atomicWrite(path, content);
    }
  }
  private async writePathSet(paths: RuntimeResourcePathMap): Promise<void> {
    const customized = Object.fromEntries(RESOURCE_KEYS.filter((key) => !samePath(paths[key], this.getDefaultPath(key))).map((key) => [key, paths[key]]));
    const payload: StoredResourcePathsFile = { version: 1, paths: customized, updatedAt: Date.now() };
    await this.atomicWrite(this.locationPath(), `${JSON.stringify(payload, null, 2)}\n`);
    try { await unlink(this.legacyLocationPath()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private acquireLockForPath(key: RuntimeResourcePathKey, resourcePath: string): ResourceLockAcquireResult {
    const lockPath = join(resourcePath, RESOURCE_LOCK_FILE);
    const payload: ResourceLockPayload = {
      pid: process.pid,
      installRoot: this.paths.installRoot,
      key,
      path: resourcePath,
      startedAt: Date.now(),
    };

    mkdirSync(resourcePath, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
        return {
          acquired: true,
          lock: {
            lockPath,
            release: () => {
              const current = readLockPayload(lockPath);
              if (current?.pid === process.pid) {
                try {
                  unlinkSync(lockPath);
                } catch {
                  // The lock is best-effort; shutdown can continue if it was removed already.
                }
              }
            },
          },
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }

        const existing = readLockPayload(lockPath);
        if (isProcessAlive(existing?.pid)) {
          return { acquired: false, existing };
        }

        try {
          unlinkSync(lockPath);
        } catch {
          return { acquired: false, existing };
        }
      }
    }

    return { acquired: false, existing: readLockPayload(lockPath) };
  }

  private replaceLock(key: RuntimeResourcePathKey, nextLock: ResourceLock | undefined): void {
    const existingIndex = this.locks.findIndex((lock) => readLockPayload(lock.lockPath)?.key === key);
    if (existingIndex >= 0) {
      this.locks[existingIndex].release();
      this.locks.splice(existingIndex, 1);
    }
    if (nextLock) {
      this.locks.push(nextLock);
    }
  }
}
