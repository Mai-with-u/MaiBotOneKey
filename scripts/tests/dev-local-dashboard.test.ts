import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InitManager } from "../../src/main/services/init-manager";
import { ServiceManager } from "../../src/main/services/service-manager";
import { defaultServiceStartupSettings, LOCAL_DASHBOARD_DEV_ENV, resolvePythonEnvironmentRoot } from "../../src/main/services/service-startup-defaults";
import { prepareDevPythonEnvironment } from "../dev/prepare-python-environment";
import type { RuntimePaths } from "../../src/shared/contracts";

test("legacy local Dashboard environment and packaged defaults remain compatible", () => {
  const root = join(tmpdir(), "maibot-workspace");
  const resources = join(tmpdir(), "maibot-resources");
  const devEnv = { [LOCAL_DASHBOARD_DEV_ENV]: "1" };
  expect(resolvePythonEnvironmentRoot(root, resources, false, devEnv)).toBe(join(root, ".cache", "dev-python-env"));
  expect(resolvePythonEnvironmentRoot(root, resources, false, {})).toBe(join(resources, "python-env"));
  expect(resolvePythonEnvironmentRoot(root, resources, true, devEnv)).toBe(join(resources, "python-env"));
});

test("test environment is seeded once and keeps installed dependencies after launch state is cleared", async () => {
  const root = await mkdtemp(join(tmpdir(), "maibot-dev-python-"));
  const source = join(root, "python-env");
  const target = join(root, ".cache", "dev-python-env");
  try {
    expect(await prepareDevPythonEnvironment(source, target)).toBe("initialize");
    await mkdir(join(source, "Lib", "site-packages"), { recursive: true });
    await writeFile(join(source, "python.exe"), "portable runtime");
    await writeFile(join(source, "Lib", "site-packages", "installed.txt"), "existing dependencies");
    expect(await prepareDevPythonEnvironment(source, target)).toBe("seeded");
    const installed = join(target, "Lib", "site-packages", "installed.txt");
    expect(await readFile(installed, "utf8")).toBe("existing dependencies");
    await writeFile(installed, "additional test dependencies");
    // Emulate removing application state and even the original environment.
    await rm(source, { recursive: true, force: true });
    expect(await prepareDevPythonEnvironment(source, target)).toBe("reused");
    expect(await readFile(installed, "utf8")).toBe("additional test dependencies");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev:dev starts checked despite saved false, allows manual changes and resets to local builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "maibot-dev-dashboard-"));
  const previous = process.env[LOCAL_DASHBOARD_DEV_ENV];
  const managers: ServiceManager[] = [];
  const paths = {
    installRoot: root, userDataRoot: join(root, "userData"), runtimeRoot: join(root, "runtime"),
    pythonEnvRoot: join(root, "python-env"), logsRoot: join(root, "logs"),
    maibotRoot: join(root, "MaiBot"), napcatRoot: join(root, "napcat"), snowlumaRoot: join(root, "SnowLuma"),
    bundledModulesRoot: join(root, "bundled"),
  } as RuntimePaths;
  const createManager = () => {
    const manager = new ServiceManager(paths, new InitManager(paths), { append() {}, getServiceLogPath: () => join(root, "test.log") } as any, Object.assign(new EventEmitter(), { list: () => [] }) as any);
    managers.push(manager);
    return manager;
  };
  try {
    await mkdir(paths.userDataRoot, { recursive: true });
    const settingsPath = join(paths.userDataRoot, "service-startup-settings.json");
    await writeFile(settingsPath, JSON.stringify({ version: 1, useLocalDashboard: false }));
    process.env[LOCAL_DASHBOARD_DEV_ENV] = "1";
    const dev = createManager();
    expect(dev.getStartupSettings().useLocalDashboard).toBe(true);
    await dev.saveStartupSettings({ useLocalDashboard: false });
    expect(dev.getStartupSettings().useLocalDashboard).toBe(false);
    await dev.saveStartupSettings(defaultServiceStartupSettings());
    expect(dev.getStartupSettings().useLocalDashboard).toBe(true);

    delete process.env[LOCAL_DASHBOARD_DEV_ENV];
    expect(defaultServiceStartupSettings().useLocalDashboard).toBe(false);
    await writeFile(settingsPath, JSON.stringify({ version: 1, useLocalDashboard: false }));
    expect(createManager().getStartupSettings().useLocalDashboard).toBe(false);
    process.env[LOCAL_DASHBOARD_DEV_ENV] = "0";
    await writeFile(settingsPath, JSON.stringify({ version: 1, useLocalDashboard: true }));
    expect(createManager().getStartupSettings().useLocalDashboard).toBe(false);
  } finally {
    for (const manager of managers) manager.dispose();
    if (previous === undefined) delete process.env[LOCAL_DASHBOARD_DEV_ENV];
    else process.env[LOCAL_DASHBOARD_DEV_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
