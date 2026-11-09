import { expect, test } from "bun:test";
import type { LogEntry } from "../../../src/shared/contracts";
import { settingsLogMessage, settingsLogs } from "../../../src/renderer/src/lib/settings-logs";

test("settings logs remove terminal escapes and retain Chinese and paths", () => {
  expect(settingsLogMessage("\x1b[31m错误\x1b[0m：C:\\MaiBot\\日志.txt\x1b[K\r\n下一行"))
    .toBe("错误：C:\\MaiBot\\日志.txt\n下一行");
  expect(settingsLogMessage("\x1b]0;终端标题\x07\x1b]8;;https://example.com\x1b\\链接\x1b]8;;\x1b\\"))
    .toBe("链接");
  expect(settingsLogMessage("\x9b33m警告\x9b0m\x00")).toBe("警告");
});

test("settings logs filter services before limiting launcher entries, newest first", () => {
  const entries: LogEntry[] = Array.from({ length: 90 }, (_, index) => ({
    id: String(index), source: "desktop", stream: "system", message: `启动器 ${index}`, timestamp: index,
  }));
  entries.push(...Array.from({ length: 100 }, (_, index): LogEntry => ({
    id: `service-${index}`, source: index % 2 ? "maibot" : "napcat", stream: "stdout", message: "服务日志", timestamp: index + 90,
  })));
  const result = settingsLogs(entries);
  expect(result).toHaveLength(80);
  expect(result[0].id).toBe("89");
  expect(result.at(-1)?.id).toBe("10");
  expect(entries).toHaveLength(190);
  expect(settingsLogs(entries.slice(90))).toEqual([]);
});
