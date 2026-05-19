import { EventEmitter } from "node:events";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry, LogSource, LogStream, RuntimePaths } from "../../shared/contracts";

const MAX_BUFFERED_LOGS = 1000;

function formatLogLine(entry: LogEntry): string {
  const timestamp = new Date(entry.timestamp).toISOString();
  return `[${timestamp}] [${entry.stream}] ${entry.message}\n`;
}

export class LogStore extends EventEmitter {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly paths: RuntimePaths) {
    super();
  }

  append(source: LogSource, stream: LogStream, message: string): LogEntry {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      source,
      stream,
      message: message.replace(/\r?\n$/, ""),
      timestamp: Date.now(),
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_BUFFERED_LOGS) {
      this.entries.splice(0, this.entries.length - MAX_BUFFERED_LOGS);
    }

    this.writeEntry(entry);
    this.emit("entry", entry);
    return entry;
  }

  list(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }

  getServiceLogPath(source: LogSource): string {
    return join(this.paths.logsRoot, `${source}.log`);
  }

  onEntry(callback: (entry: LogEntry) => void): () => void {
    this.on("entry", callback);
    return () => this.off("entry", callback);
  }

  private writeEntry(entry: LogEntry): void {
    void mkdir(this.paths.logsRoot, { recursive: true })
      .then(() => appendFile(this.getServiceLogPath(entry.source), formatLogLine(entry), "utf8"))
      .catch(() => undefined);
  }
}
