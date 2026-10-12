import { EventEmitter } from "node:events";
import { InitManager } from "../../src/main/services/init-manager";
import { ServiceManager } from "../../src/main/services/service-manager";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ResourceLocationManager } from "../../src/main/services/resource-location-manager";
import { RuntimeOperationLock } from "../../src/main/services/runtime-operation-lock";
import type { ResourcePathProgress, RuntimePaths, RuntimeResourcePathKey } from "../../src/shared/contracts";

const fixtures: Array<{ root: string; manager: ResourceLocationManager }> = [];
afterEach(async () => {
  for (const { root, manager } of fixtures.splice(0)) {
    manager.release();
    const target = resolve(root), base = resolve(tmpdir());
    if (!target.startsWith(join(base, "maibot-resource-test-"))) throw new Error("Unexpected test cleanup path");
    await rm(target, { recursive: true, force: true });
  }
});
async function component(path: string, key: RuntimeResourcePathKey) {
  await mkdir(path, { recursive: true });
  if (key === "maibot") {
    await mkdir(join(path, "src")); await writeFile(join(path, "bot.py"), "core entry"); await writeFile(join(path, "src", "main.py"), "core source");
  } else if (key === "snowluma") {
    await mkdir(join(path, "native")); await writeFile(join(path, "index.mjs"), "snowluma entry"); await writeFile(join(path, "node.exe"), "runtime");
  } else { await writeFile(join(path, "index.js"), "napcat entry"); await writeFile(join(path, "node.exe"), "runtime"); }
}
async function fixture(lowSpace = false) {
  const root = await mkdtemp(join(tmpdir(), "maibot-resource-test-"));
  const paths = {
    installRoot: root, userDataRoot: join(root, "settings"), defaultResourceRoot: join(root, "settings"), bundledModulesRoot: join(root, "templates"), runtimeRoot: join(root, "runtime"), pythonEnvRoot: join(root, "python-env"), logsRoot: join(root, "settings", "logs"),
    defaultMaibotRoot: join(root, "instances", "MaiBot"), maibotRoot: join(root, "instances", "MaiBot"), defaultNapcatRoot: join(root, "instances", "NapCat"), napcatRoot: join(root, "instances", "NapCat"), defaultSnowlumaRoot: join(root, "instances", "SnowLuma"), snowlumaRoot: join(root, "instances", "SnowLuma"),
  } as RuntimePaths;
  for (const [key, path] of [["maibot", paths.maibotRoot], ["napcat", paths.napcatRoot], ["snowluma", paths.snowlumaRoot]] as const) await component(path, key);
  await mkdir(paths.userDataRoot); await mkdir(paths.bundledModulesRoot);
  await mkdir(join(paths.maibotRoot, "config")); await mkdir(join(paths.maibotRoot, "data"));
  await writeFile(join(paths.maibotRoot, "config", "bot_config.toml"), "source config");
  await writeFile(join(paths.maibotRoot, "data", "db"), "source data");
  await writeFile(join(paths.userDataRoot, "message-platform.json"), "launcher account settings");
  const gate = new RuntimeOperationLock();
  class LowSpaceManager extends ResourceLocationManager { protected async getAvailableBytes(): Promise<number> { return 0; } }
  const manager = lowSpace ? new LowSpaceManager(paths, true, gate) : new ResourceLocationManager(paths, true, gate);
  manager.acquireInitialLock(); fixtures.push({ root, manager });
  return { root, paths, manager, gate };
}
async function noStages(parent: string): Promise<void> {
  if (existsSync(parent)) expect((await readdir(parent)).filter((name) => name.startsWith(".maibot-migration-"))).toEqual([]);
}

for (const key of ["maibot", "napcat", "snowluma"] as const) {
  test(`${key} existing-directory selection validates the component and does not merge data`, async () => {
    const { root, paths, manager } = await fixture();
    const target = join(root, "existing"); await component(target, key);
    await writeFile(join(target, "custom.txt"), "existing instance");
    const before = await readFile(join(paths.userDataRoot, "message-platform.json"), "utf8");
    const plan = await manager.inspectPath(key, target, "existing");
    expect(plan.fileCount).toBe(0);
    const result = await manager.applyPlan(plan);
    expect(result.path).toBe(target); expect(result.copiedFiles).toBe(0);
    expect(await readFile(join(target, "custom.txt"), "utf8")).toBe("existing instance");
    expect(await readFile(join(paths.userDataRoot, "message-platform.json"), "utf8")).toBe(before);
    expect(existsSync(join(target, "message-platform.json"))).toBe(false);
  });
}

