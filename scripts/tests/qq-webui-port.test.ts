import { afterEach, expect, test } from "bun:test";
import { readQqWebuiPort, qqWebuiPortStorageKey } from "../../src/renderer/src/lib/qq-webui-port";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
test("WebUI follows the configured service port unless the user saved an override", () => {
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null } });
  expect(readQqWebuiPort("snowluma", "http://127.0.0.1:15099/")).toBe("15099");
  saved.set(qqWebuiPortStorageKey("snowluma"), "25099");
  expect(readQqWebuiPort("snowluma", "http://127.0.0.1:15099/")).toBe("25099");
  saved.set(qqWebuiPortStorageKey("snowluma"), "invalid");
  expect(readQqWebuiPort("snowluma", "http://127.0.0.1:15099/")).toBe("15099");
});
test("storage failure still permits use of the configured service endpoint", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("storage disabled"); } });
  expect(readQqWebuiPort("snowluma", "http://127.0.0.1:15099/")).toBe("15099");
  expect(readQqWebuiPort("snowluma")).toBe("5099");
});
