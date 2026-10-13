import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InitManager } from "../../src/main/services/init-manager";
import { readStoredResourcePaths } from "../../src/main/services/runtime-resource-paths";
import type { RuntimePaths } from "../../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "onekey-config-isolation-"));
  roots.push(root);
  return root;
}

test("missing stores use defaults, while modern paths and legacy roots survive startup", async () => {
  const root = await fixture();
  expect(readStoredResourcePaths(root)).toEqual({});
  const legacyRoot = join(root, "legacy");
  await writeFile(join(root, "resource-location.json"), JSON.stringify({ version: 1, resourceRoot: legacyRoot }));
  expect(readStoredResourcePaths(root).maibot).toBe(join(legacyRoot, "modules", "MaiBot"));
  const maibot = join(root, "external");
  await writeFile(join(root, "resource-paths.json"), JSON.stringify({ version: 1, paths: { maibot } }));
  expect(readStoredResourcePaths(root).maibot).toBe(maibot);
  await writeFile(join(root, "resource-paths.json"), JSON.stringify({ version: 1, paths: {} }));
  expect(readStoredResourcePaths(root)).toEqual({ maibot: undefined, napcat: undefined, snowluma: undefined });
});

test("broken or invalid modern stores never switch silently to defaults or legacy paths", async () => {
  const root = await fixture();
  await writeFile(join(root, "resource-location.json"), JSON.stringify({ version: 1, resourceRoot: root }));
  const store = join(root, "resource-paths.json");
  for (const content of ["{broken", "null", "[]", '{"version":2,"paths":{}}', '{"version":1}', '{"version":1,"paths":{"maibot":"relative"}}', '{"version":1,"paths":{"maibot":4}}']) {
    await writeFile(store, content);
    expect(() => readStoredResourcePaths(root)).toThrow(store);
    expect(await readFile(store, "utf8")).toBe(content);
  }
});

test("unreadable stores and broken legacy stores report the configuration path", async () => {
  const root = await fixture();
  const store = join(root, "resource-paths.json");
  await mkdir(store);
  expect(() => readStoredResourcePaths(root)).toThrow(store);
  await rm(store, { recursive: true });
  const legacy = join(root, "resource-location.json");
  await writeFile(legacy, "{broken");
  expect(() => readStoredResourcePaths(root)).toThrow(legacy);
});

test("WebUI never borrows bundled instance ports or credentials, even when active files are broken", async () => {
  const root = await fixture();
  const maibotRoot = join(root, "active");
  const bundledModulesRoot = join(root, "bundled");
  for (const base of [maibotRoot, join(bundledModulesRoot, "MaiBot")]) {
    await mkdir(join(base, "config"), { recursive: true });
    await mkdir(join(base, "data"), { recursive: true });
  }
  await writeFile(join(bundledModulesRoot, "MaiBot", "config", "bot_config.toml"), '[webui]\nhost="127.0.0.1"\nport=18999\n');
  await writeFile(join(bundledModulesRoot, "MaiBot", "data", "webui.json"), '{"access_token":"other-instance"}');
  const manager = new InitManager({ maibotRoot, bundledModulesRoot, userDataRoot: root } as RuntimePaths);
  expect(manager.readMaiBotWebUiEndpointSync().port).not.toBe(18999);
  expect(await manager.readMaiBotWebUiToken()).toEqual({ exists: false });
  await writeFile(join(maibotRoot, "config", "bot_config.toml"), "[broken");
  await writeFile(join(maibotRoot, "data", "webui.json"), "{broken");
  expect(manager.readMaiBotWebUiEndpointSync().fallbackReason).toContain("读取 WebUI 配置失败");
  expect((await manager.readMaiBotWebUiToken()).token).toBeUndefined();
  await writeFile(join(maibotRoot, "config", "bot_config.toml"), '[webui]\nhost="127.0.0.1"\nport=18002\n');
  await writeFile(join(maibotRoot, "data", "webui.json"), '{"access_token":"active-instance"}');
  expect(manager.readMaiBotWebUiEndpointSync().port).toBe(18002);
  expect((await manager.readMaiBotWebUiToken()).token).toBe("active-instance");
});
