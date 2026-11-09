import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { InitManager } from "../../../src/main/services/init-manager";
import { QQ_OFFICIAL_ADAPTER_PLUGIN_ID } from "../../../src/shared/qq-official-adapter";
import type { RuntimePaths } from "../../../src/shared/contracts";

test("preparing an old template never copies the official adapter or changes an existing installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "maibot-official-bundle-"));
  try {
    const paths = {
      bundledModulesRoot: join(root, "modules"), maibotRoot: join(root, "instance"),
      logsRoot: join(root, "logs"), userDataRoot: join(root, "settings"), maibotDevMode: "source",
    } as RuntimePaths;
    const source = join(paths.bundledModulesRoot, "MaiBot");
    const oldPlugin = join("plugins", "qq_official_adapter");
    await mkdir(join(source, oldPlugin), { recursive: true });
    await writeFile(join(source, "bot.py"), "# fixture");
    await writeFile(join(source, oldPlugin, "plugin.py"), "# old bundle");
    await writeFile(join(source, oldPlugin, "_manifest.json"), JSON.stringify({ id: QQ_OFFICIAL_ADAPTER_PLUGIN_ID }));
    const manager = new InitManager(paths);
    await manager.ensureServiceReady("maibot");
    const target = join(paths.maibotRoot, oldPlugin);
    expect(existsSync(target)).toBe(false);
    await mkdir(target, { recursive: true });
    const existingConfig = '[qq_official]\napp_id = "fixture"\n';
    await writeFile(join(target, "config.toml"), existingConfig);
    await manager.ensureServiceReady("maibot");
    expect(await readFile(join(target, "config.toml"), "utf8")).toBe(existingConfig);
    expect(existsSync(join(target, "plugin.py"))).toBe(false);
  } finally {
    if (relative(tmpdir(), root).startsWith("maibot-official-bundle-")) await rm(root, { recursive: true, force: true });
  }
});

test("Windows packaging excludes the old official plugin even if the development modules contain it", async () => {
  const { build } = JSON.parse(await readFile("package.json", "utf8"));
  expect(build.extraResources.some(({ from, to }: { from: string; to: string }) =>
    from.includes("qq_official_adapter") || to.includes("qq_official_adapter"),
  )).toBe(false);
  expect(build.extraResources.find(({ from }: { from: string }) => from === "modules").filter).toContain("!MaiBot/plugins/**");
});
