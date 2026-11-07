import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { RuntimePaths } from "../../src/shared/contracts";
import { MaiBotDeploymentManager } from "../../src/main/services/maibot-deployment-manager";
import { InitManager } from "../../src/main/services/init-manager";
import { ServiceManager } from "../../src/main/services/service-manager";
import { ModuleUpdater } from "../../src/main/services/module-updater";
import { activePythonEnvironmentRoot, deploymentFile, isMaiBotPackageMode, MAIBOT_BUNDLED_AGREEMENTS_VERSION, maiBotEnvironmentRoot, readMaiBotDeployment } from "../../src/main/services/maibot-deployment-state";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(source = false, failure?: "download" | "dependencies" | "probe") {
  const root = await mkdtemp(join(tmpdir(), "maibot-pypi-")); roots.push(root);
  const paths = { installRoot: root, maibotRoot: join(root, "实例 space"), pythonEnvRoot: join(root, "legacy-python"), userDataRoot: join(root, "settings"), defaultResourceRoot: root } as RuntimePaths;
  const instance = paths.maibotRoot;
  for (const name of ["config", "data", "plugins/example"]) await mkdir(join(instance, name), { recursive: true });
  await writeFile(join(instance, "config", "bot_config.toml"), "original config");
  await writeFile(join(instance, "data", "MaiBot.db"), "original data");
  await writeFile(join(instance, "plugins/example", "config.toml"), "original plugin");
  await writeFile(join(instance, "plugins/example", "requirements.txt"), "example==1.0");
  if (source) await writeFile(join(instance, "bot.py"), "old source");
  let installedVersion = "";
  const commands: string[][] = [];
  const manager = new MaiBotDeploymentManager(paths, undefined, (staged) => ({
    async ensurePythonEnvironment() {
      await mkdir(staged.pythonEnvRoot, { recursive: true });
      await writeFile(join(staged.pythonEnvRoot, "python.exe"), "test executable");
      await writeFile(join(staged.pythonEnvRoot, "maibot-python-env.json"), JSON.stringify({ version: 1 }));
      return [staged.pythonEnvRoot];
    },
    async installMaiBot(version, _onOutput, signal, _constraints, onPhase) {
      installedVersion = version;
      onPhase?.("core");
      signal?.throwIfAborted();
      if (failure === "download") throw new Error("download failed");
      onPhase?.("dependencies");
      if (failure === "dependencies") throw new Error("dependency resolution failed");
      return { sourceUrl: "https://pypi.org/simple", output: [] };
    },
    async execute(args, _onOutput, signal) {
      commands.push(args); signal?.throwIfAborted();
      expect(args[0]).toBe("-I");
      if (args.includes("-c")) {
        if (failure === "probe") throw new Error("wrong imported package");
        return [JSON.stringify({ version: installedVersion })];
      }
      return args.includes("freeze") ? ["maibot==" + installedVersion] : [];
    },
  }));
  return { paths, instance, manager, commands };
}

test("fresh instances use PyPI; source directories remain source until migration", async () => {
  const fresh = await fixture(); const source = await fixture(true);
  expect(isMaiBotPackageMode(fresh.paths)).toBe(true);
  expect(isMaiBotPackageMode(source.paths)).toBe(false);
  const manifest = JSON.parse(await readFile("resources/maibot-package/package.json", "utf8"));
  expect(manifest.agreements_version).toBe(MAIBOT_BUNDLED_AGREEMENTS_VERSION);
});