test("invalid, missing, relative and disk-root paths fail before creating or switching directories", async () => {
  const { root, paths, manager } = await fixture();
  const original = paths.maibotRoot, empty = join(root, "empty"); await mkdir(empty);
  await expect(manager.selectPath("maibot", empty)).rejects.toThrow("不是有效的");
  const missing = join(root, "missing"); await expect(manager.selectPath("maibot", missing)).rejects.toThrow("目录不存在");
  await expect(manager.selectPath("maibot", "relative-dir")).rejects.toThrow("绝对");
  await expect(manager.selectPath("maibot", resolve("/"))).rejects.toThrow("磁盘根目录");
  expect(paths.maibotRoot).toBe(original); expect(existsSync(missing)).toBe(false);
  expect(await readdir(empty)).toEqual([]); expect(existsSync(join(paths.userDataRoot, "resource-paths.json"))).toBe(false);
});

test("copy migration preflights data size, keeps the source and publishes a complete independent copy", async () => {
  const { root, paths, manager } = await fixture();
  const source = paths.maibotRoot, target = join(root, "copies", "MaiBot");
  const progress: ResourcePathProgress[] = []; manager.on("progress", (value) => progress.push(value));
  const plan = await manager.inspectPath("maibot", target, "copy");
  expect(plan.fileCount).toBe(4); expect(plan.totalBytes).toBeGreaterThan(0); expect(plan.availableBytes).toBeGreaterThan(plan.totalBytes);
  expect(existsSync(target)).toBe(false);
  const result = await manager.applyPlan(plan);
  expect(result.copiedFiles).toBe(4); expect(result.copiedBytes).toBe(plan.totalBytes); expect(paths.maibotRoot).toBe(target);
  expect(await readFile(join(source, "data", "db"), "utf8")).toBe("source data");
  expect(await readFile(join(target, "data", "db"), "utf8")).toBe("source data");
  await writeFile(join(target, "data", "db"), "target modified");
  expect(await readFile(join(source, "data", "db"), "utf8")).toBe("source data");
  expect(JSON.parse(await readFile(join(paths.userDataRoot, "resource-paths.json"), "utf8")).paths.maibot).toBe(target);
  expect(progress.some((value) => value.stage === "copying")).toBe(true); expect(progress.some((value) => value.stage === "committing")).toBe(true);
  expect(manager.getProgress()?.stage).toBe("completed"); await noStages(dirname(target));
});

test("nonempty migration targets are rejected without touching source or conflicting files", async () => {
  const { root, paths, manager } = await fixture(); const source = paths.maibotRoot;
  const target = join(root, "target"); await mkdir(target); await writeFile(join(target, "bot.py"), "target version");
  await expect(manager.migratePath("maibot", target)).rejects.toThrow("必须是空目录");
  expect(await readFile(join(target, "bot.py"), "utf8")).toBe("target version"); expect(paths.maibotRoot).toBe(source);
  await noStages(root);
});

test("source descendants, ancestors, other components and template aliases are rejected before mutation", async () => {
  const { paths, manager } = await fixture(); const target = join(paths.maibotRoot, "nested");
  for (const path of [target, dirname(paths.maibotRoot), paths.napcatRoot, paths.bundledModulesRoot, join(paths.bundledModulesRoot, "new")]) await expect(manager.migratePath("maibot", path)).rejects.toThrow();
  expect(existsSync(target)).toBe(false); expect(existsSync(join(paths.bundledModulesRoot, "new"))).toBe(false);
});

test("junction aliases cannot bypass source overlap checks, and copies reject linked content", async () => {
  const { root, paths, manager } = await fixture();
  const alias = join(root, "alias"); await symlink(paths.maibotRoot, alias, "junction");
  await expect(manager.migratePath("maibot", alias)).rejects.toThrow("相同");
  const linked = join(root, "linked"); await mkdir(linked); await symlink(linked, join(paths.maibotRoot, "linked-data"), "junction");
  await expect(manager.migratePath("maibot", join(root, "copy"))).rejects.toThrow("符号链接或目录联接");
  expect(existsSync(join(root, "copy"))).toBe(false);
});

test("insufficient target space fails during preflight without creating a target", async () => {
  const { root, manager } = await fixture(true); const target = join(root, "copy");
  await expect(manager.inspectPath("maibot", target, "copy")).rejects.toThrow("剩余空间不足");
  expect(existsSync(target)).toBe(false); await noStages(root);
});

test("changes after preflight require a new preview rather than silently copying new data", async () => {
  const { root, paths, manager } = await fixture(); const target = join(root, "copy");
  const plan = await manager.inspectPath("maibot", target, "copy");
  await writeFile(join(paths.maibotRoot, "new-file"), "changed after preview");
  await expect(manager.applyPlan(plan)).rejects.toThrow("重新检查"); expect(existsSync(target)).toBe(false);
});

