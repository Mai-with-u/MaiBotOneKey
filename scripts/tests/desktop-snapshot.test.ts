import { expect, test } from "bun:test";
import { getDesktopSnapshot, validateDesktopSnapshot } from "../../src/renderer/src/lib/desktop-api";
import { createPreviewSnapshot } from "../../src/renderer/src/lib/desktop-preview";

test("complete snapshots retain their version, paths and unconfirmed agreements", () => {
  const snapshot = createPreviewSnapshot();
  snapshot.appVersion = "0.6.1";
  snapshot.startupAgreement.isConfirmed = false;
  expect(validateDesktopSnapshot(snapshot)).toBe(snapshot);
  expect(validateDesktopSnapshot(snapshot).startupAgreement.isConfirmed).toBe(false);
});
test("incomplete production snapshots fail instead of receiving preview defaults", () => {
  const snapshot = createPreviewSnapshot();
  for (const field of ["paths", "initState", "startupAgreement", "services", "appVersion"] as const) {
    const partial = { ...snapshot } as any;
    delete partial[field];
    expect(() => validateDesktopSnapshot(partial)).toThrow();
  }
  expect(() => validateDesktopSnapshot(null)).toThrow();
  expect(() => validateDesktopSnapshot({ ...snapshot, startupAgreement: {} })).toThrow("启动协议状态格式错误");
});

test("production snapshot read failures propagate without fabricating preview state", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { maibotDesktop: { getSnapshot: async () => { throw new Error("IPC failed"); } } } });
  try {
    await expect(getDesktopSnapshot()).rejects.toThrow("IPC failed");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
