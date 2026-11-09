import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSourceCheckout, parseDevLaunchOptions } from "../../dev/dev-launch-options";
import { updateMaiBotSource } from "../../dev/init-maibot-source";
import { DEV_MODE_ENV, DEV_SOURCE_ENV, LOCAL_DASHBOARD_DEV_ENV, developmentRuntimeProfile, resolvePythonEnvironmentRoot } from "../../../src/main/services/service-startup-defaults";
import { activePythonEnvironmentRoot, isMaiBotPackageMode } from "../../../src/main/services/maibot-deployment-state";
import type { RuntimePaths } from "../../../src/shared/contracts";
import { EventEmitter } from "node:events";
import { InitManager } from "../../../src/main/services/init-manager";
import { ServiceManager } from "../../../src/main/services/service-manager";
import { PythonDependencyManager } from "../../../src/main/services/python-dependency-manager";
import { ModuleUpdater } from "../../../src/main/services/module-updater";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "maibot-source-")); roots.push(root);
  await mkdir(join(root, "src")); await writeFile(join(root, "bot.py"), "source entry"); await writeFile(join(root, "pyproject.toml"), '[project]\nname="MaiBot"\nversion="1.3.8"\n');
  return root;
}

test("development variants select explicit modes and preserve source paths with spaces", () => {
  const workspace = resolve("workspace");
  expect(parseDevLaunchOptions([], workspace).mode).toBe("pypi");
  const options = parseDevLaunchOptions(["--mode", "source", "--", "--source", "source with spaces"], workspace);
  expect(options.mode).toBe("source"); expect(options.sourceRoot).toBe(join(workspace, "source with spaces")); expect(options.localDashboard).toBe(true);
  expect(() => parseDevLaunchOptions(["--source", "local"], workspace)).toThrow("源码模式");
  expect(() => parseDevLaunchOptions(["--mode", "other"], workspace)).toThrow("未知模式");
  expect(() => parseDevLaunchOptions(["--source"], workspace, "source")).toThrow("缺少参数");
  expect(parseDevLaunchOptions(["--resume", "run-PThaum"], workspace, "source").resume).toBe("run-PThaum");
  expect(() => parseDevLaunchOptions(["--resume", "../run-PThaum"], workspace, "source")).toThrow("测试目录名");
  expect(() => parseDevLaunchOptions(["--fresh"], workspace, "source")).toThrow("未知开发参数");
  expect(() => parseDevLaunchOptions(["--resume", "run-PThaum", "--source", "local"], workspace, "source")).toThrow("不能混用");
  expect(parseDevLaunchOptions(["--update"], workspace, "source").update).toBe(true);
  expect(() => parseDevLaunchOptions(["--update"], workspace)).toThrow("源码模式");
});

test("source update fast-forwards dev and preserves local changes and branches", async () => {
  const remote = await sourceFixture();
  const checkout = await mkdtemp(join(tmpdir(), "maibot-update-checkout-"));
  roots.push(checkout);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args,
  ], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(remote, "init", "--quiet", "--initial-branch=dev");
  git(remote, "add", "bot.py");
  git(remote, "commit", "--quiet", "-m", "initial");
  git(remote, "clone", "--quiet", remote, checkout);
  await writeFile(join(remote, "bot.py"), "new upstream source");
  git(remote, "commit", "--quiet", "-am", "update");
  await updateMaiBotSource(resolve("."), checkout, true);
  expect(await readFile(join(checkout, "bot.py"), "utf8")).toBe("source entry");
  await updateMaiBotSource(resolve("."), checkout, false);
  expect(await readFile(join(checkout, "bot.py"), "utf8")).toBe("new upstream source");
  await writeFile(join(checkout, "bot.py"), "local edits");
  await expect(updateMaiBotSource(resolve("."), checkout, false)).rejects.toThrow("未提交");
  expect(await readFile(join(checkout, "bot.py"), "utf8")).toBe("local edits");
  git(checkout, "switch", "--quiet", "-c", "local");
  await expect(updateMaiBotSource(resolve("."), checkout, false)).rejects.toThrow("切换到 dev");
});

