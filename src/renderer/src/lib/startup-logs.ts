import type { LogEntry } from "@shared/contracts";

// Core output and lifecycle messages explain failures after dependency setup.
// Keep all streams so Python tracebacks are not hidden by preparation filters.
export function startupLogs(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.source === "maibot").slice(-200);
}