test("first installation selects the latest compatible stable package and later starts do not query or upgrade", async () => {
  const { manager, instance, commands } = await fixture();
  let queries = 0;
  manager.getPython = () => ({
    async execute(args: string[]) {
      commands.push(args);
      await mkdir(join(instance, "host"), { recursive: true });
      await writeFile(join(instance, "host", "registry.sqlite3"), "generated registry");
      return [];
    },
    async listMaiBotVersions() {
      queries++;
      return { versions: [
        { version: "2.0.0.dev1", isPrerelease: true, isDev: true },
        { version: "1.5.0rc1", isPrerelease: true, isDev: false },
        { version: "1.4.2", isPrerelease: false, isDev: false },
        { version: "1.3.8", isPrerelease: false, isDev: false },
      ] };
    },
  }) as any;
  const labels: string[] = [];
  await manager.ensureInstalled((progress) => labels.push(progress.label));
  expect(manager.getState()?.packageVersion).toBe("1.4.2");
  expect(labels).toContain("正在查询 MaiBot 最新正式版");
  expect(commands.some((args) => args.includes("host") && args.includes("list"))).toBe(true);
  expect(commands.some((args) => args.includes("init"))).toBe(false);
  await manager.ensureInstalled();
  expect(queries).toBe(1);
  expect(manager.getState()?.packageVersion).toBe("1.4.2");
});

for (const failure of ["offline", "prereleases-only", "empty"] as const) {
  test(`first installation with ${failure} never falls back to a fixed or prerelease version`, async () => {
    const { manager, instance, commands } = await fixture();
    manager.getPython = () => ({
      async listMaiBotVersions() {
        if (failure === "offline") throw new Error("index offline");
        return { versions: failure === "empty" ? [] : [{ version: "2.0.0rc1", isPrerelease: true, isDev: false }] };
      },
    }) as any;
    const phases: string[] = [];
    await expect(manager.ensureInstalled((progress) => phases.push(progress.phase))).rejects.toThrow(
      failure === "offline" ? "index offline" : "没有兼容的 MaiBot 正式版",
    );
    expect(phases).toEqual(["preparing", "failed"]);
    expect(commands).toEqual([]);
    expect(readMaiBotDeployment(instance)).toBeUndefined();
  });
}

test("existing source instances do not query or migrate automatically on startup", async () => {
  const { manager, commands } = await fixture(true);
  manager.getPython = () => { throw new Error("must not query"); };
  await manager.ensureInstalled();
  expect(commands).toEqual([]);
  expect(manager.getState()).toBeUndefined();
});

test("preparation reports distinct core and dependency installation stages before validation", async () => {
  const { manager } = await fixture();
  const phases: string[] = [];
  await manager.install("1.3.8", (progress) => { if (phases.at(-1) !== progress.phase) phases.push(progress.phase); });
  expect(phases).toEqual(["preparing", "installing", "installing-dependencies", "validating", "switching", "completed"]);
});

test("service commands use the selected Python environment and an isolated UTF-8 package entry", async () => {
  const { paths, instance, manager } = await fixture(true);
  Object.assign(paths, { runtimeRoot: join(paths.installRoot, "runtime"), bundledModulesRoot: join(paths.installRoot, "bundled"),
    logsRoot: join(paths.installRoot, "logs"), napcatRoot: join(paths.installRoot, "napcat"), snowlumaRoot: join(paths.installRoot, "snowluma") });
  await manager.install("1.3.8");
  const init = new InitManager(paths); init.setDeploymentManager(manager);
  const services = new ServiceManager(paths, init, { append() {}, getServiceLogPath: () => join(paths.logsRoot, "test.log") } as any,
    Object.assign(new EventEmitter(), { list: () => [] }) as any, manager.getPython());
  try {
    const command = (await services.getCommandConfigs()).find((item) => item.serviceId === "maibot")!;
    expect(command.defaultCommandLine).toContain(activePythonEnvironmentRoot(paths));
    expect(command.defaultCommandLine).toContain("-I -X utf8 -m src.cli.tool run --directory");
    expect(command.defaultCommandLine).not.toContain("bot.py");
    expect(command.defaultCwd).toBe(instance);
    const resource = join(manager.getPython().getPythonPackagesRoot(), "src", "_resources");
    await mkdir(resource, { recursive: true });
    for (const name of ["EULA.md", "PRIVACY.md"]) {
      await writeFile(join(resource, name), "installed agreement");
      await writeFile(join(instance, name), "old source agreement");
    }
    const agreements = await init.getAgreementState();
    expect(agreements.documents.every((document) => document.content === "installed agreement")).toBe(true);
  } finally { services.dispose(); }
});

