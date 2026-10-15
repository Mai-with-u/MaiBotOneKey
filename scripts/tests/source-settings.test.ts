import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceSettingsManager } from "../../src/main/services/source-settings-manager";
import { PythonDependencyManager } from "../../src/main/services/python-dependency-manager";
import type { RuntimePaths } from "../../src/shared/contracts";
const roots: string[] = [];

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "maibot-source-")); roots.push(root);
  return { path: join(root, "source-settings.json"), manager: new SourceSettingsManager({ userDataRoot: root } as RuntimePaths) };
}

test("Python sources retain saved order, custom URLs and trusted hosts across restarts", async () => {
  const { path, manager } = await fixture();
  const python = [
    { id: "custom", label: "Custom", url: "https://packages.example/simple", trustedHost: "packages.example", builtIn: false },
    { id: "pypi", label: "PyPI", url: "https://pypi.org/simple", trustedHost: undefined, builtIn: true },
  ];
  expect(await manager.saveSettings({ python })).toEqual({ python });
  const restored = new SourceSettingsManager({ userDataRoot: join(path, "..") } as RuntimePaths);
  expect(restored.getPythonSources()).toEqual(python);
});

test("legacy unified settings retain Python sources and discard inactive source groups on save", async () => {
  const { path, manager } = await fixture();
  const python = [{ id: "private", label: "Private", url: "https://private.example/simple", trustedHost: "private.example", builtIn: false }];
  await writeFile(path, JSON.stringify({ version: 1, github: [{ id: "old-git", url: "https://old.example" }], launcher: [], python }));
  expect(manager.getSettings()).toEqual({ python });
  await manager.saveSettings(manager.getSettings());
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.python).toEqual(python);
  expect(saved).not.toHaveProperty("github");
  expect(saved).not.toHaveProperty("launcher");
});

test("reset and legacy settings without Python sources use only default Python indexes", async () => {
  const { path, manager } = await fixture();
  await writeFile(path, JSON.stringify({ github: [], launcher: [] }));
  expect(manager.getPythonSources().map((item) => item.id)).toEqual(["tuna", "aliyun", "pypi"]);
  await manager.saveSettings({ python: [{ id: "custom", label: "Custom", url: "https://custom.example/simple" }] });
  const defaults = await manager.resetSettings();
  expect(Object.keys(defaults)).toEqual(["python"]);
  expect(defaults.python.map((item) => item.id)).toEqual(["tuna", "aliyun", "pypi"]);
});

test("source list order overrides a legacy standalone PyPI preference", async () => {
  const { path, manager } = await fixture();
  const root = join(path, "..");
  await writeFile(join(root, "python-dependency-source.json"), JSON.stringify({ version: 1, preset: "pypi" }));
  const paths = { userDataRoot: root, maibotRoot: join(root, "instance"), pythonEnvRoot: join(root, "python"),
    runtimeRoot: join(root, "runtime"), installRoot: root } as RuntimePaths;
  const python = new PythonDependencyManager(paths, manager);
  expect(python.getState().sourcePreset).toBe("tuna");
  expect(python.getState().sourceUrl).toBe("https://pypi.tuna.tsinghua.edu.cn/simple");
  expect(python.getState().sourceOptions.map((source) => source.preset)).toEqual(["tuna", "aliyun", "pypi"]);
  const sources = manager.getPythonSources();
  await manager.saveSettings({ python: [sources[1], sources[0], sources[2]] });
  expect(python.getState().sourcePreset).toBe("aliyun");
  expect(python.getState().sourceOptions.map((source) => source.preset)).toEqual(["aliyun", "tuna", "pypi"]);
});

test("wizard source selection reorders the same list and settings reordering takes effect immediately", async () => {
  const { path, manager } = await fixture();
  const root = join(path, "..");
  const paths = { userDataRoot: root, maibotRoot: join(root, "instance"), pythonEnvRoot: join(root, "python"),
    runtimeRoot: join(root, "runtime"), installRoot: root } as RuntimePaths;
  const python = new PythonDependencyManager(paths, manager);
  await python.saveSourcePreset("pypi");
  expect(manager.getPythonSources().map((source) => source.id)).toEqual(["pypi", "tuna", "aliyun"]);
  expect(python.getState().sourcePreset).toBe("pypi");
  const sources = manager.getPythonSources();
  await manager.saveSettings({ python: [sources[1], sources[0], sources[2]] });
  const restored = new PythonDependencyManager(paths, new SourceSettingsManager(paths));
  expect(restored.getState().sourceOptions.map((source) => source.preset)).toEqual(["tuna", "pypi", "aliyun"]);
  expect(restored.getSourcePreset()).toBe("tuna");
});
