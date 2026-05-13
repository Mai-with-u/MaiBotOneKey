import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { cp, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  RuntimePaths,
  RuntimeResourcePathChangeResult,
  RuntimeResourcePathConfig,
  RuntimeResourcePathKey,
} from "../../shared/contracts";
import { applyRuntimeResourcePaths, LEGACY_RESOURCE_LOCATION_FILE, RESOURCE_PATHS_FILE } from "./paths";

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
const RESOURCE_KEYS: RuntimeResourcePathKey[] = ["maibot", "napcat", "pythonOverrides"];
const EDITABLE_RESOURCE_KEYS: RuntimeResourcePathKey[] = ["maibot", "napcat"];

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
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
    case "pythonOverrides":
      return "python可写环境";
  }
}

export class ResourceLocationManager {
  private locks: ResourceLock[] = [];

  constructor(
    private readonly paths: RuntimePaths,
    private readonly lockEnabled: boolean,
  ) {}

  getPathConfigs(): RuntimeResourcePathConfig[] {
    return EDITABLE_RESOURCE_KEYS.map((key) => {
      const value = this.getPath(key);
      const defaultValue = this.getDefaultPath(key);
      return {
        key,
        label: labelForKey(key),
        value,
        defaultValue,
        customized: !samePath(value, defaultValue),
      };
    });
  }

  acquireInitialLock(): ResourceLockAcquireResult {
    this.assertUniquePathSet(this.currentPathSet());
    if (!this.lockEnabled) {
      return { acquired: true };
    }

    const acquired: ResourceLock[] = [];
    for (const key of RESOURCE_KEYS) {
      const result = this.acquireLockForPath(key, this.getPath(key));
      if (!result.acquired) {
        for (const lock of acquired) {
          lock.release();
        }
        return result;
      }
      if (result.lock) {
        acquired.push(result.lock);
      }
    }

    this.release();
    this.locks = acquired;
    return { acquired: true };
  }

  release(): void {
    for (const lock of this.locks) {
      lock.release();
    }
    this.locks = [];
  }

  async migratePath(key: RuntimeResourcePathKey, targetPath: string): Promise<RuntimeResourcePathChangeResult> {
    return this.changePath(key, targetPath, true);
  }

  async selectPath(key: RuntimeResourcePathKey, targetPath: string): Promise<RuntimeResourcePathChangeResult> {
    return this.changePath(key, targetPath, false);
  }

  async resetPath(key: RuntimeResourcePathKey): Promise<RuntimeResourcePathChangeResult> {
    return this.changePath(key, this.getDefaultPath(key), true);
  }

  private async changePath(
    key: RuntimeResourcePathKey,
    targetPath: string,
    copyExisting: boolean,
  ): Promise<RuntimeResourcePathChangeResult> {
    if (key === "pythonOverrides") {
      throw new Error("python可写环境路径不允许修改");
    }
    const normalizedTarget = this.normalizeTargetPath(targetPath);
    const previousPath = this.getPath(key);
    const pathChanged = !samePath(previousPath, normalizedTarget);
    const nextPathSet = { ...this.currentPathSet(), [key]: normalizedTarget };
    const copiedEntries: string[] = [];

    this.assertCanUsePathSet(key, nextPathSet);
    const nextLockResult: ResourceLockAcquireResult = this.lockEnabled && pathChanged
      ? this.acquireLockForPath(key, normalizedTarget)
      : { acquired: true };
    if (!nextLockResult.acquired) {
      throw new Error(`目标路径正在被其他进程使用: ${nextLockResult.existing?.pid ?? "unknown"}`);
    }

    try {
      await mkdir(normalizedTarget, { recursive: true });
      if (copyExisting && pathChanged) {
        copiedEntries.push(...(await this.copyRuntimeResourceEntry(key, previousPath, normalizedTarget)));
      }
      await this.writePathSet(nextPathSet);
      applyRuntimeResourcePaths(this.paths, nextPathSet);
      if (pathChanged) {
        this.replaceLock(key, nextLockResult.lock);
      }
    } catch (error) {
      nextLockResult.lock?.release();
      throw error;
    }

    return {
      key,
      previousPath,
      path: this.getPath(key),
      defaultPath: this.getDefaultPath(key),
      copiedEntries,
      changedAt: Date.now(),
    };
  }

