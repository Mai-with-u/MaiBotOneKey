import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { componentDefaults, InstanceRegistry, readInstallerInstanceRoot } from "../../../src/main/services/instance-registry";
import { ResourceLocationManager } from "../../../src/main/services/resource-location-manager";
import type { RuntimePaths } from "../../../src/shared/contracts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), "maibot-instances-test-"))) throw new Error("Unexpected cleanup path"); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "maibot-instances-test-")); roots.push(root);
  const legacy = join(root, "appdata", "abcdef123456"), registry = new InstanceRegistry(join(root, "appdata", "launcher"));
  return { root, legacy, registry };
}
function store(root: string, file: string, value: unknown) { mkdirSync(root, { recursive: true }); writeFileSync(join(root, file), JSON.stringify(value)); }

test("legacy default and per-component paths remain in place; installer seed never overrides them", () => {
  const { root, legacy, registry } = fixture();
  const custom = join(root, "other-disk", "MaiBot");
  store(legacy, "resource-paths.json", { version: 1, paths: { maibot: custom } });
  store(legacy, "message-platform.json", { qq: "unchanged" });
  const original = readFileSync(join(legacy, "resource-paths.json"), "utf8");
  const state = registry.initialize(legacy, legacy, join(root, "new-install-choice"));
  expect(state.instances).toHaveLength(1);
  expect(state.instances[0].settingsRoot).toBe(legacy);
  expect(registry.snapshot().instances[0].paths).toEqual({ ...componentDefaults(legacy), maibot: custom });
  expect(readFileSync(join(legacy, "resource-paths.json"), "utf8")).toBe(original);
  expect(existsSync(join(root, "new-install-choice"))).toBe(false);
});
test("early resource-location format remains effective and repeated startup is idempotent", () => {
  const { root, legacy, registry } = fixture(), resourceRoot = join(root, "old-resource-root");
  store(legacy, "resource-location.json", { version: 1, resourceRoot });
  const first = registry.initialize(legacy, legacy);
  expect(registry.snapshot().instances[0].paths).toEqual(componentDefaults(resourceRoot));
  expect(registry.initialize(legacy, legacy).activeId).toBe(first.activeId);
  expect(registry.read().instances).toHaveLength(1);
});
test("fresh installation honors UTF-16 installer selection, separates settings and survives install path changes", () => {
  const { root, legacy, registry } = fixture(), chosen = join(root, "用户数据");
  const install = join(root, "program"); mkdirSync(install);
  writeFileSync(join(install, "instance-location.ini"), `\uFEFF[instance]\r\nroot=${chosen}\r\n`, "utf16le");
  expect(readInstallerInstanceRoot(install)).toBe(chosen);
  const first = registry.initialize(legacy, legacy, readInstallerInstanceRoot(install));
  expect(first.instances[0].paths).toEqual(componentDefaults(chosen));
  expect(first.instances[0].settingsRoot).not.toBe(chosen);
  mkdirSync(first.instances[0].paths.maibot, { recursive: true });
  const next = registry.initialize(join(root, "appdata", "123456abcdef"), join(root, "changed-default"), join(root, "ignored"), true);
  expect(next.activeId).toBe(first.activeId); expect(next.instances).toHaveLength(1);
});
test("fresh default resource root is not reimported as an extra legacy instance", () => {
  const { legacy, registry } = fixture();
  const first = registry.initialize(legacy, legacy);
  mkdirSync(first.instances[0].paths.maibot, { recursive: true });
  expect(registry.initialize(legacy, legacy, undefined, true).instances).toHaveLength(1);
});
test("independent component locations, settings isolation and selection persist across reload", () => {
  const { root, legacy, registry } = fixture(); registry.initialize(legacy, legacy);
  const paths = { maibot: join(root, "disk-a", "bot"), napcat: join(root, "disk-b", "qq"), snowluma: join(root, "disk-c", "protocol") };
  const state = registry.create({ name: "第二个实例", mode: "new", paths }, []), item = state.instances[1];
  expect(item.paths).toEqual({ ...state.instances[0].paths, maibot: paths.maibot });
  expect(item.settingsRoot).not.toBe(state.instances[0].settingsRoot);
  expect(existsSync(paths.maibot)).toBe(false);
  registry.select(item.id);
  expect(new InstanceRegistry(registry.root).read().activeId).toBe(item.id);
  expect(registry.rename(item.id, "测试机器人").instances[1].name).toBe("测试机器人");
});
test("duplicate, nested, relative and program-owned component paths are rejected", () => {
  const { root, legacy, registry } = fixture(); const initial = registry.initialize(legacy, legacy);
  const paths = componentDefaults(join(root, "second"));
  expect(() => registry.create({ name: "dup", mode: "new", paths: initial.instances[0].paths }, [])).toThrow("其他实例");
  expect(() => registry.create({ name: "nested", mode: "new", paths: { maibot: join(initial.instances[0].paths.napcat, "child") } }, [])).toThrow("互相包含");
  expect(() => registry.create({ name: "relative", mode: "new", paths: { ...paths, maibot: "relative" } }, [])).toThrow("绝对");
  expect(() => registry.create({ name: "program", mode: "new", paths }, [join(root, "second")])).toThrow("程序");
  expect(registry.read().instances).toHaveLength(1);
});
test("existing instances are attached without moving or deleting files; removal is metadata-only", () => {
  const { root, legacy, registry } = fixture(); registry.initialize(legacy, legacy);
  const paths = componentDefaults(join(root, "existing"));
  mkdirSync(join(paths.maibot, "src"), { recursive: true }); writeFileSync(join(paths.maibot, "bot.py"), "preserve me");
  expect(() => registry.create({ name: "wrong mode", mode: "new", paths }, [])).toThrow("空组件目录");
  const item = registry.create({ name: "已有实例", mode: "existing", paths }, []).instances[1];
  registry.remove(item.id);
  expect(readFileSync(join(paths.maibot, "bot.py"), "utf8")).toBe("preserve me");
  expect(() => registry.remove(registry.read().activeId)).toThrow("先切换");
});
test("removed legacy profiles are not automatically reimported", () => {
  const { root, legacy, registry } = fixture(); store(legacy, "service-commands.json", {});
  const first = registry.initialize(legacy, legacy);
  const second = registry.create({ name: "新实例", mode: "new", paths: componentDefaults(join(root, "new")) }, []).instances[1];
  registry.select(second.id); registry.remove(first.activeId);
  expect(registry.initialize(legacy, legacy, undefined, true).instances).toHaveLength(1);
  expect(existsSync(join(legacy, "service-commands.json"))).toBe(true);
});
test("corrupt legacy configuration stops migration without replacing it or creating an index", () => {
  const { legacy, registry } = fixture(); store(legacy, "resource-paths.json", { version: 1, paths: { maibot: "relative" } });
  expect(() => registry.initialize(legacy, legacy)).toThrow("绝对路径");
  expect(existsSync(join(registry.root, "instances.json"))).toBe(false);
});
test("component migration refuses a directory registered to a different instance", async () => {
  const { root, legacy, registry } = fixture(); const first = registry.initialize(legacy, legacy).instances[0];
  const second = registry.create({ name: "second", mode: "new", paths: componentDefaults(join(root, "second")) }, []).instances[1];
  const paths = { instanceRegistryRoot: registry.root, activeInstanceId: first.id, installRoot: join(root, "program"), userDataRoot: first.settingsRoot, defaultResourceRoot: first.resourceRoot, bundledModulesRoot: join(root, "program", "resources", "modules"), maibotRoot: first.paths.maibot, napcatRoot: first.paths.napcat, snowlumaRoot: first.paths.snowluma, defaultMaibotRoot: first.paths.maibot, defaultNapcatRoot: first.paths.napcat, defaultSnowlumaRoot: first.paths.snowluma } as RuntimePaths;
  const manager = new ResourceLocationManager(paths, false);
  await expect(manager.inspectPath("maibot", second.paths.maibot, "existing")).rejects.toThrow("其他实例");
});

