import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { assertLooksLikeMaiBotRoot, readStoredComponentRoots } from "../dev/reset-dev-state";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "maibot-reset-")); roots.push(root);
  return { root, instance: join(root, "modules", "MaiBot") };
}

test("reset accepts missing and template-only default instances before PyPI installation", async () => {
  const { instance } = await fixture();
  expect(() => assertLooksLikeMaiBotRoot(instance, instance)).not.toThrow();
  await mkdir(join(instance, "plugins", "snowluma-adapter"), { recursive: true });
  await writeFile(join(instance, "plugins", "snowluma-adapter", "plugin.py"), "adapter template");
  expect(() => assertLooksLikeMaiBotRoot(instance, instance)).not.toThrow();
});

test("reset still rejects unrecognized custom directories, filesystem roots and corrupt deployment records", async () => {
  const { root, instance } = await fixture();
  const custom = join(root, "custom"); await mkdir(custom);
  expect(() => assertLooksLikeMaiBotRoot(custom, instance)).toThrow("not a PyPI instance");
  expect(() => assertLooksLikeMaiBotRoot(parse(root).root, parse(root).root)).toThrow("filesystem root");
  await mkdir(instance, { recursive: true });
  await writeFile(join(instance, ".onekey-deployment.json"), "{broken");
  expect(() => assertLooksLikeMaiBotRoot(instance, instance)).toThrow("部署记录无效");
});

test("custom paths require a PyPI deployment rather than source markers", async () => {
  const { root, instance } = await fixture();
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true }); await mkdir(join(source, "dashboard"));
  await writeFile(join(source, "bot.py"), "source");
  expect(() => assertLooksLikeMaiBotRoot(source, instance)).toThrow("not a PyPI instance");
  const installed = join(root, "installed"); await mkdir(installed);
  await writeFile(join(installed, ".onekey-deployment.json"), JSON.stringify({ schema: 1, mode: "pypi", generation: "test-env", packageVersion: "1.3.8", sourceUrl: "https://pypi.org/simple", installedAt: Date.now() }));
  expect(() => assertLooksLikeMaiBotRoot(installed, instance)).not.toThrow();
});

test("reset reads only current component paths and ignores legacy locations", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "resource-location.json"), JSON.stringify({ version: 1, resourceRoot: join(root, "old") }));
  expect(readStoredComponentRoots(root)).toEqual({ maibot: undefined, napcat: undefined, snowluma: undefined });
  const current = join(root, "current");
  const store = join(root, "resource-paths.json");
  await writeFile(store, JSON.stringify({ version: 1, paths: { maibot: current } }));
  expect(readStoredComponentRoots(root).maibot).toBe(current);
  await writeFile(store, "{broken");
  expect(() => readStoredComponentRoots(root)).toThrow("Failed to read");
});

test("dev reset dry run works in a fresh template-only workspace without deleting files", async () => {
  const { root, instance } = await fixture();
  const template = join(instance, "plugins", "snowluma-adapter", "plugin.py");
  await mkdir(join(instance, "plugins", "snowluma-adapter"), { recursive: true }); await writeFile(template, "adapter template");
  const child = Bun.spawn([process.execPath, resolve("scripts/dev/reset-dev-state.ts"), "--dry-run"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, APPDATA: join(root, "appdata"), XDG_CONFIG_HOME: join(root, "appdata") },
  });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(error).toBe(""); expect(output).toContain("Dry run complete.");
  expect(existsSync(template)).toBe(true); expect(existsSync(join(instance, "config"))).toBe(false);
});
