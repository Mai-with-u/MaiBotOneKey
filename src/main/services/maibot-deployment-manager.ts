import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { MaiBotModuleUpdateProgress, ModuleUpdateResult, RuntimePaths } from "../../shared/contracts";
import { PythonDependencyManager } from "./python-dependency-manager";
import { explainMaiBotUpdateError } from "../../shared/maibot-update-error";
import { SourceSettingsManager } from "./source-settings-manager";
import { deploymentFile, isMaiBotPackageMode, maiBotEnvironmentRoot, readMaiBotDeployment, type MaiBotDeployment } from "./maibot-deployment-state";

type Progress = (progress: MaiBotModuleUpdateProgress) => void;
type DeploymentPython = Pick<PythonDependencyManager, "ensurePythonEnvironment" | "installMaiBot" | "execute">;
const INSTANCE_STATE = ["config", "data", "plugins"] as const;

/** Environments are created at their final path; only the small deployment record is replaced. */
export class MaiBotDeploymentManager {
  private pending?: Promise<ModuleUpdateResult>;
  private controller?: AbortController;
  constructor(private readonly paths: RuntimePaths, private readonly sources?: SourceSettingsManager,
    private readonly createEnvironment: (paths: RuntimePaths) => DeploymentPython = (paths) => new PythonDependencyManager(paths, sources, true)) {}

  isPackageMode(): boolean { return isMaiBotPackageMode(this.paths); }
  getState(): MaiBotDeployment | undefined { return this.paths.maibotDevMode === "source" ? undefined : readMaiBotDeployment(this.paths.maibotRoot); }
  getPython(): PythonDependencyManager { return new PythonDependencyManager(this.paths, this.sources); }

  async ensureInstalled(onProgress?: Progress): Promise<void> {
    if (!this.isPackageMode()) return;
    await this.recoverInterruptedInstall();
    if (this.getState()) {
      const root = this.paths.maibotRoot;
      if (!existsSync(join(root, "config", "bot_config.toml")) || !existsSync(join(root, "config", "model_config.toml"))) {
        await this.getPython().execute(["-I", "-m", "src.cli.tool", "init", "--directory", root]);
      }
      return;
    }
    let version: string;
    try {
      onProgress?.({ phase: "preparing", percent: 2, label: "正在查询 MaiBot 最新正式版", updatedAt: Date.now() });
      // listMaiBotVersions already applies PEP 440 ordering and Python compatibility checks.
      const packages = await this.getPython().listMaiBotVersions();
      const latest = packages.versions.find((item) => !item.isPrerelease && !item.isDev);
      if (!latest) throw new Error("当前 Python 包源没有兼容的 MaiBot 正式版，请检查包源设置后重试");
      version = latest.version;
    } catch (error) {
      onProgress?.({ phase: "failed", percent: 2, label: "查询 MaiBot 正式版失败", detail: String(error), updatedAt: Date.now() });
      throw error;
    }
    await this.install(version, onProgress);
  }

  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  install(version: string, onProgress?: Progress): Promise<ModuleUpdateResult> {
    if (this.paths.maibotDevMode === "source") throw new Error("源码调试模式不安装 PyPI 核心，请使用 bun run dev:pypi 测试安装版");
    if (this.pending) throw new Error("MaiBot 安装或更新正在进行，请稍后重试");
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.installIntoNewEnvironment(version, controller.signal, onProgress).finally(() => {
      this.pending = undefined;
      this.controller = undefined;
    });
    return this.pending;
  }

