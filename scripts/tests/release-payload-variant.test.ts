import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("only standard payload checks require NapCat in an empty build workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "onekey-payload-variant-"));
  const script = resolve("scripts/release/check-windows-payload.ts");
  try {
    for (const flags of [[], ["--snowluma-only"]]) {
      const child = Bun.spawn([process.execPath, script, ...flags], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(1);
      expect(output).toContain("[missing] SnowLuma module");
      expect(output).toContain("[missing] MaiBot module");
      if (flags.length) expect(output).not.toContain("[missing] NapCat");
      else expect(output).toContain("[missing] NapCat module");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
