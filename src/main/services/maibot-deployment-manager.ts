import { readWorkspaceBots } from "./maibot-workspace";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { MaiBotModuleUpdateProgress, ModuleUpdateResult, RuntimePaths } from "../../shared/contracts";
import { PythonDependencyManager } from "./python-dependency-manager";
import { explainMaiBotUpdateError } from "../../shared/maibot-update-error";
import { SourceSettingsManager } from "./source-settings-manager";
import { deploymentFile, isMaiBotPackageMode, maiBotEnvironmentRoot, readMaiBotDeployment, type MaiBotDeployment } from "./maibot-deployment-state";

type Progress = (progress: MaiBotModuleUpdateProgress) => void;
type DeploymentPython = Pick<PythonDependencyManager, "ensurePythonEnvironment" | "installMaiBot" | "execute">;
const INSTANCE_STATE = ["config", "data", "plugins", "host", "bots"] as const;

function initializationCommand(version: string, root: string): string[] {
  const [major, minor] = version.split(".").map(Number);
  const command = major > 1 || (major === 1 && minor >= 4) ? ["host", "list"] : ["init"];
  return ["-I", "-m", "src.cli.tool", ...command, "--directory", root];
}

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
      if (!existsSync(join(root, "host", "registry.sqlite3")) && (!existsSync(join(root, "config", "bot_config.toml")) || !existsSync(join(root, "config", "model_config.toml")))) {
        await this.getPython().execute(initializationCommand(this.getState()!.packageVersion, root));
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
      let installingDependencies = false;
      const lock = before?.packageVersion === version
        ? join(maiBotEnvironmentRoot(root, before.generation), "onekey-requirements.txt") : undefined;
      const installed = await python.installMaiBot(version,
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
      // Registered Bots may live outside the workspace. Include their mutable state too.
      const external: { botId: string; directory: string; present: string[] }[] = [];
      const bots = existsSync(join(root, "host", "registry.sqlite3")) ? await readWorkspaceBots(root, this.getPython().getPythonPath()) : [];
      for (const bot of bots) {
        const rel = relative(root, bot.directory);
        if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) continue;
        const entries: string[] = [];
        for (const name of ["config", "data", "plugins"]) {
          if (existsSync(join(bot.directory, name))) {
            signal.throwIfAborted();
            await cp(join(bot.directory, name), join(snapshot, "external", bot.bot_id, name), { recursive: true });
            entries.push(name);
          }
        }
        external.push({ botId: bot.bot_id, directory: bot.directory, present: entries });
      }
      await writeFile(join(snapshot, "snapshot.json"), JSON.stringify({ present, external }));
      snapshotReady = true;
      signal.throwIfAborted();
      await writeFile(this.pendingFile(), JSON.stringify({ generation }));
      initializationStarted = true;
      emit("validating", 85, "初始化实例（保留已有配置）");
      if (!existsSync(join(root, "host", "registry.sqlite3"))) {
        await python.execute(initializationCommand(actual, root), (line) => emit("validating", 86, "初始化实例", line), signal);
      }
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
    const record = JSON.parse(await readFile(join(snapshot, "snapshot.json"), "utf8")) as {
      present: string[]; external?: { botId: string; directory: string; present: string[] }[];
    };
    const targets = INSTANCE_STATE.map((name) => ({ target: join(root, name), source: join(snapshot, name), present: record.present.includes(name) }));
    if (record.external?.length) {
      const bots = await readWorkspaceBots(snapshot, this.getPython().getPythonPath());
      for (const external of record.external) {
        const bot = bots.find((item) => item.bot_id === external.botId && item.directory === external.directory);
        if (!bot) throw new Error("备份中的外部机器人目录与登记记录不一致，拒绝回滚");
        for (const name of ["config", "data", "plugins"]) targets.push({
          target: join(bot.directory, name), source: join(snapshot, "external", bot.bot_id, name), present: external.present.includes(name),
        });
      }
    }
    // Prepare every replacement before changing any live directory.
    const transactionId = randomUUID();
    // Stage beside each target so external Bots on another volume can be renamed atomically.
    const staging = targets.map((entry, index) => join(dirname(entry.target), `.onekey-restore-${transactionId}-${index}`));
    const swapped: number[] = [];
    try {
      for (const [index, entry] of targets.entries()) {
        await mkdir(staging[index], { recursive: true });
        if (entry.present) await cp(entry.source, join(staging[index], "new"), { recursive: true });
      }
      for (const [index, entry] of targets.entries()) {
        if (existsSync(entry.target)) await rename(entry.target, join(staging[index], "old"));
        swapped.push(index);
        if (entry.present) await rename(join(staging[index], "new"), entry.target);
      }
      await commit?.();
    } catch (error) {
      for (const index of swapped.reverse()) {
        await rm(targets[index].target, { recursive: true, force: true });
        if (existsSync(join(staging[index], "old"))) await rename(join(staging[index], "old"), targets[index].target);
      }
      throw error;
    }
    await Promise.all(staging.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
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
