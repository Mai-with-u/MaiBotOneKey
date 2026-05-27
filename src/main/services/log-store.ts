import { EventEmitter } from "node:events";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry, LogSource, LogStream, RuntimePaths } from "../../shared/contracts";

const MAX_BUFFERED_LOGS = 1000;
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LOG_FILE_BACKUPS = 5;

function formatLogLine(entry: LogEntry): string {
  const timestamp = new Date(entry.timestamp).toISOString();
  return `[${timestamp}] [${entry.stream}] ${entry.message}\n`;
}

export class LogStore extends EventEmitter {
  private readonly entries: LogEntry[] = [];
  private writeQueue = Promise.resolve();

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
    const line = formatLogLine(entry);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.writeLine(entry.source, line))
      .catch(() => undefined);
  }

  private async writeLine(source: LogSource, line: string): Promise<void> {
    await mkdir(this.paths.logsRoot, { recursive: true });

    const logPath = this.getServiceLogPath(source);
    await this.rotateLogFileIfNeeded(logPath, Buffer.byteLength(line, "utf8"));
    await appendFile(logPath, line, "utf8");
  }

  private async rotateLogFileIfNeeded(logPath: string, incomingBytes: number): Promise<void> {
    const currentSize = await this.getFileSize(logPath);
    if (currentSize <= 0 || currentSize + incomingBytes <= MAX_LOG_FILE_BYTES) {
      return;
    }

    await rm(`${logPath}.${MAX_LOG_FILE_BACKUPS}`, { force: true });
    for (let index = MAX_LOG_FILE_BACKUPS - 1; index >= 1; index -= 1) {
      await this.renameIfExists(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    }
    await this.renameIfExists(logPath, `${logPath}.1`);
  }

  private async getFileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  private async renameIfExists(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch {
      // Missing or locked old log files should not block new logs from being written.
    }
  }
}
