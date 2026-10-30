import type { LogEntry } from "@shared/contracts";

export { plainLogMessage as settingsLogMessage } from "@shared/plain-log-message";

export function settingsLogs(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.source === "desktop").slice(-80).reverse();
}