  private normalizeTargetPath(targetPath: string): string {
    const trimmed = targetPath.trim();
    if (!trimmed) {
      throw new Error("路径不能为空");
    }
    return resolve(trimmed);
  }

  private assertCanUsePathSet(changedKey: RuntimeResourcePathKey, pathSet: RuntimeResourcePathMap): void {
    this.assertUniquePathSet(pathSet);

    const targetPath = pathSet[changedKey];
    const defaultPath = this.getDefaultPath(changedKey);
    const movingToDefault = samePath(targetPath, defaultPath);
    if (movingToDefault) {
      return;
    }

    if (changedKey !== "pythonOverrides" && isPathNestedEitherWay(this.paths.bundledModulesRoot, targetPath)) {
      throw new Error("MaiBot 与 NapCat 路径不能放在一键包内置 modules 模板目录中");
    }
    if (changedKey === "pythonOverrides" && isPathNestedEitherWay(this.paths.runtimeRoot, targetPath)) {
      throw new Error("python可写环境不能放在 python基础环境目录中");
    }
  }

  private assertUniquePathSet(pathSet: RuntimeResourcePathMap): void {
    for (let index = 0; index < RESOURCE_KEYS.length; index += 1) {
      const leftKey = RESOURCE_KEYS[index];
      const leftPath = pathSet[leftKey];
      for (const rightKey of RESOURCE_KEYS.slice(index + 1)) {
        const rightPath = pathSet[rightKey];
        if (samePath(leftPath, rightPath) || isPathNestedEitherWay(leftPath, rightPath)) {
          throw new Error(`${labelForKey(leftKey)} 与 ${labelForKey(rightKey)} 必须使用彼此独立的目录`);
        }
      }
    }
  }

  private async copyRuntimeResourceEntry(
    key: RuntimeResourcePathKey,
    sourcePath: string,
    targetPath: string,
  ): Promise<string[]> {
    const copiedEntries: string[] = [];
    if (existsSync(sourcePath)) {
      await mkdir(dirname(targetPath), { recursive: true });
      await cp(sourcePath, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: false,
        preserveTimestamps: true,
      });
      copiedEntries.push(key);
    }

    if (key === "napcat") {
      const sourceFramework = join(dirname(sourcePath), "napcatframework");
      const targetFramework = join(dirname(targetPath), "napcatframework");
      if (existsSync(sourceFramework) && !samePath(sourceFramework, targetFramework)) {
        await mkdir(dirname(targetFramework), { recursive: true });
        await cp(sourceFramework, targetFramework, {
          recursive: true,
          force: false,
          errorOnExist: false,
          preserveTimestamps: true,
        });
        copiedEntries.push("napcatframework");
      }
    }

    return copiedEntries;
  }

  private currentPathSet(): RuntimeResourcePathMap {
    return {
      maibot: this.paths.maibotRoot,
      napcat: this.paths.napcatRoot,
      pythonOverrides: this.paths.pythonOverridesRoot,
    };
  }

  private getPath(key: RuntimeResourcePathKey): string {
    return this.currentPathSet()[key];
  }

  private getDefaultPath(key: RuntimeResourcePathKey): string {
    switch (key) {
      case "maibot":
        return this.paths.defaultMaibotRoot;
      case "napcat":
        return this.paths.defaultNapcatRoot;
      case "pythonOverrides":
        return this.paths.defaultPythonOverridesRoot;
    }
  }

  private locationPath(): string {
    return join(this.paths.userDataRoot, RESOURCE_PATHS_FILE);
  }

  private legacyLocationPath(): string {
    return join(this.paths.userDataRoot, LEGACY_RESOURCE_LOCATION_FILE);
  }

  private async writePathSet(pathSet: RuntimeResourcePathMap): Promise<void> {
    const customizedPaths = Object.fromEntries(
      RESOURCE_KEYS.filter((key) => !samePath(pathSet[key], this.getDefaultPath(key))).map((key) => [
        key,
        pathSet[key],
      ]),
    ) as Partial<RuntimeResourcePathMap>;

    const storePath = this.locationPath();
    await unlink(this.legacyLocationPath()).catch(() => undefined);
    if (Object.keys(customizedPaths).length === 0) {
      await unlink(storePath).catch(() => undefined);
      return;
    }

    const payload: StoredResourcePathsFile = {
      version: 1,
      paths: customizedPaths,
      updatedAt: Date.now(),
    };
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
