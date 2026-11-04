import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeStartupFailure, writeStartupFailureLog } from "../../src/main/services/startup-failure";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), "maibot-startup-failure-test-"))) throw new Error("Unexpected cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "maibot-startup-failure-test-"));
  roots.push(root);
  return root;
}

test("permission failures explain the affected path and recovery without claiming a specific cause", () => {
  for (const code of ["EPERM", "EACCES"]) {
    const path = "C:\\Users\\user\\AppData\\Roaming\\MaiBotOneKeyDesktop\\launcher\\registry-write.lock";
    const result = describeStartupFailure(Object.assign(new Error("access denied"), { code, path }));
    expect(result.title).toContain("无法访问");
    expect(result.message).toContain(path);
    expect(result.message).toContain("仅凭此错误无法确定");
    expect(result.message).toContain("属性 → 安全");
    expect(result.message).toContain("请勿直接删除");
  }
});

test("other startup errors retain their original explanation", () => {
  for (const error of [new Error("实例索引正被其他启动器修改"), "启动器已在运行", null]) {
    expect(describeStartupFailure(error)).toEqual({
      title: "MaiBot OneKey 启动失败",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

test("an unwritable primary log location falls back and preserves the original stack", () => {
  const root = fixture();
  const primary = join(root, "blocked");
  writeFileSync(primary, "not a directory");
  const fallback = join(root, "fallback");
  const error = Object.assign(new Error("permission denied for registry"), { code: "EPERM" });
  const result = writeStartupFailureLog(error, [primary, fallback]);
  expect(result).toContain("备用位置");
  expect(result).toContain(join(fallback, "desktop.log"));
  const log = readFileSync(join(fallback, "desktop.log"), "utf8");
  expect(log).toContain(error.stack!);
  expect(log).toContain(primary);
});

test("normal logging succeeds without creating fallback logs", () => {
  const root = fixture();
  const result = writeStartupFailureLog("startup failed", [root]);
  expect(result).toBe(`诊断日志：${join(root, "desktop.log")}`);
  expect(readFileSync(join(root, "desktop.log"), "utf8")).toContain("startup failed");
});

test("failure of every log destination returns a screenshot hint instead of throwing", () => {
  const root = fixture();
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "not a directory");
  expect(writeStartupFailureLog(new Error("original failure"), [blocked, blocked])).toContain("可截图");
});
