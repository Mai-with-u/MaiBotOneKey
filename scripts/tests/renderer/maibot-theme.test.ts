import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { parseMaiBotTheme, READ_MAIBOT_THEME_SCRIPT, resolveMaiBotTheme } from "../../../src/renderer/src/lib/maibot-theme";

test("theme reader follows live Dashboard style and resolved dark mode", () => {
  const read = (style: string | undefined, stored: string | null, dark: boolean, preference: string | null = null) => runInNewContext(READ_MAIBOT_THEME_SCRIPT, {
    document: { documentElement: { dataset: { dashboardStyle: style }, classList: { contains: (name: string) => name === "dark" && dark } } },
    localStorage: { getItem: (key: string) => key === "maibot-theme-dashboard-style" ? stored : key === "maibot-theme-mode" ? preference : null },
  });
  expect(parseMaiBotTheme(read("millennium", "modern", true, "system"))).toEqual({ mode: "millennium", dark: true, preference: "system" });
  expect(parseMaiBotTheme(read("future-retro", null, false, "light"))).toEqual({ mode: "future-retro", dark: false, preference: "light" });
  expect(parseMaiBotTheme(read(undefined, "modern", true, "dark"))).toEqual({ mode: "modern", dark: true, preference: "dark" });
  expect(parseMaiBotTheme(read(undefined, null, false))).toBeUndefined();
});

test("cached automatic mode follows current system colors instead of the last resolved color", () => {
  const cached = parseMaiBotTheme({ mode: "modern", dark: true, preference: "system" })!;
  expect(resolveMaiBotTheme(cached, "light")).toBe("light");
  expect(resolveMaiBotTheme(cached, "dark")).toBe("dark");
  for (const preference of ["light", "dark"] as const) {
    const fixed = { ...cached, preference };
    expect(resolveMaiBotTheme(fixed, "light")).toBe(preference);
    expect(resolveMaiBotTheme(fixed, "dark")).toBe(preference);
  }
});

test("old caches without a preference use automatic colors until WebUI is read again", () => {
  const cached = parseMaiBotTheme({ mode: "millennium", dark: true })!;
  expect(cached.preference).toBe("system");
  expect(resolveMaiBotTheme(cached, "light")).toBe("light");
});

test("unsupported or malformed theme data cannot change launcher appearance", () => {
  for (const value of [null, {}, { mode: "custom", dark: true }, { mode: "modern", dark: "false" }]) {
    expect(parseMaiBotTheme(value)).toBeUndefined();
  }
});
