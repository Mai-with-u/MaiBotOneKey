import { readWorkspaceBots } from "./maibot-workspace";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { MaiBotModuleUpdateProgress, ModuleUpdateResult, RuntimePaths } from "../../shared/contracts";
import { PythonDependencyManager } from "./python-dependency-manager";
import { explainMaiBotUpdateError } from "../../shared/maibot-update-error";
import { SourceSettingsManager } from "./source-settings-manager";
import { deploymentFile, isMaiBotPackageMode, maiBotEnvironmentRoot, readMaiBotDeployment, validGeneration, type MaiBotDeployment } from "./maibot-deployment-state";

type Progress = (progress: MaiBotModuleUpdateProgress) => void;
type DeploymentPython = Pick<PythonDependencyManager, "ensurePythonEnvironment" | "installMaiBot" | "execute">;
const INSTANCE_STATE = ["config", "data", "plugins", "host", "bots"] as const;
// Root entries shipped with the old source tree. Keep bot.py last so cleanup can resume after interruption.
const LEGACY_SOURCE_ENTRIES = [
  ".coderabbit.yaml", ".devcontainer", ".dockerignore", ".git", ".gitattributes", ".github", ".gitignore",
  ".pre-commit-config.yaml", "AGENTS.md", "CLAUDE.md", "CODE_OF_CONDUCT.md", "Dockerfile", "EULA.md", "LICENSE",
  "MANIFEST.in", "PRIVACY.md", "README.md", "changelogs", "crowdin.yml", "dashboard", "depends-data",
  "docker-compose.yml", "docker-entrypoint.sh", "docs", "locales", "news_server", "pet-clients", "prompts",
  "pyproject.toml", "pytests", "requirements.txt", "scripts", "setup.py", "src", "template", "tests", "uv.lock", "bot.py",
] as const;

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
    let deployment = this.getState();
    if (!deployment) {
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
      deployment = this.getState()!;
    } else {
      await this.cleanupLegacySource();
    }
    const root = this.paths.maibotRoot;
    const command = initializationCommand(deployment.packageVersion, root);
    const needsInitialization = command.includes("host")
      ? !existsSync(join(root, "host", "registry.sqlite3"))
      : !existsSync(join(root, "config", "bot_config.toml")) || !existsSync(join(root, "config", "model_config.toml"));
    if (needsInitialization) {
      await this.getPython().execute(command);
    }
  }

  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  install(version: string, onProgress?: Progress): Promise<ModuleUpdateResult> {
    if (this.paths.maibotDevMode === "source") throw new Error("源码调试模式不安装 PyPI 核心，请使用 bun run dev 测试安装版");
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
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async cleanupLegacySource(): Promise<void> {
    const deployment = this.getState();
    if (!deployment) return;
    const previousSource = deployment.previous?.mode === "source";
    const rootPath = this.paths.maibotRoot;
    const hasSourceEntry = existsSync(join(rootPath, "bot.py"));
    if (!previousSource && !hasSourceEntry && !existsSync(join(rootPath, "src"))) return;

    const root = await realpath(rootPath);
    if (dirname(root) === root) throw new Error(`MaiBot 实例目录不能是文件系统根目录：${root}`);
    const entries = new Map((await readdir(root, { withFileTypes: true })).map((entry) => [
      process.platform === "win32" ? entry.name.toLowerCase() : entry.name, entry,
    ]));
    for (const name of previousSource || hasSourceEntry ? LEGACY_SOURCE_ENTRIES : ["src"]) {
      const entry = entries.get(name);
      if (!entry) continue;
      const target = join(root, entry.name);
      if (entry.isSymbolicLink()) {
        await unlink(target);
        continue;
      }
      const recursive = entry.isDirectory();
      if (recursive && relative(target, await realpath(target))) throw new Error(`旧源码目录被重定向：${target}`);
      await rm(target, { recursive, force: true, maxRetries: 5, retryDelay: 200 });
    }
    if (previousSource) await this.save({ ...deployment, previous: undefined });
  }

  private async installIntoNewEnvironment(version: string, signal: AbortSignal, onProgress?: Progress): Promise<ModuleUpdateResult> {
    if (existsSync(this.pendingFile())) throw new Error("旧更新中断，请先启动 MaiBot 完成恢复，再更新程序包。");
    const before = this.getState();
    const generation = randomUUID();
    const root = this.paths.maibotRoot;
    const sourceInstance = !before && existsSync(join(root, "bot.py"));
    const environment = maiBotEnvironmentRoot(root, generation);
    const python = this.createEnvironment({ ...this.paths, pythonEnvRoot: environment });
    const output: string[] = [];
    let stage = "准备独立 Python 环境";
    let lastPercent = 0;
    const emit = (phase: MaiBotModuleUpdateProgress["phase"], percent: number, label: string, log?: string): void => {
      if (phase !== "failed") { stage = label; lastPercent = percent; }
      if (log) output.push(log);
      try { onProgress?.({ phase, percent, label, detail: log, log, updatedAt: Date.now() }); } catch { /* UI listeners cannot invalidate a committed installation. */ }
    };
    let deployment: MaiBotDeployment;
    try {
      emit("preparing", 5, sourceInstance ? "准备将源码实例迁移到 PyPI" : "准备独立 Python 环境",
        sourceInstance ? `安装 MaiBot ${version}，切换后删除旧源码和 Git 记录` : `MaiBot ${version}`);
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
        "from importlib.metadata import distribution",
        "from packaging.version import Version",
        "package=distribution('maibot')",
        "actual=package.version",
        "assert Version(actual)==Version(sys.argv[1]), f'Unexpected MaiBot version: {actual}'",
        "environment=pathlib.Path(sys.argv[2]).resolve()",
        "for name in ['src/cli/tool.py','src/runtime.py','src/_resources/EULA.md','src/_resources/PRIVACY.md','src/_resources/pyproject.toml']:",
        " path=pathlib.Path(package.locate_file(name)).resolve()",
        " assert path.is_relative_to(environment) and path.is_file(), f'Missing installed package file: {name}'",
        "print(json.dumps({'version':actual}))",
      ].join("\n"), version, environment], undefined, signal);
      const actual = (JSON.parse(probe.join("\n")) as { version: string }).version;
      const packages = await python.execute(["-I", "-m", "pip", "freeze", "--all"], undefined, signal);
      await writeFile(join(environment, "onekey-requirements.txt"), `${packages.join("\n")}\n`);
      signal.throwIfAborted();
      emit("switching", 95, "切换至已验证的环境");
      deployment = { schema: 1, mode: "pypi", generation, packageVersion: actual, sourceUrl: installed.sourceUrl, installedAt: Date.now() };
      await this.save(deployment);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let cleanupWarning: string | undefined;
      try {
        await this.cleanupFailedInstall(environment);
      } catch (cleanupError) {
        cleanupWarning = `未启用的新环境清理失败，原环境不受影响；残留文件不会用于启动。\n${String(cleanupError)}`;
      }
      const message = `${explainMaiBotUpdateError(detail, stage)}\n${before || sourceInstance ? "原运行环境未切换，可以继续使用。" : "新环境未启用，请处理后重新安装。"}`;
      output.push(detail);
      try { onProgress?.({ phase: "failed", percent: lastPercent, label: "MaiBot 更新失败", detail: message, errorDetails: detail, cleanupWarning, log: detail, updatedAt: Date.now() }); } catch { /* UI listener */ }
      throw new Error(`${message}\n\n技术详情：${detail}`, { cause: error });
    }

    try {
      await this.cleanupLegacySource();
    } catch (error) {
      const message = `MaiBot ${deployment.packageVersion} 已切换，旧源码清理失败：${String(error)}`;
      emit("failed", 98, "旧源码清理失败", message);
      throw new Error(message, { cause: error });
    }
    await this.cleanupUnusedGenerations("environments").catch((error) => emit("switching", 98, "旧环境清理未完成", String(error)));
    emit("completed", 100, "MaiBot 安装完成", `${before?.packageVersion ?? (sourceInstance ? "源码实例" : "未安装")} → ${deployment.packageVersion}`);
    return { moduleId: "maibot", moduleName: "MaiBot", cwd: root, before: before?.packageVersion,
      after: deployment.packageVersion, remote: deployment.sourceUrl, changed: true, output, updatedAt: Date.now(), source: "remote" };
  }

  private pendingFile(): string { return join(this.paths.maibotRoot, ".onekey", "pending.json"); }

  private async cleanupFailedInstall(environment: string): Promise<void> {
    // Windows may briefly retain executable handles after the installer exits.
    await rm(environment, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  async cleanupUnusedGenerations(kind: "environments" | "snapshots"): Promise<void> {
    if (this.paths.maibotDevMode === "source" || !existsSync(this.paths.maibotRoot)) return;
    const current = this.getState();
    if (kind === "environments" && !current) return;
    const hasPending = existsSync(this.pendingFile());
    const pending = hasPending
      ? (JSON.parse(await readFile(this.pendingFile(), "utf8")) as { generation: unknown }).generation
      : undefined;
    if (hasPending && !validGeneration(pending)) throw new Error("中断恢复记录无效，已保留旧备份。");
    const parent = join(await realpath(this.paths.maibotRoot), ".onekey", kind);
    if (!existsSync(parent)) return;
    const canonical = await realpath(parent);
    if (relative(parent, canonical)) throw new Error(`跳过被重定向的清理目录：${parent}`);
    const active = kind === "environments" ? current?.generation : undefined;
    const protectedNames = new Set([active?.toLowerCase(), typeof pending === "string" ? pending.toLowerCase() : undefined]);
    const failures: unknown[] = [];
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || protectedNames.has(entry.name) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(entry.name)) continue;
      const target = join(canonical, entry.name);
      // The UUID directory also identifies an interrupted snapshot copy without a manifest.
      if (kind === "snapshots" || existsSync(join(target, "maibot-python-env.json"))) {
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error) => failures.push(error));
      }
    }
    if (failures.length) throw new Error(failures.map(String).join("\n"));
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

  private async restoreSnapshot(generation: string): Promise<void> {
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
    } catch (error) {
      for (const index of swapped.reverse()) {
        await rm(targets[index].target, { recursive: true, force: true });
        if (existsSync(join(staging[index], "old"))) await rename(join(staging[index], "old"), targets[index].target);
      }
      throw error;
    }
    await Promise.all(staging.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
  }
}