test("migration commits a separate environment and rollback keeps current data and plugins", async () => {
  const { paths, instance, manager, commands } = await fixture(true);
  await manager.install("1.3.8");
  const state = readMaiBotDeployment(instance)!;
  expect(state.previous).toEqual({ mode: "source" });
  expect(activePythonEnvironmentRoot(paths)).toBe(maiBotEnvironmentRoot(instance, state.generation));
  expect(await readFile(join(instance, "bot.py"), "utf8")).toBe("old source");
  expect(await readFile(join(activePythonEnvironmentRoot(paths), "onekey-requirements.txt"), "utf8")).toContain("maibot==1.3.8");
  expect(commands.some((args) => args.includes("init"))).toBe(false);
  await writeFile(join(instance, "data", "MaiBot.db"), "migrated database");
  await writeFile(join(instance, "plugins/example", "config.toml"), "new plugin config");
  await manager.rollback();
  expect(isMaiBotPackageMode(paths)).toBe(false);
  expect(await readFile(join(instance, "data", "MaiBot.db"), "utf8")).toBe("migrated database");
  expect(await readFile(join(instance, "plugins/example", "config.toml"), "utf8")).toBe("new plugin config");
  expect(existsSync(join(instance, "config", "model_config.toml"))).toBe(false);
});

for (const ref of ["main", "dev", "feature/local-core", "detached"] as const) {
  for (const failure of [undefined, "probe"] as const) {
    test(`legacy ${ref} migration ${failure ? "failure" : "and rollback"} preserves Git and local source changes`, async () => {
      const { paths, instance, manager } = await fixture(true, failure);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: instance, encoding: "utf8", windowsHide: true }).trim();
      git("init", "--quiet", "--initial-branch=main");
      await writeFile(join(instance, ".gitignore"), ".onekey/\n.onekey-deployment.json\n");
      await mkdir(join(instance, "src"));
      await writeFile(join(instance, "src", "local.py"), "original code");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "original source");
      if (ref === "detached") git("checkout", "--quiet", "--detach");
      else if (ref !== "main") git("checkout", "--quiet", "-b", ref);
      await writeFile(join(instance, "bot.py"), "staged local change");
      git("add", "bot.py");
      await writeFile(join(instance, "src", "local.py"), "unstaged local change");
      await writeFile(join(instance, "untracked.py"), "untracked local code");
      const head = git("rev-parse", "HEAD");
      const branch = git("rev-parse", "--abbrev-ref", "HEAD");
      const index = await readFile(join(instance, ".git", "index"));
      const assertSource = async () => {
        expect(git("rev-parse", "HEAD")).toBe(head);
        expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
        expect(await readFile(join(instance, ".git", "index"))).toEqual(index);
        expect(await readFile(join(instance, "bot.py"), "utf8")).toBe("staged local change");
        expect(await readFile(join(instance, "src", "local.py"), "utf8")).toBe("unstaged local change");
        expect(await readFile(join(instance, "untracked.py"), "utf8")).toBe("untracked local code");
      };
      const updater = new ModuleUpdater(paths);
      updater.setDeploymentManager(manager);
      if (failure) {
        await expect(updater.updateMaiBot({ type: "package", name: "1.3.8" })).rejects.toThrow("wrong imported package");
      } else {
        await updater.updateMaiBot({ type: "package", name: "1.3.8" });
        expect(isMaiBotPackageMode(paths)).toBe(true);
        await assertSource();
        await updater.rollbackMaiBot();
      }
      expect(isMaiBotPackageMode(paths)).toBe(false);
      expect(activePythonEnvironmentRoot(paths)).toBe(paths.pythonEnvRoot);
      await assertSource();
      expect(await readFile(join(instance, "data", "MaiBot.db"), "utf8")).toBe("original data");
      expect(await readFile(join(instance, "config", "bot_config.toml"), "utf8")).toBe("original config");
      expect(await readFile(join(instance, "plugins/example", "config.toml"), "utf8")).toBe("original plugin");
    });
  }
}