test("source profiles isolate settings, protocol files and Python environments per checkout", () => {
  const workspace = resolve("workspace"); const source = resolve("source-checkout");
  const env = { [DEV_MODE_ENV]: "source", [DEV_SOURCE_ENV]: source };
  const profile = developmentRuntimeProfile(workspace, false, env);
  expect(profile.sourceRoot).toBe(source); expect(profile.settingsSuffix).toStartWith("-source-");
  expect(resolvePythonEnvironmentRoot(workspace, workspace, false, env)).toBe(join(profile.resourceRoot!, "python-env"));
  expect(developmentRuntimeProfile(workspace, false, { ...env, [LOCAL_DASHBOARD_DEV_ENV]: "1" })).toEqual(profile);
  expect(developmentRuntimeProfile(workspace, false, { ...env, [DEV_SOURCE_ENV]: resolve("other-checkout") }).resourceRoot).not.toBe(profile.resourceRoot);
  expect(developmentRuntimeProfile(workspace, false, { [DEV_MODE_ENV]: "pypi" })).toEqual({ mode: "pypi", settingsSuffix: "" });
  expect(developmentRuntimeProfile(workspace, true, env)).toEqual({ settingsSuffix: "" });
});

test("explicit modes take precedence over old source markers and package environment selection", async () => {
  const root = await sourceFixture();
  const paths = { maibotRoot: root, pythonEnvRoot: join(root, "source-python") } as RuntimePaths;
  expect(isMaiBotPackageMode(paths)).toBe(false);
  expect(isMaiBotPackageMode({ ...paths, maibotDevMode: "pypi" })).toBe(true);
  expect(isMaiBotPackageMode({ ...paths, maibotDevMode: "source" })).toBe(false);
  await writeFile(join(root, ".onekey-deployment.json"), "{invalid package state}");
  expect(activePythonEnvironmentRoot({ ...paths, maibotDevMode: "source" })).toBe(paths.pythonEnvRoot);
  expect(() => assertSourceCheckout(root)).toThrow("独立的 MaiBot 源码");
});

test("source launcher validates a checkout and dry-runs without opening Electron", async () => {
  const root = await sourceFixture();
  expect(assertSourceCheckout(root)).toBe(root);
  const child = Bun.spawn([process.execPath, resolve("scripts/dev/start-dev.ts"), "--mode", "source", "--source", root, "--dry-run"], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(error).toBe(""); expect(output).toContain("本地源码"); expect(output).toContain(root); expect(output).toContain("dev-source");
});

test("local Dashboard startup plans a build only when needed", async () => {
  const root = await sourceFixture();
  const run = async () => {
    const child = Bun.spawn([process.execPath, resolve("scripts/dev/start-dev.ts"), "--mode", "source", "--source", root, "--dry-run"], { stdout: "pipe", stderr: "pipe" });
    return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  };
  const missing = await run(); expect(missing[2]).toBe(0); expect(missing[0]).toContain("构建本地 MaiBot Dashboard");
  await mkdir(join(root, "dashboard", "dist"), { recursive: true }); await writeFile(join(root, "dashboard", "dist", "index.html"), "local dashboard");
  const built = await run(); expect(built[2]).toBe(0); expect(built[0]).toContain("源码目录中的本地构建");
  expect(built[0]).not.toContain("构建本地 MaiBot Dashboard");
});

test("source and PyPI variants generate different core entry commands", async () => {
  const root = await sourceFixture();
  for (const mode of ["source", "pypi"] as const) {
    const paths = { maibotDevMode: mode, installRoot: root, maibotRoot: root, pythonEnvRoot: join(root, mode, "python-env"),
      userDataRoot: join(root, mode, "settings"), defaultResourceRoot: join(root, mode), runtimeRoot: join(root, "runtime"),
      bundledModulesRoot: join(root, "bundled"), logsRoot: join(root, mode, "logs"), napcatRoot: join(root, mode, "napcat"), snowlumaRoot: join(root, mode, "snowluma") } as RuntimePaths;
    await mkdir(paths.pythonEnvRoot, { recursive: true }); await writeFile(join(paths.pythonEnvRoot, "python.exe"), "test interpreter");
    const init = new InitManager(paths);
    const services = new ServiceManager(paths, init, { append() {}, getServiceLogPath: () => join(paths.logsRoot, "test.log") } as any,
      Object.assign(new EventEmitter(), { list: () => [] }) as any, new PythonDependencyManager(paths));
    try {
      const command = (await services.getCommandConfigs()).find((entry) => entry.serviceId === "maibot")!.defaultCommandLine;
      if (mode === "source") {
        expect(command).toContain("bot.py"); expect(command).not.toContain("src.cli.tool");
        await expect(new ModuleUpdater(paths).updateMaiBot({ type: "package", name: "1.3.8" })).rejects.toThrow("源码仓库");
      } else { expect(command).toContain("-I -X utf8 -m src.cli.tool"); expect(command).not.toContain("bot.py"); }
    } finally { services.dispose(); }
  }
});
