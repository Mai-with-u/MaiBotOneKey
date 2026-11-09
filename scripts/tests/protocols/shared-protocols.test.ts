import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { InitManager } from "../../../src/main/services/init-manager";
import { ServiceManager } from "../../../src/main/services/service-manager";
import { InstanceRegistry, componentDefaults } from "../../../src/main/services/instance-registry";
import { readSharedProtocols } from "../../../src/main/services/shared-protocols";
import { ResourceLocationManager } from "../../../src/main/services/resource-location-manager";
import { ProtocolBackendManager } from "../../../src/main/services/protocol-backend-manager";
import type { LauncherInstance, RuntimePaths } from "../../../src/shared/contracts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), "onekey-shared-protocols-"))) throw new Error("Unexpected cleanup target"); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "onekey-shared-protocols-")); roots.push(root);
  const registry = new InstanceRegistry(join(root, "launcher"));
  const legacy = join(root, "legacy"); mkdirSync(legacy);
  writeFileSync(join(legacy, "qq-backend.json"), JSON.stringify({ backend: "snowluma" }));
  writeFileSync(join(legacy, "message-platform.json"), JSON.stringify({ version: 1, accounts: { snowluma: "12345678" } }));
  const first = registry.initialize(legacy, legacy).instances[0];
  const second = registry.create({ name: "second", mode: "new", paths: { maibot: join(root, "second-maibot") } }, []).instances[1];
  const runtime = (item: LauncherInstance): RuntimePaths => {
    const shared = readSharedProtocols(registry.root)!;
    const paths = registry.effective(item);
    return { instanceRegistryRoot: registry.root, activeInstanceId: item.id, installRoot: join(root, "program"), userDataRoot: item.settingsRoot, protocolSettingsRoot: shared.settingsRoot, defaultResourceRoot: item.resourceRoot, resourceRoot: item.resourceRoot, modulesRoot: join(item.resourceRoot, "modules"), bundledModulesRoot: join(root, "templates"), runtimeRoot: join(root, "runtime"), pythonEnvRoot: join(item.resourceRoot, "python-env"), logsRoot: join(item.settingsRoot, "logs"), maibotRoot: paths.maibot, napcatRoot: paths.napcat, snowlumaRoot: paths.snowluma, defaultMaibotRoot: item.paths.maibot, defaultNapcatRoot: shared.defaults.napcat, defaultSnowlumaRoot: shared.defaults.snowluma };
  };
  return { root, registry, legacy, first, second, runtime };
}

test("MaiBot instances share protocol paths and account/backend settings without storing per-instance bindings", async () => {
  const { registry, legacy, first, second, runtime } = fixture();
  const a = new ProtocolBackendManager(runtime(first)), b = new ProtocolBackendManager(runtime(second));
  expect(runtime(first).napcatRoot).toBe(runtime(second).napcatRoot);
  expect(runtime(first).snowlumaRoot).toBe(runtime(second).snowlumaRoot);
  expect(b.getMessagePlatformQqAccount()).toBe("12345678");
  await a.saveQqProtocolSelection("official");
  expect(b.getQqProtocolSync()).toBe("official");
  expect(JSON.parse(readFileSync(join(legacy, "qq-backend.json"), "utf8"))).toEqual({ backend: "snowluma" });
  const disk = JSON.parse(readFileSync(join(registry.root, "instances.json"), "utf8"));
  expect(disk.instances.every((item: any) => Object.keys(item.paths).join() === "maibot")).toBe(true);
});

