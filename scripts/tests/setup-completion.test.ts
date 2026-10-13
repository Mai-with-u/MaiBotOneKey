import { expect, test } from "bun:test";
import { watchSetupCompletion } from "../../src/renderer/src/lib/setup-completion";

test("setup watcher waits through pending and failures, then completes exactly once", async () => {
  let reads = 0;
  let completions = 0;
  let resolve!: () => void;
  const done = new Promise<void>((next) => { resolve = next; });
  const stop = watchSetupCompletion(async () => {
    reads++;
    if (reads === 1) return "pending";
    if (reads === 2) throw new Error("token is rotating");
    return "complete";
  }, () => { completions++; resolve(); }, 1);
  try {
    await done;
    await Bun.sleep(10);
    expect(reads).toBe(3);
    expect(completions).toBe(1);
  } finally { stop(); }
});

test("unmount cancels polling and ignores a late completion response", async () => {
  let resolve!: (value: "complete") => void;
  let completions = 0;
  let reads = 0;
  const response = new Promise<"complete">((next) => { resolve = next; });
  const stop = watchSetupCompletion(() => { reads++; return response; }, () => { completions++; }, 1);
  stop();
  resolve("complete");
  await Bun.sleep(10);
  expect(reads).toBe(1);
  expect(completions).toBe(0);
});

test("already configured instances finish immediately and slow requests never overlap", async () => {
  let active = 0;
  let maxActive = 0;
  let reads = 0;
  let resolve!: () => void;
  const done = new Promise<void>((next) => { resolve = next; });
  const stop = watchSetupCompletion(async () => {
    active++; maxActive = Math.max(active, maxActive);
    await Bun.sleep(5);
    active--; reads++;
    return reads === 2 ? "complete" : "pending";
  }, resolve, 1);
  try { await done; expect(maxActive).toBe(1); expect(reads).toBe(2); } finally { stop(); }
  let completions = 0;
  const stopConfigured = watchSetupCompletion(async () => "complete", () => { completions++; });
  await Bun.sleep(1);
  expect(completions).toBe(1);
  stopConfigured();
});
