import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { ServiceManager } from "../../../src/main/services/service-manager";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InitManager } from "../../../src/main/services/init-manager";
import { ResourceLocationManager } from "../../../src/main/services/resource-location-manager";
import type { InitState, QqBackend, RuntimePaths, ServiceId } from "../../../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "maibot-qq-switch-"));
  roots.push(root);
  const paths = {
    installRoot: root,
    runtimeRoot: join(root, "runtime"),
    pythonEnvRoot: join(root, "python-env"),
    logsRoot: join(root, "logs"),
    maibotRoot: join(root, "MaiBot"),
    defaultMaibotRoot: join(root, "MaiBot"),
    napcatRoot: join(root, "napcat"),
    defaultNapcatRoot: join(root, "napcat"),
    snowlumaRoot: join(root, "SnowLuma"),
    defaultSnowlumaRoot: join(root, "SnowLuma"),
    userDataRoot: join(root, "userData"),
    bundledModulesRoot: join(root, "bundled"),
  } as RuntimePaths;
  const adapterPath = join(paths.maibotRoot, "plugins", "snowluma-adapter", "config.toml");
  await mkdir(join(paths.maibotRoot, "plugins", "snowluma-adapter"), { recursive: true });
  await mkdir(join(paths.napcatRoot, "napcat"), { recursive: true });
  await writeFile(join(paths.napcatRoot, "NapCatWinBootMain.exe"), "existing NapCat fixture");
  const manager = new InitManager(paths);
  // These tests exercise setup and the actual generated connection files,
  // without requiring bundled binaries or Python dependency discovery.
  manager.ensureServiceReady = async () => [];
  manager.adapters.configureConnection = async () => {};
  manager.getState = async () => ({ qqBackend: manager.getQqBackendSync() } as InitState);
  return { paths, manager, adapterPath };
}

test("start-all continues with MaiBot after a NapCat port conflict and reports the failure", async () => {
  const { paths, manager } = await fixture();
  manager.hasMessagePlatformConfigured = () => true;
  const pty = Object.assign(new EventEmitter(), { list: () => [] });
  const services = new ServiceManager(paths, manager, { append() {}, getServiceLogPath: (id: string) => join(paths.logsRoot, `${id}.log`) } as any, pty as any);
  const attempts: ServiceId[] = [];
  let refreshed = false;
  services.start = async (id) => {
    attempts.push(id);
    if (id === "napcat") throw new Error("端口 6099 已被占用，请停止占用进程后重试");
    return services.snapshot().find((service) => service.id === id)!;
  };
  services.refresh = async () => { refreshed = true; return services.snapshot(); };
  try {
    await expect(services.startAll()).rejects.toThrow("NapCat 启动失败：端口 6099 已被占用");
    expect(attempts).toEqual(["napcat", "maibot"]);
    expect(refreshed).toBe(true);
  } finally { services.dispose(); }
});

test("start-all reports both service failures after attempting both services", async () => {
  const { paths, manager } = await fixture();
  manager.hasMessagePlatformConfigured = () => true;
  const pty = Object.assign(new EventEmitter(), { list: () => [] });
  const services = new ServiceManager(paths, manager, { append() {}, getServiceLogPath: (id: string) => join(paths.logsRoot, `${id}.log`) } as any, pty as any);
  const attempts: ServiceId[] = [];
  services.start = async (id) => { attempts.push(id); throw new Error(`${id} unavailable`); };
  services.refresh = async () => services.snapshot();
  try {
    await expect(services.startAll()).rejects.toThrow("NapCat 启动失败：napcat unavailable；MaiBot Core 启动失败：maibot unavailable");
    expect(attempts).toEqual(["napcat", "maibot"]);
  } finally { services.dispose(); }
});

