import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolComponentManager } from "../../src/main/services/protocol-component-manager";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("protocol upgrades preserve accounts and data without touching MaiBot files", async () => {
  const root = await mkdtemp(join(tmpdir(), "maibot-protocol-components-"));
  roots.push(root);
  const paths = { installRoot: root, bundledModulesRoot: join(root, "bundled"), napcatRoot: join(root, "napcat"), snowlumaRoot: join(root, "SnowLuma") };
  const coreConfig = join(root, "MaiBot", "plugins", "adapter", "config.toml");
  await mkdir(join(root, "MaiBot", "plugins", "adapter"), { recursive: true });
  await writeFile(coreConfig, "core config must stay untouched");
  for (const [name, target] of [["napcat", paths.napcatRoot], ["SnowLuma", paths.snowlumaRoot]] as const) {
    await mkdir(join(paths.bundledModulesRoot, name), { recursive: true });
    await writeFile(join(paths.bundledModulesRoot, name, "entry.js"), "new binary content");
    await mkdir(join(target, "config"), { recursive: true });
    await mkdir(join(target, "data"), { recursive: true });
    await writeFile(join(target, "config", "account.json"), "saved account");
    await writeFile(join(target, "data", "session.db"), "saved session");
    await writeFile(join(target, "entry.js"), "old binary content");
  }
  const manager = new ProtocolComponentManager(paths);
  // Keep the fixture independent of the real machine's processes.
  (manager as any).cleanupQqComponentProcesses = async () => {};
  const result = await manager.upgradeQqComponents();
  expect(result.components.map((item) => item.id)).toEqual(["napcat", "snowluma"]);
  for (const target of [paths.napcatRoot, paths.snowlumaRoot]) {
    expect(await readFile(join(target, "entry.js"), "utf8")).toBe("new binary content");
    expect(await readFile(join(target, "config", "account.json"), "utf8")).toBe("saved account");
    expect(await readFile(join(target, "data", "session.db"), "utf8")).toBe("saved session");
  }
  expect(await readFile(coreConfig, "utf8")).toBe("core config must stay untouched");
});

test("SnowLuma reset refuses to delete the bundled template", async () => {
  const root = await mkdtemp(join(tmpdir(), "maibot-protocol-reset-"));
  roots.push(root);
  const bundledModulesRoot = join(root, "bundled");
  const snowlumaRoot = join(bundledModulesRoot, "SnowLuma");
  await mkdir(snowlumaRoot, { recursive: true });
  await writeFile(join(snowlumaRoot, "entry.js"), "bundled content");
  const manager = new ProtocolComponentManager({ installRoot: root, bundledModulesRoot, snowlumaRoot, napcatRoot: join(root, "napcat") });
  await expect(manager.resetSnowLumaComponent()).rejects.toThrow("拒绝重置");
  expect(await readFile(join(snowlumaRoot, "entry.js"), "utf8")).toBe("bundled content");
});