test("a component path change persists only in its instance and survives switching away and back", async () => {
  const { root, legacy, registry } = fixture(); const first = registry.initialize(legacy, legacy).instances[0];
  const second = registry.create({ name: "second", mode: "new", paths: componentDefaults(join(root, "second")) }, []).instances[1];
  const target = join(root, "external", "MaiBot");
  mkdirSync(join(target, "src"), { recursive: true }); writeFileSync(join(target, "bot.py"), "entry");
  const paths = { instanceRegistryRoot: registry.root, activeInstanceId: first.id, installRoot: join(root, "program"), userDataRoot: first.settingsRoot, defaultResourceRoot: first.resourceRoot, bundledModulesRoot: join(root, "program", "resources", "modules"), maibotRoot: first.paths.maibot, napcatRoot: first.paths.napcat, snowlumaRoot: first.paths.snowluma, defaultMaibotRoot: first.paths.maibot, defaultNapcatRoot: first.paths.napcat, defaultSnowlumaRoot: first.paths.snowluma } as RuntimePaths;
  const manager = new ResourceLocationManager(paths, false);
  await manager.applyPlan(await manager.inspectPath("maibot", target, "existing"));
  registry.select(second.id); registry.select(first.id);
  const fresh = new InstanceRegistry(registry.root).snapshot();
  expect(fresh.instances[0].paths.maibot).toBe(target);
  expect(fresh.instances[1].paths).toEqual(second.paths);
  expect(existsSync(join(second.settingsRoot, "resource-paths.json"))).toBe(false);
});
