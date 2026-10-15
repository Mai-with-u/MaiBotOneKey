import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSourceCheckout, parseDevLaunchOptions } from "../dev/dev-launch-options";
import { DEV_MODE_ENV, DEV_SOURCE_ENV, LOCAL_DASHBOARD_DEV_ENV, developmentRuntimeProfile, resolvePythonEnvironmentRoot } from "../../src/main/services/service-startup-defaults";
import { activePythonEnvironmentRoot, isMaiBotPackageMode } from "../../src/main/services/maibot-deployment-state";
import type { RuntimePaths } from "../../src/shared/contracts";
import { EventEmitter } from "node:events";
import { InitManager } from "../../src/main/services/init-manager";
import { ServiceManager } from "../../src/main/services/service-manager";
import { PythonDependencyManager } from "../../src/main/services/python-dependency-manager";
import { ModuleUpdater } from "../../src/main/services/module-updater";

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
  const options = parseDevLaunchOptions(["--mode", "source", "--", "--source", "source with spaces", "--local-dashboard"], workspace);
  expect(options.mode).toBe("source"); expect(options.sourceRoot).toBe(join(workspace, "source with spaces")); expect(options.localDashboard).toBe(true);
  expect(() => parseDevLaunchOptions(["--source", "local"], workspace)).toThrow("源码模式");
  expect(() => parseDevLaunchOptions(["--mode", "other"], workspace)).toThrow("未知模式");
  expect(() => parseDevLaunchOptions(["--source"], workspace, "source")).toThrow("缺少参数");
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

test("local Dashboard startup fails clearly until its build exists", async () => {
  const root = await sourceFixture();
  const run = async () => {
    const child = Bun.spawn([process.execPath, resolve("scripts/dev/start-dev.ts"), "--mode", "source", "--source", root, "--local-dashboard", "--dry-run"], { stdout: "pipe", stderr: "pipe" });
    return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  };
  const missing = await run(); expect(missing[2]).toBe(1); expect(missing[1]).toContain("dev:build --source");
  await mkdir(join(root, "dashboard", "dist"), { recursive: true }); await writeFile(join(root, "dashboard", "dist", "index.html"), "local dashboard");
  const built = await run(); expect(built[2]).toBe(0); expect(built[0]).toContain("源码目录中的本地构建");
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
