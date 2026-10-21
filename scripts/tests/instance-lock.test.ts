import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireInstallInstanceLock } from "../../src/main/services/instance-lock";
import { isLockOwnerAlive } from "../../src/main/services/lock-owner";
import type { RuntimePaths } from "../../src/shared/contracts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), "maibot-instance-lock-test-"))) throw new Error("Unexpected cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "maibot-instance-lock-test-"));
  roots.push(root);
  return { paths: { userDataRoot: root, installRoot: root } as RuntimePaths, lockPath: join(root, "instance.lock") };
}

test("a forcibly terminated lock owner does not prevent the next launch", async () => {
  const { paths, lockPath } = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await once(child, "spawn");
    writeFileSync(lockPath, JSON.stringify({ pid: child.pid, installRoot: paths.installRoot, startedAt: Date.now() }));
    expect(acquireInstallInstanceLock(paths).acquired).toBe(false);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const lock = acquireInstallInstanceLock(paths);
    expect(lock.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    lock.release();
  } finally { child.kill(); }
});

test("invalid PID values never probe process groups", () => {
  for (const pid of [-1, 0, 1.5, NaN, Infinity]) expect(isLockOwnerAlive({ pid })).toBe(false);
});

test("an interrupted empty lock write is recovered", () => {
  const { paths, lockPath } = fixture();
  writeFileSync(lockPath, "");
  const lock = acquireInstallInstanceLock(paths);
  expect(lock.acquired).toBe(true);
  lock.release();
});

test.skipIf(process.platform !== "win32")("a reused Windows PID does not keep an old lock alive", () => {
  // The parent exists, but started after this deliberately old lock timestamp.
  expect(isLockOwnerAlive({ pid: process.ppid, startedAt: 1 })).toBe(false);
  expect(isLockOwnerAlive({ pid: process.ppid, startedAt: Date.now() })).toBe(true);
});
