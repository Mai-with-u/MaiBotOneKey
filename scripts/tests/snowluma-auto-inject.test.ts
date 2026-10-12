import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { prepareRuntime, prepareSnowLumaEntry } from "../../src/main/services/snowluma-auto-inject";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const bundle = () => readFile(resolve("modules/SnowLuma/index.mjs"), "utf8");

test("installed bundle monitors only the target, retries failures, and stops on shutdown", async () => {
  const source = prepareRuntime(await bundle(), "2814567326");
  const start = source.indexOf("  const targetUin =");
  const end = source.indexOf("oneBotManager.bind(bridgeManager);", start);
  let nextScan: () => Promise<void> = async () => {};
  let now = 0;
  let fail = false;
  const injected: number[] = [];
  let processes = [{ pid: 1, injected: false }, { pid: 2, injected: false }, { pid: 4, injected: false }];
  let schedules = 0;
  const context = {
    hookManager: {
      listProcesses: async () => processes,
      probeProcessLoginInfo: async (pid: number) => ({ identityKnown: pid !== 4, uin: pid === 1 ? "111111" : "2814567326" }),
      loadProcess: async (pid: number) => {
        injected.push(pid);
        if (fail) return { injected: false, status: "error" };
        processes.find(p => p.pid === pid)!.injected = true;
        return { injected: true, status: "online" };
      },
    },
    Date: { now: () => now },
    log: { info() {}, error() {} },
    setTimeout: (callback: () => Promise<void>) => { nextScan = callback; return ++schedules; },
    clearTimeout() {},
  };
  const vmContext = createContext(context);
  runInContext(source.slice(start, end), vmContext);
  await nextScan();
  await nextScan();
  expect(injected).toEqual([2]);
  processes = [{ pid: 1, injected: false }, { pid: 3, injected: false }];
  fail = true;
  await nextScan();
  await nextScan();
  expect(injected).toEqual([2, 3]);
  now = 30000;
  fail = false;
  await nextScan();
  expect(injected).toEqual([2, 3, 3]);
  runInContext("targetMonitorStopped = true; clearTimeout(targetMonitorTimer);", vmContext);
  const before = schedules;
  await nextScan();
  expect(schedules).toBe(before);
  expect(source).toContain("const autoLoadOnDiscovery = false;");
});

test("missing accounts, incompatible bundles and invalid accounts are rejected", async () => {
  await expect(prepareSnowLumaEntry("fixture", "")).rejects.toThrow("Target QQ");
  await expect(prepareSnowLumaEntry("fixture", "0")).rejects.toThrow("Target QQ");
  expect(() => prepareRuntime("unknown", "123")).toThrow("Unsupported SnowLuma bundle");
  expect(() => prepareRuntime("unknown", "1';throw 1")).toThrow("Target QQ");
});

test("generated entry preserves real database migration workers and original bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "onekey-snowluma-"));
  roots.push(root);
  const fixture = `
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
function markersOnly() {
const autoLoadOnDiscovery = resolveAutoLoad(runtimeConfig.hookAutoLoad);
if (autoLoadOnDiscovery) log.info("hook auto-load enabled: every discovered QQ process will be injected");
shutdownStarted = true;
}
if (isMainThread) {
  const worker = new Worker(process.argv[1], { workerData: { kind: 'migration' } });
  worker.on('message', message => console.log(message));
  worker.on('error', error => { console.error(error); process.exitCode = 1; });
} else { parentPort.postMessage('migration passed'); }
`;
  await writeFile(join(root, "index.mjs"), fixture);
  const entry = await prepareSnowLumaEntry(root, "2814567326");
  const node = resolve("modules/SnowLuma/node.exe");
  const result = spawnSync(node, [entry], { encoding: "utf8", timeout: 15000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("migration passed");
  expect(await readFile(join(root, "index.mjs"), "utf8")).toBe(fixture);
  expect(await prepareSnowLumaEntry(root, "123456")).toBe(entry);
  await writeFile(join(root, "index.mjs"), await bundle());
  await prepareSnowLumaEntry(root, "2814567326");
  const syntax = spawnSync(node, ["--check", entry], { encoding: "utf8", timeout: 15000 });
  expect(syntax.error).toBeUndefined();
  expect(syntax.status).toBe(0);
});
