import { existsSync, type Dirent } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { runProcess, runWithoutAsar, samePath, sameOrInsidePath } from "./runtime-file-utils";
import type { QqComponentUpgradeEntry, QqComponentUpgradeId, QqComponentUpgradeResult, RuntimePaths, SnowLumaResetResult } from "../../shared/contracts";
function toDetail(error: unknown): string { return error instanceof Error ? error.message : String(error); }

const NAPCAT_COMPONENT_PROTECTED_PATHS = [
  "config",
  "data",
  "logs",
  "napcat/config",
  "napcat/data",
  "napcat/logs",
];

const SNOWLUMA_COMPONENT_PROTECTED_PATHS = ["config", "data", "logs"];
const NAPCAT_VERSION_CONFIG_PATTERN = /^versions\/[^/]+\/resources\/app\/napcat\/config(?:\/|$)/iu;
const COMPONENT_DATA_FILE_PATTERN = /(?:\.db|\.sqlite|\.sqlite3)(?:-(?:shm|wal))?$/iu;
const COMPONENT_LOG_FILE_PATTERN = /\.log$/iu;
function normalizeRelativePath(path: string): string {
  return path.split(/[\\/]+/u).filter(Boolean).join("/");
}

function isExactOrInsideRelativePath(path: string, protectedPath: string): boolean {
  return path === protectedPath || path.startsWith(`${protectedPath}/`);
}

function isProtectedByList(path: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((protectedPath) => isExactOrInsideRelativePath(path, protectedPath));
}

function isNapcatComponentProtectedPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const fileName = normalized.split("/").at(-1) ?? normalized;
  return (
    isProtectedByList(normalized, NAPCAT_COMPONENT_PROTECTED_PATHS) ||
    NAPCAT_VERSION_CONFIG_PATTERN.test(normalized) ||
    COMPONENT_DATA_FILE_PATTERN.test(fileName) ||
    COMPONENT_LOG_FILE_PATTERN.test(fileName)
  );
}

function isSnowLumaComponentProtectedPath(relativePath: string): boolean {
  return isProtectedByList(normalizeRelativePath(relativePath), SNOWLUMA_COMPONENT_PROTECTED_PATHS);
}

interface BundledComponentUpgradeSpec {
  id: QqComponentUpgradeId;
  name: string;
  moduleName: string;
  isProtectedPath: (relativePath: string) => boolean;
}

interface WindowsProcessInfo {
  ProcessId?: number;
  ExecutablePath?: string;
  CommandLine?: string;
}

function isBusyComponentFsError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