test("cancelling preflight leaves source, target and settings unchanged", async () => {
  const { root, paths, manager } = await fixture(); const original = paths.maibotRoot;
  manager.on("progress", (value) => { if (value.stage === "checking") manager.cancelOperation(value.operationId); });
  await expect(manager.inspectPath("maibot", join(root, "copy"), "copy")).rejects.toThrow("已取消");
  expect(paths.maibotRoot).toBe(original); expect(existsSync(join(root, "copy"))).toBe(false); expect(manager.getProgress()?.stage).toBe("cancelled");
});

test("cancelling an in-progress file copy removes temporary data and newly created target parents", async () => {
  const { root, paths, manager } = await fixture(); const original = paths.maibotRoot;
  const file = await open(join(original, "data", "large.bin"), "w"); await file.truncate(32 * 1024 * 1024); await file.close();
  const target = join(root, "new-parent", "copy"); let timer: ReturnType<typeof setTimeout> | undefined, cancelled = false;
  const poll = () => {
    const value = manager.getProgress();
    if (value?.stage === "copying" && value.copiedBytes > 0) { cancelled = manager.cancelOperation(value.operationId); return; }
    if (!value || ["checking", "copying"].includes(value.stage)) timer = setTimeout(poll, 1);
  };
  const operation = manager.migratePath("maibot", target); poll();
  try { await expect(operation).rejects.toThrow("已取消"); } finally { if (timer) clearTimeout(timer); }
  expect(cancelled).toBe(true); expect(paths.maibotRoot).toBe(original); expect(existsSync(target)).toBe(false); expect(existsSync(dirname(target))).toBe(false);
  expect(existsSync(join(original, "data", "large.bin"))).toBe(true); await noStages(root);
});

test("commit failure restores both modern and legacy records, runtime paths and an existing empty target", async () => {
  const { root, paths, manager } = await fixture(); const source = paths.maibotRoot;
  const modern = join(paths.userDataRoot, "resource-paths.json"), legacy = join(paths.userDataRoot, "resource-location.json");
  const modernText = JSON.stringify({ version: 1, paths: { maibot: source } }), legacyText = '{"version":1,"resourceRoot":"legacy location"}';
  await writeFile(modern, modernText); await writeFile(legacy, legacyText);
  const target = join(root, "empty-target"); await mkdir(target); let applications = 0;
  manager.setApplyHandler(async () => { applications += 1; if (applications === 1) throw new Error("injected runtime refresh failure"); });
  await expect(manager.migratePath("maibot", target)).rejects.toThrow("injected runtime refresh failure");
  expect(paths.maibotRoot).toBe(source); expect(await readFile(modern, "utf8")).toBe(modernText); expect(await readFile(legacy, "utf8")).toBe(legacyText);
  expect(await readdir(target)).toEqual([]); expect(applications).toBe(2); expect(manager.getProgress()?.stage).toBe("failed"); await noStages(root);
});

test("switching back to the default directory atomically records defaults and retires legacy settings", async () => {
  const { root, paths, manager } = await fixture(); const original = paths.maibotRoot;
  const target = join(root, "existing"); await component(target, "maibot"); await manager.selectPath("maibot", target);
  await writeFile(join(paths.userDataRoot, "resource-location.json"), '{"version":1}');
  const plan = await manager.inspectPath("maibot", original, "existing"); await manager.applyPlan(plan);
  expect(paths.maibotRoot).toBe(original); expect(JSON.parse(await readFile(join(paths.userDataRoot, "resource-paths.json"), "utf8")).paths).toEqual({});
  expect(existsSync(join(paths.userDataRoot, "resource-location.json"))).toBe(false);
});

test("SnowLuma copies omit account-specific generated launch code and reacquire their own directory lock", async () => {
  const { root, paths, manager } = await fixture();
  await writeFile(join(paths.snowlumaRoot, ".maibot-target-runtime.mjs"), "old generated account code");
  const target = join(root, "SnowLuma-copy"); await manager.migratePath("snowluma", target);
  expect(existsSync(join(target, ".maibot-target-runtime.mjs"))).toBe(false);
  expect(JSON.parse(await readFile(join(target, "resource.lock"), "utf8")).path).toBe(target);
  expect(existsSync(join(paths.defaultSnowlumaRoot, "resource.lock"))).toBe(false);
});

test("one operation lock blocks concurrent path requests, service starts and config writes", async () => {
  const { root, manager, gate } = await fixture(); let finish!: () => void;
  const pending = manager.withPathOperation(() => new Promise<void>((resolve) => { finish = resolve; }));
  try {
    await expect(manager.inspectPath("maibot", join(root, "copy"), "copy")).rejects.toThrow("另一个");
    await expect(gate.serviceStart(async () => undefined)).rejects.toThrow("目录");
    await expect(manager.withRuntimeActivity(async () => undefined)).rejects.toThrow("目录");
  } finally { finish(); await pending; }
  expect(gate.label).toBeNull();
});

