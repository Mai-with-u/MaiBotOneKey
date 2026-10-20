import { expect, test } from "bun:test";
import { isWindowsLongPathError } from "../../src/shared/windows-long-path";
import { explainMaiBotUpdateError } from "../../src/shared/maibot-update-error";

test("long path repair requires specific evidence rather than an arbitrary missing file", () => {
  expect(isWindowsLongPathError(new Error("OSError: [Errno 2] No such file or directory; HINT: This error might have occurred since this system does not have Windows Long Path support enabled."))).toBe(true);
  expect(isWindowsLongPathError("https://pip.pypa.io/warnings/enable-long-paths")).toBe(true);
  expect(isWindowsLongPathError("[WinError 206] The filename or extension is too long")).toBe(true);
  expect(isWindowsLongPathError("ENOENT: no such file or directory python.exe")).toBe(false);
  expect(isWindowsLongPathError("EPERM: unlink python.exe")).toBe(false);
  expect(explainMaiBotUpdateError("HINT: Windows Long Path support is not enabled")).toContain("更换 Python 包源无法解决");
});
