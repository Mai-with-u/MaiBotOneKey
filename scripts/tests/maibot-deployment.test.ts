import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
async function fixture(source = false, failure?: "download" | "dependencies" | "init" | "probe") {
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
    async installMaiBot(version, requirements, _onOutput, signal, _constraints, onPhase) {
      installedVersion = version;
      onPhase?.("core");
      expect(requirements).toContain(join(instance, "plugins/example", "requirements.txt"));
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
      if (args.includes("init")) {
        if (failure === "init") {
          await writeFile(join(instance, "config", "bot_config.toml"), "partial init");
          await writeFile(join(instance, "config", "model_config.toml"), "partial model");
          throw new Error("init failed");
        }
        await writeFile(join(instance, "config", "model_config.toml"), "generated model");
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
  const { manager } = await fixture();
  let queries = 0;
  manager.getPython = () => ({
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

test("migration commits a separate environment and rollback restores data and full plugin state", async () => {
  const { paths, instance, manager, commands } = await fixture(true);
  await manager.install("1.3.8");
  const state = readMaiBotDeployment(instance)!;
  expect(state.previous).toEqual({ mode: "source" });
  expect(activePythonEnvironmentRoot(paths)).toBe(maiBotEnvironmentRoot(instance, state.generation));
  expect(await readFile(join(instance, "bot.py"), "utf8")).toBe("old source");
  expect(await readFile(join(activePythonEnvironmentRoot(paths), "onekey-requirements.txt"), "utf8")).toContain("maibot==1.3.8");
  expect(commands.some((args) => args.includes("init") && args.includes(instance))).toBe(true);
  await writeFile(join(instance, "data", "MaiBot.db"), "migrated database");
  await writeFile(join(instance, "plugins/example", "config.toml"), "new plugin config");
  await manager.rollback();
  expect(isMaiBotPackageMode(paths)).toBe(false);
  expect(await readFile(join(instance, "data", "MaiBot.db"), "utf8")).toBe("original data");
  expect(await readFile(join(instance, "plugins/example", "config.toml"), "utf8")).toBe("original plugin");
  expect(existsSync(join(instance, "config", "model_config.toml"))).toBe(false);
});

for (const ref of ["main", "dev", "feature/local-core", "detached"] as const) {
  for (const failure of [undefined, "init"] as const) {
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
        await expect(updater.updateMaiBot({ type: "package", name: "1.3.8" })).rejects.toThrow("init failed");
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

for (const failure of ["download", "dependencies", "probe", "init"] as const) {
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

test("an interrupted initializer is recovered from its snapshot before the next install", async () => {
  const { instance, manager } = await fixture();
  await manager.install("1.3.8");
  const current = manager.getState()!;
  const interrupted = "interrupted-install";
  const snapshot = join(instance, ".onekey", "snapshots", interrupted);
  await mkdir(snapshot, { recursive: true });
  for (const name of ["config", "data", "plugins"]) await cp(join(instance, name), join(snapshot, name), { recursive: true });
  await writeFile(join(snapshot, "snapshot.json"), JSON.stringify({ present: ["config", "data", "plugins"] }));
  await writeFile(join(instance, "config", "bot_config.toml"), "interrupted config");
  await writeFile(join(instance, ".onekey", "pending.json"), JSON.stringify({ generation: interrupted }));
  await manager.ensureInstalled();
  expect(await readFile(join(instance, "config", "bot_config.toml"), "utf8")).toBe("original config");
  expect(manager.getState()!.generation).toBe(current.generation);
});
