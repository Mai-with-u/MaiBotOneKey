import { expect, test } from "bun:test";
import { startupLogs } from "../../src/renderer/src/lib/startup-logs";
import type { LogEntry } from "../../src/shared/contracts";

test("startup logs retain failures after successful dependency preparation", () => {
  const entries: LogEntry[] = [
    { id: "1", source: "maibot", stream: "system", message: "startup dependency upgrade completed", timestamp: 1 },
    { id: "2", source: "maibot", stream: "stdout", message: "Traceback (most recent call last):", timestamp: 2 },
    { id: "3", source: "maibot", stream: "stderr", message: "ModuleNotFoundError: example", timestamp: 3 },
    { id: "4", source: "maibot", stream: "system", message: "exit: code=1 signal=null", timestamp: 4 },
    { id: "5", source: "desktop", stream: "system", message: "unrelated", timestamp: 5 },
  ];
  expect(startupLogs(entries)).toEqual(entries.slice(0, 4));
});

test("startup logs keep the latest 200 MaiBot entries in order", () => {
  const entries: LogEntry[] = Array.from({ length: 210 }, (_, i) => ({
    id: String(i), source: "maibot", stream: "stdout", message: String(i), timestamp: i,
  }));
  expect(startupLogs(entries)).toEqual(entries.slice(10));
  expect(startupLogs([])).toEqual([]);
});
