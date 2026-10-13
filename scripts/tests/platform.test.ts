import { expect, test } from "bun:test";
import { getPlatform } from "../../src/renderer/src/lib/platform";

test("native platform wins over browser detection without requesting a desktop snapshot", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let requests = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { maibotDesktop: {
    platform: "darwin", getSnapshot: () => { requests++; throw new Error("Unexpected snapshot request"); },
  } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "Win32", userAgent: "Windows" } });
  try {
    expect(getPlatform()).toBe("darwin");
    expect(requests).toBe(0);
    (window as any).maibotDesktop = undefined;
    expect(getPlatform()).toBe("win32");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
