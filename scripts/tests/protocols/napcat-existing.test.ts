import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InitManager } from "../../../src/main/services/init-manager";
import { ResourceLocationManager } from "../../../src/main/services/resource-location-manager";
import type { RuntimePaths } from "../../../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "onekey-napcat-existing-"));
  roots.push(root);
  const paths = {
    installRoot: root,
    runtimeRoot: join(root, "runtime"),
    bundledModulesRoot: join(root, "bundled"),
    napcatRoot: join(root, "napcat"),
    defaultNapcatRoot: join(root, "napcat"),
    snowlumaRoot: join(root, "snowluma"),
    defaultSnowlumaRoot: join(root, "snowluma"),
    maibotRoot: join(root, "maibot"),
    defaultMaibotRoot: join(root, "maibot"),
    logsRoot: join(root, "logs"),
    userDataRoot: join(root, "settings"),
    maibotDevMode: "source",
  } as RuntimePaths;
  return { paths, manager: new InitManager(paths) };
}

test("missing NapCat never downloads or copies a bundled runtime, even with saved accounts", async () => {
  const { paths, manager } = await fixture();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("unexpected network request"); }) as typeof fetch;
  try {
    await mkdir(paths.napcatRoot, { recursive: true });
    await mkdir(paths.userDataRoot, { recursive: true });
    await writeFile(join(paths.napcatRoot, "saved-account.json"), "keep");
    await writeFile(join(paths.userDataRoot, "qq-backend.json"), JSON.stringify({ backend: "napcat", protocol: "napcat" }));
    await writeFile(join(paths.userDataRoot, "message-platform.json"), JSON.stringify({ version: 1, accounts: { napcat: "12345678" } }));
    await mkdir(join(paths.bundledModulesRoot, "napcat"), { recursive: true });
    await writeFile(join(paths.bundledModulesRoot, "napcat", "index.js"), "old bundled payload");
    const state = await manager.getState({ refreshDependencies: false });
    expect(state.napCatInstalled).toBe(false);
    expect(state.qqProtocol).toBe("official");
    expect(state.checks.some(({ id }) => id.startsWith("napcat"))).toBe(false);
    expect(new ResourceLocationManager(paths, false).getPathConfigs().map(({ key }) => key)).toEqual(["maibot"]);
    await expect(manager.setQqBackend("napcat")).rejects.toThrow("仅支持继续使用已有客户端");
    await expect(manager.setQqAccount("12345678", undefined, "napcat")).rejects.toThrow("仅支持继续使用已有客户端");
    await expect(manager.ensureServiceReady("napcat")).rejects.toThrow("仅支持继续使用已有客户端");
    expect(requests).toBe(0);
    expect(existsSync(join(paths.napcatRoot, "index.js"))).toBe(false);
    expect(await readFile(join(paths.napcatRoot, "saved-account.json"), "utf8")).toBe("keep");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const kind of ["node", "legacy"] as const) {
  test(`installed ${kind} NapCat keeps its selection, login, connection and files`, async () => {
    const { paths, manager } = await fixture();
    const config = join(paths.napcatRoot, "napcat", "config");
    await mkdir(config, { recursive: true });
    await mkdir(paths.userDataRoot, { recursive: true });
    if (kind === "node") {
      await writeFile(join(paths.napcatRoot, "index.js"), "existing runtime");
      await writeFile(join(paths.napcatRoot, "node.exe"), "existing node");
    } else {
      await writeFile(join(paths.napcatRoot, "NapCatWinBootMain.exe"), "existing launcher");
    }
    await writeFile(join(paths.userDataRoot, "qq-backend.json"), JSON.stringify({ backend: "napcat", protocol: "napcat" }));
    await writeFile(join(paths.userDataRoot, "message-platform.json"), JSON.stringify({ version: 1, accounts: { napcat: "12345678" } }));
    const connection = JSON.stringify({ network: { websocketServers: [{ host: "127.0.0.1", port: 17998, token: "old-token" }] } });
    const webui = JSON.stringify({ port: 6099, token: "old-webui-token", other: true });
    await writeFile(join(config, "onebot11_12345678.json"), connection);
    await writeFile(join(config, "webui.json"), webui);
    await writeFile(join(paths.napcatRoot, "user-file.txt"), "keep");
    await manager.setQqBackend("napcat");
    expect(await manager.ensureServiceReady("napcat")).toEqual([]);
    const state = await manager.getState({ refreshDependencies: false });
    expect(state.napCatInstalled).toBe(true);
    expect(state.qqProtocol).toBe("napcat");
    expect(state.qqAccount).toBe("12345678");
    expect(await manager.protocols.connection()).toEqual({ host: "127.0.0.1", port: 17998, token: "old-token" });
    expect(await readFile(join(config, "onebot11_12345678.json"), "utf8")).toBe(connection);
    expect(await readFile(join(config, "webui.json"), "utf8")).toBe(webui);
    expect(await readFile(join(paths.napcatRoot, "user-file.txt"), "utf8")).toBe("keep");
  });
}