test("old Git update targets cannot trigger installation or mutate source instances", async () => {
  const { paths, instance, manager, commands } = await fixture(true);
  const updater = new ModuleUpdater(paths);
  updater.setDeploymentManager(manager);
  for (const target of [undefined, { type: "branch", name: "dev" }, { type: "branch", name: "feature/local" }, { type: "tag", name: "v1.3.8" }]) {
    await expect(updater.updateMaiBot(target as any)).rejects.toThrow("停止支持 Git 升级");
  }
  expect(commands).toEqual([]);
  expect(readMaiBotDeployment(instance)).toBeUndefined();
  expect(await readFile(join(instance, "bot.py"), "utf8")).toBe("old source");
});

for (const failure of ["download", "dependencies", "probe"] as const) {
  test(`${failure} failure preserves the source deployment and original instance`, async () => {
    const { instance, manager } = await fixture(true, failure);
    await expect(manager.install("1.3.8")).rejects.toThrow();
    expect(readMaiBotDeployment(instance)).toBeUndefined();
    expect(await readFile(join(instance, "config", "bot_config.toml"), "utf8")).toBe("original config");
    expect(await readFile(join(instance, "data", "MaiBot.db"), "utf8")).toBe("original data");
    expect(existsSync(join(instance, "config", "model_config.toml"))).toBe(false);
  });
}

test("package updates retain a previous environment and use paths relative to a moved instance", async () => {
  const { paths, instance, manager } = await fixture();
  await manager.install("1.3.8");
  const old = manager.getState()!;
  await manager.install("1.3.9");
  expect(manager.getState()!.previous).toEqual({ mode: "pypi", generation: old.generation, packageVersion: "1.3.8" });
  const moved = join(paths.installRoot, "moved instance");
  await cp(instance, moved, { recursive: true });
  const movedPaths = { ...paths, maibotRoot: moved };
  expect(activePythonEnvironmentRoot(movedPaths)).toStartWith(moved);
  const restored = new MaiBotDeploymentManager(movedPaths);
  await restored.rollback();
  expect(restored.getState()!.packageVersion).toBe("1.3.8");
  expect(manager.getState()!.packageVersion).toBe("1.3.9");
});

test("failed environment cleanup cannot hide dependency errors or change the active deployment", async () => {
  const { instance, manager } = await fixture(false, "dependencies");
  const original = { schema: 1, mode: "pypi", generation: "existing", packageVersion: "1.3.9", sourceUrl: "https://pypi.org/simple", installedAt: Date.now() };
  await writeFile(deploymentFile(instance), JSON.stringify(original));
  (manager as any).cleanupFailedInstall = async () => {
    throw Object.assign(new Error("EPERM: unlink python.exe"), { code: "EPERM" });
  };
  const logs: string[] = [];
  await expect(manager.install("1.3.11", (progress) => {
    if (progress.log) logs.push(progress.log);
    if (progress.cleanupWarning) logs.push(progress.cleanupWarning);
  })).rejects.toThrow("dependency resolution failed");
  expect(logs.some((line) => line.includes("EPERM"))).toBe(true);
  expect(logs.some((line) => line.includes("dependency resolution failed"))).toBe(true);
  expect(readMaiBotDeployment(instance)).toEqual(original);
});

test("cancelled installs do not change the active environment, and UI errors cannot undo a commit", async () => {
  const { instance, manager } = await fixture();
  await expect(manager.install("1.3.8", (progress) => { if (progress.phase === "installing") manager.cancel(); })).rejects.toThrow();
  expect(readMaiBotDeployment(instance)).toBeUndefined();
  await manager.install("1.3.8", () => { throw new Error("window closed"); });
  expect(readMaiBotDeployment(instance)?.packageVersion).toBe("1.3.8");
});

test("corrupt or escaping deployment records never fall back silently", async () => {
  const { instance } = await fixture(true);
  for (const content of ["{bad", JSON.stringify({ schema: 1, mode: "pypi", generation: "../escape", packageVersion: "1.3.8" })]) {
    await writeFile(deploymentFile(instance), content);
    expect(() => readMaiBotDeployment(instance)).toThrow("部署记录无效");
  }
});

