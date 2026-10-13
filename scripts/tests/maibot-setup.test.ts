import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMaiBotSetupStatus } from "../../src/main/services/maibot-setup-client";
import { InitManager } from "../../src/main/services/init-manager";
import type { RuntimePaths } from "../../src/shared/contracts";

test("setup completes only when MaiBot explicitly reports it, including its skip flow", async () => {
  for (const isFirstSetup of [true, false]) {
    const calls: string[] = [];
    const request = (async (input: any, init: RequestInit) => {
      calls.push(String(input));
      expect((init.headers as Record<string, string>).Cookie).toBe('maibot_session="fixture-token"');
      expect(init.redirect).toBe("error");
      return Response.json({ is_first_setup: isFirstSetup });
    }) as typeof fetch;
    expect(await readMaiBotSetupStatus("http://127.0.0.1:8001/auth?token=unused", "fixture-token", request))
      .toBe(isFirstSetup ? "pending" : "complete");
    expect(calls).toEqual(["http://127.0.0.1:8001/api/webui/setup/status"]);
  }
});

test("missing credentials, authentication failures and invalid status cannot mark setup complete", async () => {
  let requests = 0;
  const request = (async () => { requests++; return Response.json({ is_first_setup: false }); }) as typeof fetch;
  await expect(readMaiBotSetupStatus("http://127.0.0.1:8001", undefined, request)).rejects.toThrow();
  expect(requests).toBe(0);
  for (const response of [
    Response.json({ is_first_setup: false }, { status: 401 }),
    Response.json({ is_first_setup: false }, { status: 404 }),
    Response.json({ is_first_setup: "false" }),
    Response.json({ running: true }),
    new Response("invalid json"),
  ]) {
    await expect(readMaiBotSetupStatus("http://127.0.0.1:8001", "fixture-token", (async () => response) as typeof fetch)).rejects.toThrow();
  }
});

test("host polling uses the active instance's new credentials after the setup password changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "maibot-setup-status-"));
  const cookies: string[] = [];
  let completed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/webui/setup/status");
    cookies.push(request.headers.get("Cookie")!);
    return Response.json({ is_first_setup: !completed });
  } });
  try {
    const maibotRoot = join(root, "MaiBot");
    await mkdir(join(maibotRoot, "data"), { recursive: true });
    await mkdir(join(maibotRoot, "config"), { recursive: true });
    await writeFile(join(maibotRoot, "config", "bot_config.toml"), `[webui]\nhost = "127.0.0.1"\nport = ${server.port}\n`);
    const tokenFile = join(maibotRoot, "data", "webui.json");
    await writeFile(tokenFile, JSON.stringify({ access_token: "initial-fixture-token" }));
    const manager = new InitManager({ maibotRoot } as RuntimePaths);
    expect(await manager.getMaiBotSetupStatus()).toBe("pending");
    await writeFile(tokenFile, JSON.stringify({ access_token: "new-fixture-token" }));
    completed = true;
    expect(await manager.getMaiBotSetupStatus()).toBe("complete");
    expect(cookies).toEqual(['maibot_session="initial-fixture-token"', 'maibot_session="new-fixture-token"']);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
