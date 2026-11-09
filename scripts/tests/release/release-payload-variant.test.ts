import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../../../package.json";

test("Windows payload excludes NapCat and can be checked without a local copy", async () => {
  const modules = manifest.build.extraResources.find(({ from, to }) => from === "modules" && to === "modules");
  expect(modules?.filter).toContain("!napcat/**");
  expect(manifest.build.win).not.toHaveProperty("extraResources");
  const root = await mkdtemp(join(tmpdir(), "onekey-payload-variant-"));
  const script = resolve("scripts/release/check-windows-payload.ts");
  try {
    const child = Bun.spawn([process.execPath, script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(1);
    expect(output).toContain("[missing] SnowLuma module");
    expect(output).toContain("[missing] MaiBot initial package manifest");
    expect(output).not.toContain("[missing] NapCat");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