test("in-flight service startup and configuration writes prevent path operations before any await", async () => {
  const { root, manager, gate } = await fixture();
  for (const run of [gate.serviceStart.bind(gate), gate.shared.bind(gate)]) {
    let finish!: () => void; const pending = run(() => new Promise<void>((resolve) => { finish = resolve; }));
    try { await expect(manager.inspectPath("maibot", join(root, "copy"), "copy")).rejects.toThrow("正在进行"); }
    finally { finish(); await pending; }
  }
});

test("nested operations retain their exclusive owner without allowing independent IPC work", async () => {
  const { manager, gate } = await fixture();
  await manager.withPathOperation(async () => {
    await manager.withPathOperation(async () => { expect(gate.label).not.toBeNull(); });
    expect(gate.label).not.toBeNull();
  });
  expect(gate.label).toBeNull();
});

test("a target populated after preview is rejected before any copy or configuration change", async () => {
  const { root, paths, manager } = await fixture(); const original = paths.maibotRoot, target = join(root, "copy");
  const plan = await manager.inspectPath("maibot", target, "copy");
  await mkdir(target); await writeFile(join(target, "user-file"), "preserve this file");
  await expect(manager.applyPlan(plan)).rejects.toThrow("必须是空目录");
  expect(paths.maibotRoot).toBe(original); expect(await readFile(join(target, "user-file"), "utf8")).toBe("preserve this file"); await noStages(root);
});

test("other live processes retain their directory locks", async () => {
  const { root, paths, manager } = await fixture(); const target = join(root, "existing"); await component(target, "maibot");
  const lock = join(target, "resource.lock"), content = JSON.stringify({ pid: process.ppid, key: "maibot", path: target });
  await writeFile(lock, content);
  await expect(manager.selectPath("maibot", target)).rejects.toThrow("另一个启动器");
  expect(await readFile(lock, "utf8")).toBe(content); expect(paths.maibotRoot).toBe(paths.defaultMaibotRoot);
});

test("rollback failures preserve the destination copy and are reported as errors, not cancellation", async () => {
  const { root, paths, manager } = await fixture(); const source = paths.maibotRoot, target = join(root, "copy");
  manager.setApplyHandler(async () => { throw new Error("runtime cannot refresh"); });
  await expect(manager.migratePath("maibot", target)).rejects.toThrow("已保留原目录");
  expect(paths.maibotRoot).toBe(source); expect(await readFile(join(source, "data", "db"), "utf8")).toBe("source data");
  expect(await readFile(join(target, "data", "db"), "utf8")).toBe("source data"); expect(manager.getProgress()?.stage).toBe("failed");
});

test("quitting waits for cancellation and cleanup of the current copy", async () => {
  const { root, paths, manager } = await fixture(); const original = paths.maibotRoot, target = join(root, "copy");
  let quitting: Promise<void> | undefined;
  manager.on("progress", (value) => { if (value.stage === "copying") quitting = manager.finishBeforeQuit(); });
  await expect(manager.migratePath("maibot", target)).rejects.toThrow("已取消");
  await quitting; expect(manager.getOperationLabel()).toBeNull(); expect(paths.maibotRoot).toBe(original); expect(existsSync(target)).toBe(false); await noStages(root);
});

test("actual single-service and start-all entry points respect the same directory lock", async () => {
  const { paths, manager, gate } = await fixture();
  const init = new InitManager(paths), pty = Object.assign(new EventEmitter(), { list: () => [] });
  const services = new ServiceManager(paths, init, { append() {}, getServiceLogPath: (id: string) => join(paths.logsRoot, `${id}.log`) } as any, pty as any, undefined, gate);
  try {
    await manager.withPathOperation(async () => {
      await expect(services.start("maibot")).rejects.toThrow("目录");
      await expect(services.startAll()).rejects.toThrow("目录");
      expect(services.snapshot().every((service) => service.status === "stopped")).toBe(true);
    });
  } finally { services.dispose(); }
});

test("service startup blocks directory operations even before starting state is published", async () => {
  const { root, paths, manager, gate } = await fixture();
  const init = new InitManager(paths); let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  init.assertAgreementsConfirmed = async () => { await waiting; throw new Error("end test startup"); };
  const pty = Object.assign(new EventEmitter(), { list: () => [] });
  const services = new ServiceManager(paths, init, { append() {}, getServiceLogPath: (id: string) => join(paths.logsRoot, `${id}.log`) } as any, pty as any, undefined, gate);
  const startup = services.start("maibot"); void startup.catch(() => {});
  try {
    expect(services.snapshot().every((service) => service.status === "stopped")).toBe(true);
    await expect(manager.migratePath("maibot", join(root, "copy"))).rejects.toThrow("正在进行");
    expect(existsSync(join(root, "copy"))).toBe(false);
  } finally {
    finish(); await expect(startup).rejects.toThrow("end test startup"); services.dispose();
  }
});