test("successful installs retain only the current and previous managed environments", async () => {
  const { instance, manager } = await fixture();
  await manager.install("1.3.8"); const first = manager.getState()!;
  await manager.install("1.3.9"); const second = manager.getState()!;
  await manager.install("1.3.10"); const third = manager.getState()!;
  expect(existsSync(maiBotEnvironmentRoot(instance, first.generation))).toBe(false);
  expect(existsSync(maiBotEnvironmentRoot(instance, second.generation))).toBe(true);
  expect(existsSync(maiBotEnvironmentRoot(instance, third.generation))).toBe(true);
  expect(existsSync(join(instance, ".onekey", "snapshots", first.generation))).toBe(false);
  await manager.rollback();
  expect(manager.getState()!.packageVersion).toBe("1.3.9");
});

test("startup recovers an interrupted legacy initializer from its snapshot", async () => {
  const { instance, manager } = await fixture();
  await manager.install("1.3.8");
  const current = manager.getState()!;
  const interrupted = "interrupted-install";
  const snapshot = join(instance, ".onekey", "snapshots", interrupted);
  await writeFile(join(instance, "config", "model_config.toml"), "original model");
  await mkdir(snapshot, { recursive: true });
  for (const name of ["config", "data", "plugins"]) await cp(join(instance, name), join(snapshot, name), { recursive: true });
  await writeFile(join(snapshot, "snapshot.json"), JSON.stringify({ present: ["config", "data", "plugins"] }));
  await writeFile(join(instance, "config", "bot_config.toml"), "interrupted config");
  await writeFile(join(instance, ".onekey", "pending.json"), JSON.stringify({ generation: interrupted }));
  await expect(manager.install("1.3.9")).rejects.toThrow("旧更新中断");
  expect(await readFile(join(instance, "config", "bot_config.toml"), "utf8")).toBe("interrupted config");
  await manager.ensureInstalled();
  expect(await readFile(join(instance, "config", "bot_config.toml"), "utf8")).toBe("original config");
  expect(manager.getState()!.generation).toBe(current.generation);
});


test("startup notice can be dismissed with missing documents and stays dismissed after document updates", async () => {
  const { paths, instance } = await fixture(true);
  paths.bundledModulesRoot = join(paths.installRoot, "bundled");
  const init = new InitManager(paths);
  expect((await init.getAgreementState()).isDismissed).toBe(false);
  expect((await init.dismissAgreements()).state.isDismissed).toBe(true);
  const record = JSON.parse(await readFile(join(paths.userDataRoot, "agreement.json"), "utf8"));
  expect(record.dismissedAt).toBeNumber();
  expect(record.confirmedAt).toBeUndefined();
  expect(record.hashes).toBeUndefined();
  await writeFile(join(instance, "EULA.md"), "updated notice");
  expect((await new InitManager(paths).getAgreementState()).isDismissed).toBe(true);
  await writeFile(join(paths.userDataRoot, "agreement.json"), JSON.stringify({ version: 1, hashes: { eula: "old" } }));
  expect((await new InitManager(paths).getAgreementState()).isDismissed).toBe(true);
});


