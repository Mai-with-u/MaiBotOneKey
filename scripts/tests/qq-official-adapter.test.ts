import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InitManager } from "../../src/main/services/init-manager";
import { QQ_OFFICIAL_ADAPTER_DIRECTORY, QQ_OFFICIAL_ADAPTER_PLUGIN_ID } from "../../src/shared/qq-official-adapter";
import type { RuntimePaths } from "../../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("first Core preparation installs both adapters and preserves an existing official configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "maibot-official-bundle-"));
  roots.push(root);
  const paths = {
    bundledModulesRoot: join(root, "modules"),
    maibotRoot: join(root, "instance", "MaiBot"),
    logsRoot: join(root, "logs"),
    userDataRoot: join(root, "userData"),
  } as RuntimePaths;
  const bundledCore = join(paths.bundledModulesRoot, "MaiBot");
  const bundledSnowLuma = join(bundledCore, "plugins", "snowluma-adapter");
  await mkdir(bundledSnowLuma, { recursive: true });
  await writeFile(join(bundledCore, "bot.py"), "# fixture");
  await writeFile(join(bundledSnowLuma, "plugin.py"), "# fixture");
  await writeFile(join(bundledSnowLuma, "config.toml"), "bundled config must not be copied");
  await writeFile(join(bundledSnowLuma, "_manifest.json"), JSON.stringify({ id: "maibot-team.snowluma-adapter" }));
  await cp(
    join(process.cwd(), "resources", "bundled-plugins", QQ_OFFICIAL_ADAPTER_DIRECTORY),
    join(root, "resources", "bundled-plugins", QQ_OFFICIAL_ADAPTER_DIRECTORY),
    { recursive: true },
  );
  const manager = new InitManager(paths);
  await manager.ensureServiceReady("maibot");
  const official = join(paths.maibotRoot, "plugins", QQ_OFFICIAL_ADAPTER_DIRECTORY);
  expect(existsSync(join(paths.maibotRoot, "plugins", "snowluma-adapter", "plugin.py"))).toBe(true);
  expect(existsSync(join(paths.maibotRoot, "plugins", "snowluma-adapter", "config.toml"))).toBe(false);
  for (const file of ["plugin.py", "settings.py", "codec.py", "_manifest.json", "LICENSE", "assets/icon.svg"]) {
    expect(existsSync(join(official, file))).toBe(true);
  }
  expect(JSON.parse(await readFile(join(official, "_manifest.json"), "utf8")).id).toBe(QQ_OFFICIAL_ADAPTER_PLUGIN_ID);
  const config = '[plugin]\nenabled = false\n[qq_official]\napp_id = "saved-app-id"\napp_secret = "fixture-secret"\n';
  await writeFile(join(official, "config.toml"), config);
  const custom = join(paths.maibotRoot, "plugins", "custom-official-location");
  await rename(official, custom);
  await manager.ensureServiceReady("maibot");
  expect(await readFile(join(custom, "config.toml"), "utf8")).toBe(config);
  expect(existsSync(official)).toBe(false);
  await mkdir(paths.userDataRoot, { recursive: true });
  const backendStatePath = join(paths.userDataRoot, "qq-backend.json");
  const connections = { snowluma: { port: 7988, token: "preserved-token" } };
  await writeFile(backendStatePath, JSON.stringify({ backend: "snowluma", connections }));
  const snowConfig = join(paths.maibotRoot, "plugins", "snowluma-adapter", "config.toml");
  const snowOriginal = '[plugin]\nenabled = true\n[client]\nport = 7988\ntoken = "saved-token"\n';
  await writeFile(snowConfig, snowOriginal);
  const requests: unknown[] = [];
  manager.adapters.configureOfficial = async (credentials) => {
    if (credentials && !credentials.appSecret.trim()) throw new Error("请填写 AppID 和 AppSecret");
    requests.push(credentials);
  };
  await expect(manager.setQqProtocol("official", { officialCredentials: { appId: "new-id", appSecret: " " } })).rejects.toThrow("请填写 AppID 和 AppSecret");
  expect(manager.getQqProtocolSync()).toBe("snowluma");
  await manager.setQqProtocol("official");
  expect(new InitManager(paths).getQqProtocolSync()).toBe("official");
  expect(manager.getQqBackendSync()).toBe("snowluma");
  expect(JSON.parse(await readFile(backendStatePath, "utf8")).connections).toEqual(connections);
  await manager.setQqProtocol("official", { officialCredentials: { appId: "new-id", appSecret: "fixture-secret" } });
  expect(requests).toEqual([undefined, { appId: "new-id", appSecret: "fixture-secret" }]);
  expect(await readFile(join(custom, "config.toml"), "utf8")).toBe(config);
  expect(await readFile(snowConfig, "utf8")).toBe(snowOriginal);

});

test("release resources include the official plugin without user configuration", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const resource = packageJson.build.extraResources.find((item: { to: string }) => item.to === "modules/MaiBot/plugins/qq_official_adapter");
  expect(resource.from).toBe("resources/bundled-plugins/qq_official_adapter");
  expect(resource.filter).toContain("!config.toml");
  expect(resource.filter).toContain("!data/**");
});