test("old SnowLuma selections fall back to NapCat without taking its account or touching its data", async () => {
  const { paths, manager } = await fixture();
  await mkdir(paths.userDataRoot, { recursive: true });
  const selection = join(paths.userDataRoot, "qq-backend.json");
  const stored = JSON.stringify({ backend: "snowluma", protocol: "snowluma" });
  await writeFile(selection, stored);
  await writeFile(join(paths.userDataRoot, "message-platform.json"), JSON.stringify({ version: 1, backend: "snowluma", accounts: { snowluma: "654321" } }));
  const config = join(paths.snowlumaRoot, "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "runtime.json"), "keep old settings");
  expect(manager.getQqBackendSync()).toBe("napcat");
  expect(manager.getQqProtocolSync()).toBe("napcat");
  expect(manager.getMessagePlatformQqAccount()).toBeUndefined();
  expect(manager.hasInstalledSnowLuma()).toBe(false);
  expect(new ResourceLocationManager(paths, false).getPathConfigs().map(({ key }) => key)).not.toContain("snowluma");
  await expect(manager.setQqBackend("snowluma")).rejects.toThrow("没有可用的 SnowLuma 安装");
  await expect(manager.setQqAccount("123456", undefined, "snowluma")).rejects.toThrow("没有可用的 SnowLuma 安装");
  expect(await readFile(selection, "utf8")).toBe(stored);
  expect(await readFile(join(config, "runtime.json"), "utf8")).toBe("keep old settings");
  const legacyCommand = JSON.stringify({ version: 1, services: { napcat: { commandLine: "node index.mjs" } } });
  const commandPath = join(paths.userDataRoot, "service-commands.json");
  await writeFile(commandPath, legacyCommand);
  const pty = Object.assign(new EventEmitter(), { list: () => [] });
  const services = new ServiceManager(paths, manager, { append() {}, getServiceLogPath: () => join(paths.logsRoot, "test.log") } as any, pty as any);
  try {
    expect((await services.getCommandConfigs()).find((service) => service.serviceId === "napcat")?.customized).toBe(false);
    expect(await readFile(commandPath, "utf8")).toBe(legacyCommand);
  } finally {
    services.dispose();
  }
  await writeFile(selection, JSON.stringify({ backend: "snowluma", protocol: "official" }));
  expect(manager.getQqProtocolSync()).toBe("official");
});

test("an installed SnowLuma keeps its account, custom startup, WebUI port, and OneBot settings", async () => {
  const { paths, manager } = await fixture();
  const config = join(paths.snowlumaRoot, "config");
  await mkdir(config, { recursive: true });
  await mkdir(paths.userDataRoot, { recursive: true });
  await writeFile(join(paths.snowlumaRoot, "index.mjs"), "existing SnowLuma fixture");
  const selection = join(paths.userDataRoot, "qq-backend.json");
  await writeFile(selection, JSON.stringify({ backend: "snowluma", protocol: "snowluma" }));
  await writeFile(join(paths.userDataRoot, "message-platform.json"), JSON.stringify({ version: 1, backend: "snowluma", accounts: { snowluma: "654321" } }));
  await writeFile(join(paths.userDataRoot, "service-commands.json"), JSON.stringify({ version: 1, services: { napcat: { commandLine: "node index.mjs" } } }));
  const runtime = JSON.stringify({ webuiPort: 15099, otherSetting: true });
  const onebot = JSON.stringify({ networks: { wsServers: [{ name: "Custom endpoint", host: "127.0.0.1", port: 17988, accessToken: "old-token" }] } });
  await writeFile(join(config, "runtime.json"), runtime);
  await writeFile(join(config, "onebot.json"), onebot);

  const restarted = new InitManager(paths);
  const state = await restarted.getState({ refreshDependencies: false });
  expect(state.snowLumaInstalled).toBe(true);
  expect(state.qqProtocol).toBe("snowluma");
  expect(state.qqAccount).toBe("654321");
  expect(new ResourceLocationManager(paths, false).getPathConfigs().map(({ key }) => key)).toContain("snowluma");
  expect(await restarted.ensureServiceReady("napcat")).toEqual([]);
  expect(await restarted.protocols.connection()).toEqual({ host: "127.0.0.1", port: 17988, token: "old-token" });
  const pty = Object.assign(new EventEmitter(), { list: () => [] });
  const services = new ServiceManager(paths, restarted, { append() {}, getServiceLogPath: () => join(paths.logsRoot, "test.log") } as any, pty as any);
  try {
    expect(services.snapshot().find(({ id }) => id === "napcat")).toMatchObject({
      name: "SnowLuma", url: "http://127.0.0.1:15099", ports: [15099, 17988],
    });
    expect((await services.getCommandConfigs()).find(({ serviceId }) => serviceId === "napcat")).toMatchObject({
      customized: true, commandLine: "node index.mjs",
    });
  } finally {
    services.dispose();
  }
  await manager.setQqBackend("snowluma");
  await manager.setQqAccount("654321", undefined, "snowluma");
  expect(await readFile(join(config, "runtime.json"), "utf8")).toBe(runtime);
  expect(await readFile(join(config, "onebot.json"), "utf8")).toBe(onebot);
  expect(existsSync(join(config, "onebot_654321.json"))).toBe(false);
  await restarted.protocols.saveQqProtocolSelection("official");
  expect(restarted.getQqProtocolSync()).toBe("official");
  expect(restarted.hasInstalledSnowLuma()).toBe(true);
});

test("a SnowLuma entry in bundled resources does not enable the legacy protocol", async () => {
  const { paths } = await fixture();
  paths.snowlumaRoot = join(paths.bundledModulesRoot, "SnowLuma");
  await mkdir(paths.snowlumaRoot, { recursive: true });
  await writeFile(join(paths.snowlumaRoot, "index.mjs"), "bundled SnowLuma fixture");
  expect(new InitManager(paths).hasInstalledSnowLuma()).toBe(false);
});

async function endpoint(paths: RuntimePaths, backend: QqBackend) {
  if (backend === "napcat") {
    const config = JSON.parse(await readFile(join(paths.napcatRoot, "napcat", "config", "onebot11_123456.json"), "utf8"));
    const server = config.network.websocketServers[0];
    return { port: server.port, token: server.token };
  }
  const config = JSON.parse(await readFile(join(paths.snowlumaRoot, "config", "onebot_123456.json"), "utf8"));
  const server = config.networks.wsServers[0];
  return { port: server.port, token: server.accessToken };
}

for (const backend of ["napcat"] as const) {
  test(`${backend} requires a valid QQ account before changing configuration`, async () => {
    const { manager } = await fixture();
    const previousBackend = manager.getQqBackendSync();
    for (const account of ["", "0", "invalid"]) {
      await expect(manager.setQqAccount(account, undefined, backend)).rejects.toThrow("QQ 号必须是纯数字");
    }
    expect(manager.getQqBackendSync()).toBe(previousBackend);
    expect(manager.hasMessagePlatformConfigured()).toBe(false);
  });
}

for (const backend of ["napcat"] as const) {
  test(`${backend} uses saved setup accounts and ignores the removed bot config field`, async () => {
    const { paths, manager } = await fixture();
    const configDir = join(paths.maibotRoot, "config");
    const configPath = join(configDir, "bot_config.toml");
    await mkdir(configDir, { recursive: true });
    const legacyConfig = '[bot]\nqq_account = "111111"\n';
    await writeFile(configPath, legacyConfig);
    expect(manager.getMessagePlatformQqAccount()).toBeUndefined();
    expect(manager.getMessagePlatformQqAccount()).toBeUndefined();
    await expect(manager.syncQqConnections()).rejects.toThrow("请先在消息平台中配置");
    await manager.setQqAccount("2814567326", undefined, backend);
    expect(manager.getMessagePlatformQqAccount()).toBe("2814567326");
    expect(await readFile(configPath, "utf8")).toBe(legacyConfig);
    await writeFile(configPath, '[bot]\nnickname = "test"\n');
    const restarted = new InitManager(paths);
    expect(restarted.getMessagePlatformQqAccount()).toBe("2814567326");
    expect(restarted.getMessagePlatformQqAccount()).toBe("2814567326");
  });
}

for (const backend of ["napcat"] as const) {
  test(`${backend} setup and switching never touch MaiBot adapter configuration`, async () => {
    const { paths, manager, adapterPath } = await fixture();
    const original = "[plugin\nenabled = false\n"; // Even malformed plugin config is outside protocol ownership.
    await writeFile(adapterPath, original);
    await manager.setQqAccount("123456", "first-token", backend);
    const before = await endpoint(paths, backend);
    await manager.setQqBackend(backend);
    expect(await endpoint(paths, backend)).toEqual(before);
    expect(await readFile(adapterPath, "utf8")).toBe(original);
    expect(existsSync(join(paths.maibotRoot, "plugins", "napcat-adapter"))).toBe(false);
  });
}

test("legacy message platform account belongs only to its saved backend", async () => {
  const { paths, manager } = await fixture();
  await mkdir(paths.userDataRoot, { recursive: true });
  await writeFile(join(paths.userDataRoot, "message-platform.json"), JSON.stringify({ version: 1, backend: "snowluma", qqAccount: "654321" }));
  expect(manager.getQqBackendAccounts()).toEqual({ napcat: undefined, snowluma: "654321" });
});
for (const backend of ["napcat"] as const) {
  test(`environment repair preserves ${backend} connection files until explicit synchronization`, async () => {
    const { paths, manager, adapterPath } = await fixture();
    await manager.setQqAccount("123456", "shared-token", backend);
    manager.ensureModulesReady = async () => [];
    const configPath = join(paths.napcatRoot, "napcat", "config", "onebot11_123456.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.network.websocketServers[0].token = "different-token";
    const changed = JSON.stringify(config);
    await writeFile(configPath, changed);
    await writeFile(adapterPath, "adapter config remains untouched");
    const adapterBefore = await readFile(adapterPath, "utf8");
    await manager.repair();
    expect(await readFile(configPath, "utf8")).toBe(changed);
    expect(await readFile(adapterPath, "utf8")).toBe(adapterBefore);
    await manager.syncQqConnections();
    expect((await endpoint(paths, backend)).token).toBe("different-token");
    expect(await readFile(adapterPath, "utf8")).toBe(adapterBefore);
  });
}

test("explicit connection synchronization requires configured account", async () => {
  const { manager } = await fixture();
  await expect(manager.syncQqConnections()).rejects.toThrow("请先在消息平台中配置");
});

for (const backend of ["napcat"] as const) {
  test(`advanced settings saves ${backend} account without switching the selected protocol`, async () => {
    const { paths, manager } = await fixture();
    await manager.setQqAccount("123456", undefined, "napcat");
    await manager.saveQqBackendAccount(backend, " 654321 ");
    expect(manager.getQqBackendSync()).toBe("napcat");
    expect(manager.getQqBackendAccounts()[backend]).toBe("654321");
    expect(manager.getMessagePlatformQqAccount()).toBe("654321");
    const restarted = new InitManager(paths);
    restarted.ensureServiceReady = async () => [];
    await restarted.setQqBackend(backend);
    expect(restarted.getMessagePlatformQqAccount()).toBe("654321");
    const configPath = join(paths.napcatRoot, "napcat", "config", "onebot11_654321.json");
    expect(existsSync(configPath)).toBe(true);
  });
}

for (const backend of ["napcat"] as const) {
  test(`${backend} page and tray startup requests open account setup without failing or spawning`, async () => {
    const { paths, manager } = await fixture();
    await manager.setQqBackend(backend);
    const pty = Object.assign(new EventEmitter(), { list: () => [] });
    const services = new ServiceManager(paths, manager, { append() {}, getServiceLogPath: (id: string) => join(paths.logsRoot, `${id}.log`) } as any, pty as any);
    try {
      const requests: QqBackend[] = [];
      services.on("qq-account-setup-required", (requested) => requests.push(requested));
      const single = await services.start("napcat");
      expect(single.status).toBe("stopped");
      expect(single.error).toBeUndefined();
      const originalStart = services.start.bind(services);
      const starts: ServiceId[] = [];
      services.start = async (id) => { starts.push(id); return id === "maibot" ? services.snapshot().find((service) => service.id === id)! : originalStart(id); };
      services.refresh = async () => services.snapshot();
      await services.startAll();
      expect(starts).toEqual(["maibot"]);
      expect(requests).toEqual([backend, backend]);
    } finally {
      services.dispose();
    }
  });
}