function normalizeQqComponentUpgradeError(componentName: string, error: unknown): Error {
  if (!isBusyComponentFsError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const errorPath = typeof error === "object" && error !== null && "path" in error
    ? String((error as NodeJS.ErrnoException).path)
    : "";
  const detail = errorPath ? `被占用路径: ${errorPath}` : toDetail(error);
  return new Error(`${componentName} 文件被占用，请关闭残留进程后重试。${detail}`);
}

/** Protocol payload maintenance is independent of MaiBot files and adapter runtime. */
export class ProtocolComponentManager {
  constructor(private readonly paths: Pick<RuntimePaths, "installRoot" | "napcatRoot" | "snowlumaRoot" | "bundledModulesRoot">) {}
  async resetSnowLumaComponent(): Promise<SnowLumaResetResult> {
    const bundledRoot = join(this.paths.bundledModulesRoot, "SnowLuma");
    const snowlumaRoot = this.paths.snowlumaRoot;

    if (!existsSync(bundledRoot)) {
      throw new Error(`内置 SnowLuma 模板缺失: ${bundledRoot}`);
    }

    if (samePath(bundledRoot, snowlumaRoot)) {
      throw new Error("当前 SnowLuma 目录指向内置模板，拒绝重置。请在打包后的可写数据目录中执行。");
    }

    const removed = existsSync(snowlumaRoot);
    await rm(snowlumaRoot, { recursive: true, force: true });
    await mkdir(dirname(snowlumaRoot), { recursive: true });
    await runWithoutAsar(() =>
      cp(bundledRoot, snowlumaRoot, {
        recursive: true,
        force: true,
        errorOnExist: false,
      }),
    );

    return {
      snowlumaRoot,
      bundledRoot,
      removed,
      copied: true,
      resetAt: Date.now(),
    };
  }

  async upgradeQqComponents(component?: QqComponentUpgradeId): Promise<QqComponentUpgradeResult> {
    if (component !== undefined && component !== "napcat" && component !== "snowluma") throw new Error("未知协议端组件");
    await this.cleanupQqComponentProcesses(component);

    const components: QqComponentUpgradeEntry[] = [];
    if (component !== "snowluma" && existsSync(join(this.paths.bundledModulesRoot, "napcat"))) {
      components.push(
        await this.upgradeBundledComponent({
          id: "napcat",
          name: "NapCat",
          moduleName: "napcat",
          isProtectedPath: isNapcatComponentProtectedPath,
        }),
      );
    }
    if (component !== "napcat") components.push(
      await this.upgradeBundledComponent({
        id: "snowluma",
        name: "SnowLuma",
        moduleName: "SnowLuma",
        isProtectedPath: isSnowLumaComponentProtectedPath,
      }),
    );
    return { components, upgradedAt: Date.now() };
  }

  private async cleanupQqComponentProcesses(component?: QqComponentUpgradeId): Promise<void> {
    if (process.platform !== "win32") {
      return;
    }

    const targetRoots = (component === "snowluma" ? [this.paths.snowlumaRoot] : component === "napcat" ? [this.paths.napcatRoot] : [this.paths.napcatRoot, this.paths.snowlumaRoot])
      .filter((path) => path.trim().length > 0)
      .map((path) => resolve(path));
    if (targetRoots.length === 0) {
      return;
    }

    let processes: WindowsProcessInfo[] = [];
    try {
      processes = await this.listWindowsProcesses();
    } catch {
      return;
    }

    const currentPid = process.pid;
    const targetPids = processes
      .filter((item) => typeof item.ProcessId === "number" && item.ProcessId > 0 && item.ProcessId !== currentPid)
      .filter((item) => this.isQqComponentProcess(item, targetRoots))
      .map((item) => item.ProcessId as number);

    const uniquePids = [...new Set(targetPids)];
    if (uniquePids.length === 0) {
      return;
    }

    await Promise.all(uniquePids.map((pid) => this.killWindowsProcessTree(pid).catch(() => undefined)));
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  private async listWindowsProcesses(): Promise<WindowsProcessInfo[]> {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Get-CimInstance Win32_Process |",
      "Select-Object ProcessId,ExecutablePath,CommandLine |",
      "ConvertTo-Json -Compress -Depth 2",
    ].join(" ");
    const output = await runProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], this.paths.installRoot, 12_000);
    if (!output.trim()) {
      return [];
    }

    const parsed = JSON.parse(output) as WindowsProcessInfo | WindowsProcessInfo[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  private isQqComponentProcess(processInfo: WindowsProcessInfo, targetRoots: string[]): boolean {
    const executablePath = typeof processInfo.ExecutablePath === "string" ? processInfo.ExecutablePath : "";
    if (executablePath && targetRoots.some((root) => sameOrInsidePath(root, executablePath))) {
      return true;
    }

    const commandLine = typeof processInfo.CommandLine === "string" ? processInfo.CommandLine : "";
    if (!commandLine) {
      return false;
    }

    const normalizedCommandLine = commandLine.replace(/\//gu, "\\").toLowerCase();
    return targetRoots
      .map((root) => resolve(root).replace(/\//gu, "\\").toLowerCase())
      .some((root) => normalizedCommandLine.includes(root));
  }

  private killWindowsProcessTree(pid: number): Promise<void> {
    return runProcess("taskkill", ["/PID", String(pid), "/T", "/F"], this.paths.installRoot, 8_000).then(() => undefined);
  }

  private async upgradeBundledComponent(spec: BundledComponentUpgradeSpec): Promise<QqComponentUpgradeEntry> {
    const bundledRoot = join(this.paths.bundledModulesRoot, spec.moduleName);
    const targetRoot = spec.id === "napcat" ? this.paths.napcatRoot : this.paths.snowlumaRoot;
    const upgradedAt = Date.now();

    if (!existsSync(bundledRoot)) {
      throw new Error(`内置 ${spec.name} 模板缺失: ${bundledRoot}`);
    }

    if (samePath(bundledRoot, targetRoot)) {
      return {
        id: spec.id,
        name: spec.name,
        root: targetRoot,
        bundledRoot,
        preservedEntries: [],
        copied: false,
        skipped: true,
        upgradedAt,
      };
    }

    const backupRoot = join(dirname(targetRoot), `.maibot-${spec.id}-upgrade-${upgradedAt}`);
    const stagingRoot = join(dirname(targetRoot), `.maibot-${spec.id}-upgrade-staging-${upgradedAt}`);
    const replacedRoot = join(dirname(targetRoot), `.maibot-${spec.id}-upgrade-replaced-${upgradedAt}`);
    let preservedEntries: string[] = [];
    let movedTargetAside = false;

    try {
      await mkdir(dirname(targetRoot), { recursive: true });
      await rm(stagingRoot, { recursive: true, force: true });
      await runWithoutAsar(() =>
        cp(bundledRoot, stagingRoot, {
          recursive: true,
          force: true,
          errorOnExist: false,
          filter: (sourcePath) => {
            if (samePath(sourcePath, bundledRoot)) {
              return true;
            }
            const relativePath = normalizeRelativePath(relative(bundledRoot, sourcePath));
            return !spec.isProtectedPath(relativePath);
          },
        }),
      );

      if (existsSync(targetRoot)) {
        preservedEntries = await this.moveProtectedComponentEntries(targetRoot, backupRoot, spec.isProtectedPath);
        await this.restoreProtectedComponentEntries(backupRoot, stagingRoot, preservedEntries);
        await this.movePath(targetRoot, replacedRoot);
        movedTargetAside = true;
      }

      await this.movePath(stagingRoot, targetRoot);
      if (movedTargetAside) {
        await rm(replacedRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (error) {
      await this.rollbackBundledComponentUpgrade({
        targetRoot,
        backupRoot,
        stagingRoot,
        replacedRoot,
        preservedEntries,
        movedTargetAside,
      }).catch(() => undefined);
      throw normalizeQqComponentUpgradeError(spec.name, error);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      id: spec.id,
      name: spec.name,
      root: targetRoot,
      bundledRoot,
      preservedEntries,
      copied: true,
      skipped: false,
      upgradedAt,
    };
  }

  private async rollbackBundledComponentUpgrade({
    targetRoot,
    backupRoot,
    stagingRoot,
    replacedRoot,
    preservedEntries,
    movedTargetAside,
  }: {
    targetRoot: string;
    backupRoot: string;
    stagingRoot: string;
    replacedRoot: string;
    preservedEntries: string[];
    movedTargetAside: boolean;
  }): Promise<void> {
    if (movedTargetAside && existsSync(replacedRoot)) {
      await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
      await this.movePath(replacedRoot, targetRoot);
    }

    if (preservedEntries.length > 0 && existsSync(stagingRoot) && existsSync(targetRoot)) {
      await this.restoreProtectedComponentEntries(stagingRoot, targetRoot, preservedEntries);
    }

    if (existsSync(backupRoot) && existsSync(targetRoot)) {
      await cp(backupRoot, targetRoot, {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
    }
  }

  private async moveProtectedComponentEntries(
    root: string,
    backupRoot: string,
    isProtectedPath: (relativePath: string) => boolean,
  ): Promise<string[]> {
    const entries: string[] = [];

    const visit = async (currentRoot: string, relativeRoot = ""): Promise<void> => {
      let children: Dirent[];
      try {
        children = await readdir(currentRoot, { withFileTypes: true });
      } catch {
        return;
      }

      for (const child of children) {
        const relativePath = normalizeRelativePath(join(relativeRoot, child.name));
        const sourcePath = join(root, relativePath);
        if (isProtectedPath(relativePath)) {
          const backupPath = join(backupRoot, ...relativePath.split("/"));
          await mkdir(dirname(backupPath), { recursive: true });
          await this.movePath(sourcePath, backupPath);
          entries.push(relativePath);
          continue;
        }

        if (child.isDirectory()) {
          await visit(sourcePath, relativePath);
        }
      }
    };

    await visit(root);
    return entries;
  }

  private async restoreProtectedComponentEntries(backupRoot: string, targetRoot: string, relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      const backupPath = join(backupRoot, ...relativePath.split("/"));
      if (!existsSync(backupPath)) {
        continue;
      }
      const targetPath = join(targetRoot, ...relativePath.split("/"));
      await mkdir(dirname(targetPath), { recursive: true });
      await rm(targetPath, { recursive: true, force: true });
      await this.movePath(backupPath, targetPath);
    }
  }

  private async movePath(source: string, target: string): Promise<void> {
    try {
      await rename(source, target);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EXDEV") {
        throw error;
      }
      await cp(source, target, { recursive: true, force: true, errorOnExist: false });
      await rm(source, { recursive: true, force: true });
    }
  }

}
