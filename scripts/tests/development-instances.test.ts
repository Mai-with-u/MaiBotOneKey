import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { configureDevelopmentInstances } from "../../src/main/services/development-instances";
import { DEV_MODE_ENV, DEV_SOURCE_ENV, LOCAL_DASHBOARD_DEV_ENV } from "../../src/main/services/service-startup-defaults";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), "onekey-dev-instances-"))) throw new Error("Unexpected cleanup path"); rmSync(root, { recursive: true, force: true }); } });
function fixture() { const root = mkdtempSync(join(tmpdir(), "onekey-dev-instances-")); roots.push(root); return { root, workspace: join(root, "workspace"), appdata: join(root, "appdata") }; }
function source(root: string) { mkdirSync(join(root, "src"), { recursive: true }); writeFileSync(join(root, "bot.py"), ""); writeFileSync(join(root, "pyproject.toml"), ""); }

test("ordinary development registers both defaults and preserves old settings and component overrides", () => {
  const { workspace, appdata, root } = fixture();
  const oldSettings = join(appdata, "MaiBotOneKeyDesktop", createHash("sha256").update(workspace).digest("hex").slice(0, 12));
  mkdirSync(oldSettings, { recursive: true });
  writeFileSync(join(oldSettings, "resource-paths.json"), JSON.stringify({ version: 1, paths: { napcat: join(root, "custom-qq") } }));
  const { registry, active } = configureDevelopmentInstances(workspace, appdata, { [DEV_MODE_ENV]: "pypi" });
  expect(registry.read().instances.map(item => item.name)).toEqual(["默认 PyPI 实例", "源码调试实例"]);
  expect(active.paths.maibot).toBe(join(workspace, "modules", "MaiBot"));
  const debug = registry.read().instances[1];
  expect(debug.paths.maibot).toBe(join(workspace, "modules", "MaiBot-source"));
  expect(debug.settingsRoot).not.toBe(active.settingsRoot);
  expect(debug.development!.pythonRoot).not.toBe(active.development!.pythonRoot);
  mkdirSync(active.settingsRoot, { recursive: true });
  writeFileSync(join(active.settingsRoot, "resource-paths.json"), JSON.stringify({ version: 1, paths: { napcat: join(root, "custom-qq") } }));
  configureDevelopmentInstances(workspace, appdata, { [DEV_MODE_ENV]: "pypi" });
  expect(registry.snapshot().instances[0].paths.napcat).toBe(join(root, "custom-qq"));
  expect(registry.read().instances).toHaveLength(2);
});

test("UI switching survives relaunch while explicit source startup keeps its Dashboard selection", () => {
  const { workspace, appdata } = fixture();
  const env = { [DEV_MODE_ENV]: "pypi" };
  const { registry } = configureDevelopmentInstances(workspace, appdata, env);
  const debug = registry.read().instances[1]; source(debug.paths.maibot);
  registry.select(debug.id);
  expect(configureDevelopmentInstances(workspace, appdata, env, true).active.development!.mode).toBe("source");
  expect(configureDevelopmentInstances(workspace, appdata, env).active.id).toBe("dev-pypi");
  const local = { [DEV_MODE_ENV]: "source", [LOCAL_DASHBOARD_DEV_ENV]: "1" };
  expect(configureDevelopmentInstances(workspace, appdata, local).active.development!.localDashboard).toBe(true);
  registry.select("dev-pypi");
  expect(configureDevelopmentInstances(workspace, appdata, local, true).active.development!.mode).toBe("pypi");
  expect(registry.read().instances[1].development!.localDashboard).toBe(true);
});

test("unprepared source selection does not change active instance; custom checkouts get independent records", () => {
  const { workspace, appdata, root } = fixture();
  const { registry } = configureDevelopmentInstances(workspace, appdata, {});
  expect(() => registry.select(registry.read().instances[1].id)).toThrow("dev:source:init");
  expect(registry.read().activeId).toBe("dev-pypi");
  const custom = configureDevelopmentInstances(workspace, appdata, { [DEV_MODE_ENV]: "source", [DEV_SOURCE_ENV]: join(root, "another-checkout") });
  expect(custom.registry.read().instances).toHaveLength(3);
  expect(custom.active.paths.maibot).toBe(join(root, "another-checkout"));
  expect(() => registry.remove("dev-pypi")).toThrow("不能移除");
});