  private async save(state: MaiBotDeployment): Promise<void> {
    const path = deploymentFile(this.paths.maibotRoot);
    await mkdir(this.paths.maibotRoot, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  private async installIntoNewEnvironment(version: string, signal: AbortSignal, onProgress?: Progress): Promise<ModuleUpdateResult> {
    await this.recoverInterruptedInstall();
    const before = this.getState();
    const generation = randomUUID();
    const root = this.paths.maibotRoot;
    // Migration never checks out a branch or modifies Git metadata/source files.
    const sourceInstance = !before && existsSync(join(root, "bot.py"));
    const environment = maiBotEnvironmentRoot(root, generation);
    const snapshot = join(root, ".onekey", "snapshots", generation);
    const python = this.createEnvironment({ ...this.paths, pythonEnvRoot: environment });
    const output: string[] = [];
    let stage = "准备独立 Python 环境";
    let lastPercent = 0;
    const emit = (phase: MaiBotModuleUpdateProgress["phase"], percent: number, label: string, log?: string): void => {
      if (phase !== "failed") { stage = label; lastPercent = percent; }
      if (log) output.push(log);
      try { onProgress?.({ phase, percent, label, detail: log, log, updatedAt: Date.now() }); } catch { /* UI listeners cannot invalidate a committed installation. */ }
    };
    let snapshotReady = false;
    let initializationStarted = false;
    try {
      emit("preparing", 5, sourceInstance ? "准备将源码实例迁移到 PyPI" : "准备独立 Python 环境",
        sourceInstance ? `安装 MaiBot ${version}；保留原 Git 分支、源码和本地修改` : `MaiBot ${version}`);
      signal.throwIfAborted();
      await python.ensurePythonEnvironment((line) => emit("preparing", 10, "准备独立 Python 环境", line));
      const pluginRequirements: string[] = [];
      const plugins = await readdir(join(root, "plugins"), { withFileTypes: true }).catch(() => []);
      for (const plugin of plugins) {
        const path = join(root, "plugins", plugin.name, "requirements.txt");
        if (plugin.isDirectory() && existsSync(path)) pluginRequirements.push(path);
      }
      let installingDependencies = false;
      const lock = before?.packageVersion === version
        ? join(maiBotEnvironmentRoot(root, before.generation), "onekey-requirements.txt") : undefined;
      const installed = await python.installMaiBot(version, pluginRequirements,
        (line) => emit(installingDependencies ? "installing-dependencies" : "installing", installingDependencies ? 50 : 30,
          installingDependencies ? "正在安装依赖" : "正在安装 MaiBot", line), signal,
        lock && existsSync(lock) ? lock : undefined,
        (phase) => {
          installingDependencies = phase === "dependencies";
          emit(installingDependencies ? "installing-dependencies" : "installing", installingDependencies ? 40 : 20,
            installingDependencies ? "正在安装依赖" : "正在安装 MaiBot");
        });
      emit("validating", 65, "验证包与 Python 环境");
      await python.execute(["-I", "-m", "pip", "check"], (line) => emit("validating", 67, "检查依赖兼容性", line), signal);
      const probe = await python.execute(["-I", "-c", [
        "import json, pathlib, sys",
        "from importlib.metadata import version",
        "from packaging.version import Version",
        "import src.cli.tool, src.common.paths",
        "actual=version('maibot')",
        "assert Version(actual)==Version(sys.argv[1]), f'Unexpected MaiBot version: {actual}'",
        "resources=src.common.paths.RESOURCE_ROOT",
        "assert src.common.paths.PACKAGED_INSTALL, 'MaiBot was imported from source instead of the installed wheel'",
        "for name in ['EULA.md','PRIVACY.md','pyproject.toml']:",
        " assert (resources/name).is_file(), f'Missing package resource: {name}'",
        "print(json.dumps({'version':actual}))",
      ].join("\n"), version], undefined, signal);
      const actual = (JSON.parse(probe.join("\n")) as { version: string }).version;
      emit("validating", 72, "备份实例配置、数据与插件");
      await mkdir(snapshot, { recursive: true });
      const present: string[] = [];
      for (const name of INSTANCE_STATE) {
        signal.throwIfAborted();
        if (existsSync(join(root, name))) {
          await cp(join(root, name), join(snapshot, name), { recursive: true });
          present.push(name);
        }
      }
      await writeFile(join(snapshot, "snapshot.json"), JSON.stringify({ present }));
      snapshotReady = true;
      signal.throwIfAborted();
      await writeFile(this.pendingFile(), JSON.stringify({ generation }));
      initializationStarted = true;
      emit("validating", 85, "初始化实例（保留已有配置）");
      await python.execute(["-I", "-m", "src.cli.tool", "init", "--directory", root], (line) => emit("validating", 86, "初始化实例", line), signal);
      const packages = await python.execute(["-I", "-m", "pip", "freeze", "--all"], undefined, signal);
      await writeFile(join(environment, "onekey-requirements.txt"), `${packages.join("\n")}\n`);
      signal.throwIfAborted();
      emit("switching", 95, "切换至已验证的环境");
      await this.save({ schema: 1, mode: "pypi", generation, packageVersion: actual, sourceUrl: installed.sourceUrl,
        installedAt: Date.now(), snapshot: generation,
        previous: before ? { mode: "pypi", generation: before.generation, packageVersion: before.packageVersion }
          : sourceInstance ? { mode: "source" } : undefined });
      await rm(this.pendingFile(), { force: true }).catch(() => undefined);
      await this.pruneUnusedGenerations().catch((error) => emit("switching", 98, "旧环境清理未完成", String(error)));
      emit("completed", 100, "MaiBot 安装完成", `${before?.packageVersion ?? (sourceInstance ? "源码实例" : "未安装")} → ${actual}`);
      return { moduleId: "maibot", moduleName: "MaiBot", cwd: root, before: before?.packageVersion,
        after: actual, remote: installed.sourceUrl, changed: true, output, updatedAt: Date.now(), source: "remote" };
    } catch (error) {
      // Only init can have touched the instance. Failed downloads never replace the active record.
      const detail = error instanceof Error ? error.message : String(error);
      let cleanupWarning: string | undefined;
      if (snapshotReady && initializationStarted) {
        try { await this.restoreSnapshot(generation); }
        catch (restoreError) {
          const message = `${explainMaiBotUpdateError(detail, stage)}\n配置恢复失败，请保留实例目录并联系维护者。`;
          const errorDetails = `${detail}\n\n配置恢复错误：${String(restoreError)}`;
          try { onProgress?.({ phase: "failed", percent: lastPercent, label: "MaiBot 更新失败", detail: message, errorDetails, log: message, updatedAt: Date.now() }); } catch { /* UI listener */ }
          // Retain pending.json and the snapshot for startup recovery.
          throw new Error(`${message}\n\n技术详情：${errorDetails}`, { cause: error });
        }
      }
      try {
        await this.cleanupFailedInstall(environment);
      } catch (cleanupError) {
        cleanupWarning = `未启用的新环境清理失败，原环境不受影响；残留文件不会用于启动。\n${String(cleanupError)}`;
      }
      const message = `${explainMaiBotUpdateError(detail, stage)}\n${before || sourceInstance ? "原版本未切换，可以继续使用。" : "新环境未启用，请处理后重新安装。"}`;
      output.push(detail);
      try { onProgress?.({ phase: "failed", percent: lastPercent, label: "MaiBot 更新失败", detail: message, errorDetails: detail, cleanupWarning, log: detail, updatedAt: Date.now() }); } catch { /* UI listener */ }
      throw new Error(`${message}\n\n技术详情：${detail}`, { cause: error });
    }
  }

  private pendingFile(): string { return join(this.paths.maibotRoot, ".onekey", "pending.json"); }

  private async cleanupFailedInstall(environment: string): Promise<void> {
    await rm(this.pendingFile(), { force: true });
    // Windows may briefly retain executable handles after the installer exits.
    await rm(environment, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  private async pruneUnusedGenerations(): Promise<void> {
    const current = this.getState();
    if (!current) return;
    const root = await realpath(this.paths.maibotRoot);
    for (const kind of ["environments", "snapshots"] as const) {
      const parent = join(root, ".onekey", kind);
      const canonical = await realpath(parent);
      const diff = relative(root, canonical);
      if (!diff || isAbsolute(diff) || diff === ".." || diff.startsWith(`..${sep}`)) throw new Error(`环境目录超出实例范围：${parent}`);
      const keep = kind === "environments"
        ? [current.generation, current.previous?.mode === "pypi" ? current.previous.generation : undefined]
        : [current.snapshot];
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || keep.includes(entry.name) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(entry.name)) continue;
        const target = join(canonical, entry.name);
        if (existsSync(join(target, kind === "environments" ? "maibot-python-env.json" : "snapshot.json"))) {
          await rm(target, { recursive: true, force: true });
        }
      }
    }
  }

  private async recoverInterruptedInstall(): Promise<void> {
    if (!existsSync(this.pendingFile())) return;
    const pending = JSON.parse(await readFile(this.pendingFile(), "utf8")) as { generation: string };
    const environment = maiBotEnvironmentRoot(this.paths.maibotRoot, pending.generation);
    if (this.getState()?.generation !== pending.generation) {
      await this.restoreSnapshot(pending.generation);
      await rm(environment, { recursive: true, force: true });
    }
    await rm(this.pendingFile());
  }

  private async restoreSnapshot(generation: string, commit?: () => Promise<void>): Promise<void> {
    maiBotEnvironmentRoot(this.paths.maibotRoot, generation); // Validate before resolving snapshot paths.
    const root = this.paths.maibotRoot;
    const snapshot = join(root, ".onekey", "snapshots", generation);
    const record = JSON.parse(await readFile(join(snapshot, "snapshot.json"), "utf8")) as { present: string[] };
    // Prepare every replacement before changing any live directory.
    const transaction = join(root, ".onekey", `restore-${randomUUID()}`);
    const swapped: string[] = [];
    await mkdir(transaction, { recursive: true });
    try {
      for (const name of INSTANCE_STATE) {
        if (record.present.includes(name)) await cp(join(snapshot, name), join(transaction, `new-${name}`), { recursive: true });
      }
      for (const name of INSTANCE_STATE) {
        if (existsSync(join(root, name))) await rename(join(root, name), join(transaction, `old-${name}`));
        swapped.push(name);
        if (record.present.includes(name)) await rename(join(transaction, `new-${name}`), join(root, name));
      }
      await commit?.();
    } catch (error) {
      for (const name of swapped.reverse()) {
        await rm(join(root, name), { recursive: true, force: true });
        if (existsSync(join(transaction, `old-${name}`))) await rename(join(transaction, `old-${name}`), join(root, name));
      }
      throw error;
    }
    await rm(transaction, { recursive: true, force: true }).catch(() => undefined);
  }

  async rollback(): Promise<void> {
    if (this.pending) throw new Error("MaiBot 安装或更新正在进行");
    const current = this.getState();
    if (!current?.previous || !current.snapshot) throw new Error("没有可恢复的 MaiBot 环境");
    if (current.previous.mode === "pypi" && !existsSync(maiBotEnvironmentRoot(this.paths.maibotRoot, current.previous.generation))) {
      throw new Error("上一 Python 环境缺失，无法恢复");
    }
    const previous = current.previous;
    await this.restoreSnapshot(current.snapshot, async () => {
      if (previous.mode === "source") await rm(deploymentFile(this.paths.maibotRoot));
      else await this.save({ ...previous, schema: 1, installedAt: Date.now(), sourceUrl: current.sourceUrl });
    });
  }
}
