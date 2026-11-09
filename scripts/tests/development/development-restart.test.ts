import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDevelopmentSession } from "../../dev/development-session";
import { DEV_RESUME_INSTANCE_ENV } from "../../../src/shared/development-restart";

test("instance restart restores the page server and passes the selection-resume flag to the new process", async () => {
  const root = mkdtempSync(join(tmpdir(), "onekey-restart-test-")), marker = join(root, "restart");
  let launches = 0;
  const script = `const server = Bun.serve({port: 0, hostname: "127.0.0.1", fetch: () => new Response(process.env.${DEV_RESUME_INSTANCE_ENV} || "initial")}); console.log(server.port); process.stdin.on("data", () => { server.stop(true); process.exit(0); }); process.stdin.resume();`;
  try {
    const code = await runDevelopmentSession(async env => {
      launches++;
      const child = Bun.spawn([process.execPath, "-e", script], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      try {
        const reader = child.stdout.getReader();
        let output = "";
        while (!output.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("Page server exited before ready"); output += new TextDecoder().decode(chunk.value); }
        reader.releaseLock();
        const url = `http://127.0.0.1:${Number(output.trim())}/`;
        expect(await (await fetch(url)).text()).toBe(launches === 1 ? "initial" : "1");
        if (launches === 1) writeFileSync(marker, "restart");
        child.stdin.write("exit\n"); child.stdin.end();
        const exitCode = await child.exited;
        await expect(fetch(url)).rejects.toThrow();
        return exitCode;
      } finally { child.kill(); }
    }, { ...process.env, [DEV_RESUME_INSTANCE_ENV]: undefined }, marker, () => false);
    expect(code).toBe(0); expect(launches).toBe(2); expect(existsSync(marker)).toBe(false);
  } finally { if (existsSync(marker)) unlinkSync(marker); rmdirSync(root); }
}, 15000);

test("normal close, failed startup and explicit shutdown never trigger a restart loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "onekey-restart-test-")), marker = join(root, "restart");
  try {
    for (const scenario of [{ marker: false, code: 0, stop: false }, { marker: true, code: 1, stop: false }, { marker: true, code: 0, stop: true }]) {
      let calls = 0;
      if (scenario.marker) writeFileSync(marker, "restart");
      expect(await runDevelopmentSession(async () => { calls++; return scenario.code; }, {}, marker, () => scenario.stop)).toBe(scenario.code);
      expect(calls).toBe(1);
      if (existsSync(marker)) unlinkSync(marker);
    }
  } finally { if (existsSync(marker)) unlinkSync(marker); rmdirSync(root); }
});