test("changing the shared NapCat location applies to every instance after switching and retains old files", async () => {
  const { root, registry, first, second, runtime } = fixture();
  const target = join(root, "new-napcat"); mkdirSync(target);
  writeFileSync(join(target, "index.js"), "entry"); writeFileSync(join(target, "node.exe"), "runtime");
  const paths = runtime(first), manager = new ResourceLocationManager(paths, false);
  mkdirSync(paths.napcatRoot, { recursive: true }); writeFileSync(join(paths.napcatRoot, "old-account.txt"), "keep");
  await manager.applyPlan(await manager.inspectPath("napcat", target, "existing"));
  registry.select(second.id);
  expect(runtime(second).napcatRoot).toBe(target);
  expect(registry.snapshot().instances.every(item => item.paths.napcat === target)).toBe(true);
  expect(existsSync(join(first.paths.napcat, "old-account.txt"))).toBe(true);
  expect(JSON.parse(readFileSync(join(first.settingsRoot, "resource-paths.json"), "utf8")).paths.napcat).toBeUndefined();
});

test("failed shared directory switch rolls back the central path as well as the active runtime", async () => {
  const { root, registry, first, second, runtime } = fixture();
  const target = join(root, "new-napcat"); mkdirSync(target);
  writeFileSync(join(target, "index.js"), "entry"); writeFileSync(join(target, "node.exe"), "runtime");
  const paths = runtime(first), original = paths.napcatRoot, manager = new ResourceLocationManager(paths, false);
  manager.setApplyHandler(async () => { throw new Error("reload failed"); });
  await expect(manager.applyPlan(await manager.inspectPath("napcat", target, "existing"))).rejects.toThrow("reload failed");
  expect(paths.napcatRoot).toBe(original);
  expect(runtime(second).napcatRoot).toBe(original);
  expect(readSharedProtocols(registry.root)!.paths.napcat).toBe(original);
});

test("legacy multi-component indexes adopt the active binding once and preserve the original index", () => {
  const root = mkdtempSync(join(tmpdir(), "onekey-shared-protocols-")); roots.push(root);
  const registry = new InstanceRegistry(join(root, "launcher")); mkdirSync(registry.root);
  const first = { id: "a", name: "a", settingsRoot: join(root, "settings-a"), resourceRoot: join(root, "data-a"), paths: componentDefaults(join(root, "data-a")) };
  const second = { id: "b", name: "b", settingsRoot: join(root, "settings-b"), resourceRoot: join(root, "data-b"), paths: componentDefaults(join(root, "data-b")) };
  const old = JSON.stringify({ version: 1, activeId: "b", instances: [first, second] });
  writeFileSync(join(registry.root, "instances.json"), old);
  registry.initialize(join(root, "unused"), join(root, "unused"));
  expect(readFileSync(join(registry.root, "instances-before-shared-protocols.json"), "utf8")).toBe(old);
  expect(registry.snapshot().instances.every(item => item.paths.napcat === second.paths.napcat)).toBe(true);
  registry.select(first.id);
  expect(registry.snapshot().instances[0].paths.napcat).toBe(second.paths.napcat);
});

test("protocol launch commands are shared but MaiBot launch commands remain instance-specific", async () => {
  const { root, first, second, runtime } = fixture();
  const managers: ServiceManager[] = [];
  const create = (item: LauncherInstance) => {
    const paths = runtime(item);
    const manager = new ServiceManager(paths, new InitManager(paths), { append() {}, getServiceLogPath: () => join(root, "test.log") } as any, Object.assign(new EventEmitter(), { list: () => [] }) as any);
    managers.push(manager); return manager;
  };
  try {
    const a = create(first);
    await a.saveCommandConfig({ serviceId: "napcat", cwd: runtime(first).napcatRoot, commandLine: "node shared-protocol.js" });
    await a.saveCommandConfig({ serviceId: "maibot", cwd: runtime(first).maibotRoot, commandLine: "python first-only.py" });
    const b = create(second), commands = await b.getCommandConfigs();
    expect(commands.find(item => item.serviceId === "napcat")!.commandLine).toBe("node shared-protocol.js");
    expect(commands.find(item => item.serviceId === "maibot")!.commandLine).not.toBe("python first-only.py");
  } finally { for (const manager of managers) manager.dispose(); }
});