test("1.4 workspace updates and rollbacks keep public settings and local and external Bot data", async () => {
  const { manager, instance, commands } = await fixture(true);
  const external = await mkdtemp(join(tmpdir(), "maibot-external-")); roots.push(external);
  for (const directory of [join(instance, "host"), join(instance, "bots", "b", "data"), join(external, "data")]) await mkdir(directory, { recursive: true });
  await writeFile(join(instance, "host", "config.toml"), "public settings");
  await writeFile(join(instance, "bots", "b", "data", "message.txt"), "Bot B original");
  await writeFile(join(external, "data", "message.txt"), "external original");
  execFileSync("python", ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('CREATE TABLE bots(bot_id TEXT, name TEXT, directory TEXT, created_at TEXT)'); db.execute('INSERT INTO bots VALUES(?,?,?,?)', ('external', 'External', sys.argv[2], 'now')); db.execute('INSERT INTO bots VALUES(?,?,?,?)', ('b', 'B', 'bots/b', 'now')); db.commit(); db.close()", join(instance, "host", "registry.sqlite3"), external]);
  manager.getPython = () => ({ getPythonPath: () => "python" }) as any;
  await manager.install("1.4.0");
  expect(commands.some((args) => args.includes("init"))).toBe(false);
  expect(existsSync(join(instance, ".onekey", "snapshots"))).toBe(false);
  await writeFile(join(instance, "host", "config.toml"), "changed public");
  await writeFile(join(instance, "bots", "b", "data", "message.txt"), "changed B");
  await writeFile(join(external, "data", "message.txt"), "changed external");
  await manager.rollback();
  expect(await readFile(join(instance, "host", "config.toml"), "utf8")).toBe("changed public");
  expect(await readFile(join(instance, "bots", "b", "data", "message.txt"), "utf8")).toBe("changed B");
  expect(await readFile(join(external, "data", "message.txt"), "utf8")).toBe("changed external");
});

test("package update completes without running MaiBot or initializing its workspace", async () => {
  const { manager, instance, commands } = await fixture();
  await manager.install("1.4.0");
  const before = manager.getState()!;
  const phases: string[] = [];
  await manager.install("1.4.1", (progress) => phases.push(progress.phase));
  expect(phases.at(-1)).toBe("completed");
  expect(manager.getState()?.previous).toMatchObject({ generation: before.generation });
  expect(manager.getState()?.packageVersion).toBe("1.4.1");
  expect(commands.every((args) => !args.some((arg) => ["init", "host", "run", "src.cli.tool"].includes(arg)))).toBe(true);
  expect(existsSync(join(instance, "host"))).toBe(false);
  expect(existsSync(join(instance, ".onekey", "snapshots"))).toBe(false);
  expect(await readFile(join(instance, "data", "MaiBot.db"), "utf8")).toBe("original data");

  manager.getPython = () => ({
    async execute(args: string[]) {
      expect(args).toContain("host");
      throw new Error("workspace initialization failed");
    },
  }) as any;
  await expect(manager.ensureInstalled()).rejects.toThrow("workspace initialization failed");
  expect(manager.getState()?.packageVersion).toBe("1.4.1");
});

test("startup cleanup removes abandoned and incomplete snapshots while preserving referenced and unrelated directories", async () => {
  const { manager, instance } = await fixture(true);
  await manager.install("1.4.0");
  const root = join(instance, ".onekey", "snapshots");
  const active = randomUUID();
  const abandoned = randomUUID();
  const incomplete = randomUUID();
  for (const name of [active, abandoned, incomplete, "unmanaged"]) await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, abandoned, "snapshot.json"), JSON.stringify({ present: [] }));
  await writeFile(join(root, incomplete, "partial-copy"), "unfinished");
  await writeFile(deploymentFile(instance), JSON.stringify({ ...manager.getState(), snapshot: active }));

  const pending = join(instance, ".onekey", "pending.json");
  await writeFile(pending, JSON.stringify({ generation: abandoned }));
  await manager.cleanupUnusedGenerations("snapshots");
  expect(existsSync(join(root, abandoned))).toBe(true);
  expect(existsSync(join(root, incomplete))).toBe(false);

  await rm(pending);
  await manager.cleanupUnusedGenerations("snapshots");
  expect(existsSync(join(root, active))).toBe(true);
  expect(existsSync(join(root, abandoned))).toBe(false);
  expect(existsSync(join(root, incomplete))).toBe(false);
  expect(existsSync(join(root, "unmanaged"))).toBe(true);
});

test("startup cleanup does not follow a redirected snapshot directory", async () => {
  const { manager, instance } = await fixture();
  await manager.install("1.4.0");
  const external = await mkdtemp(join(tmpdir(), "maibot-backup-target-"));
  roots.push(external);
  const backup = join(external, randomUUID());
  await mkdir(backup);
  await symlink(external, join(instance, ".onekey", "snapshots"), process.platform === "win32" ? "junction" : "dir");
  await expect(manager.cleanupUnusedGenerations("snapshots")).rejects.toThrow("重定向");
  expect(existsSync(backup)).toBe(true);
});
