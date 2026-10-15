import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { FileMatcher } from "app-builder-lib/out/fileMatcher";
import { createFilter } from "app-builder-lib/out/util/filter";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
test("packaging excludes the generated SnowLuma account entry and runtime data", () => {
  const mapping = pkg.build.extraResources.find((resource: { from: string }) => resource.from === "modules");
  const root = resolve("modules");
  const matcher = new FileMatcher(root, resolve("output/modules"), (value: string) => value, mapping.filter);
  const patterns: any[] = [];
  matcher.computeParsedPatterns(patterns);
  const filter = createFilter(root, patterns);
  const stat = { isDirectory: () => false } as any;
  expect(filter(join(root, "SnowLuma/index.mjs"), stat)).toBe(true);
  expect(filter(join(root, "SnowLuma/node.exe"), stat)).toBe(true);
  for (const file of ["SnowLuma/.maibot-target-runtime.mjs", "SnowLuma/config/runtime.json", "SnowLuma/data/account.db", "SnowLuma/logs/runtime.log", "napcat/index.js"]) {
    expect(filter(join(root, file), stat)).toBe(false);
  }
  for (const file of ["MaiBot/bot.py", "MaiBot/src/runtime.py", "MaiBot/.onekey-deployment.json", "MaiBot/.onekey/environments/test/python.exe"]) {
    expect(filter(join(root, file), stat)).toBe(false);
  }
});
test("installer and uninstaller share the same sidebar resource", () => {
  expect(pkg.build.nsis.uninstallerSidebar).toBe(pkg.build.nsis.installerSidebar);
  expect(readFileSync(resolve(pkg.build.nsis.installerSidebar)).length).toBeGreaterThan(0);
});
