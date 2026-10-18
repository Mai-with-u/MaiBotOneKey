import { expect, test } from "bun:test";
import { transitionStartupScene } from "../../src/renderer/src/lib/startup-transition";

test("startup confirmation runs directly when animation is unavailable or reduced", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    let updates = 0;
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
    await transitionStartupScene(async () => { updates++; });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { startViewTransition: () => { throw new Error("must skip motion"); } } });
    await transitionStartupScene(async () => { updates++; });
    expect(updates).toBe(2);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("confirmation failures propagate while interrupted animations do not fail confirmation", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      startViewTransition: (update: () => Promise<void>) => ({
        ready: Promise.reject(new Error("animation interrupted")),
        finished: Promise.reject(new Error("animation interrupted")),
        updateCallbackDone: Promise.resolve().then(update),
      }),
    } });
    let committed = false;
    await transitionStartupScene(async () => { committed = true; });
    expect(committed).toBe(true);
    await expect(transitionStartupScene(async () => { throw new Error("confirmation failed"); })).rejects.toThrow("confirmation failed");
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("a fast homepage waits for the preceding startup shape change to finish", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let captures = 0;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      startViewTransition: (update: () => Promise<void>) => {
        captures++;
        return { ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve().then(update) };
      },
    } });
    await transitionStartupScene(async () => undefined);
    let homepageVisible = false;
    const homepage = transitionStartupScene(async () => { homepageVisible = true; });
    expect(captures).toBe(1);
    expect(homepageVisible).toBe(false);
    finish();
    await homepage;
    expect(captures).toBe(2);
    expect(homepageVisible).toBe(true);
  } finally {
    finish();
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});
