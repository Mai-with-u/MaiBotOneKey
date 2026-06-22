import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type {
  AgreementDocument,
  AgreementDocumentId,
  InitCheck,
  InitRepairResult,
  InitState,
  MaiBotBackupExportResult,
  MaiBotBackupImportResult,
  MaiBotBackupManifest,
  MaiBotBackupProgress,
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  MaiBotStorageCategory,
  MaiBotStorageCleanupResult,
  MaiBotStorageCleanupTarget,
  MaiBotStorageStats,
  NapcatAdapterChatConfig,
  NapcatAdapterConfig,
  NapcatChatListMode,
  QqComponentUpgradeEntry,
  QqComponentUpgradeId,
  QqComponentUpgradeResult,
  QqBackend,
  RuntimePaths,
  RuntimePathKey,
  PythonRuntimeCandidate,
  ServiceId,
  SnowLumaResetResult,
  StartupAgreementConfirmResult,
  StartupAgreementState,
} from "../../shared/contracts";

const QQ_PATTERN = /qq_account\s*=\s*["']?(\d+)["']?/;
const QQ_ACCOUNT_ASSIGNMENT_PATTERN = /^(\s*qq_account\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^#\r\n]*?)(\s*#.*)?$/mu;
const UNCONFIGURED_QQ_ACCOUNTS = new Set(["0"]);
const DEPENDENCY_CACHE_MS = 15_000;
const PYTHON_RUNTIME_DIR = "python";
const GIT_RUNTIME_DIR = "git";
const PYTHON_MINIMUM_VERSION = "3.12";
const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/windows/";
const GIT_DOWNLOAD_URL = "https://git-scm.com/download/win";
const MAIBOT_FALLBACK_CONFIG_VERSION = "8.10.22";
const MAIBOT_WEBUI_FALLBACK_HOST = "127.0.0.1";
const MAIBOT_WEBUI_FALLBACK_PORT = 8001;
const QQ_BACKEND_FILE = "qq-backend.json";
const MESSAGE_PLATFORM_FILE = "message-platform.json";
const RUNTIME_PATH_CONFIG_FILE = "runtime-paths.json";
const PYTHON_OVERRIDES_IGNORED_ENTRIES = new Set([".keep", "resource.lock"]);
const NAPCAT_COMPONENT_PROTECTED_PATHS = [
  "config",
  "data",
  "logs",
  "napcat/config",
  "napcat/data",
  "napcat/logs",
];

interface StoredRuntimePathFile {
  version: 1;
  paths?: Partial<Record<RuntimePathKey, string>>;
}
const SNOWLUMA_COMPONENT_PROTECTED_PATHS = ["config", "data", "logs"];
const NAPCAT_VERSION_CONFIG_PATTERN = /^versions\/[^/]+\/resources\/app\/napcat\/config(?:\/|$)/iu;
const COMPONENT_DATA_FILE_PATTERN = /(?:\.db|\.sqlite|\.sqlite3)(?:-(?:shm|wal))?$/iu;
const COMPONENT_LOG_FILE_PATTERN = /\.log$/iu;
const MAIBOT_BACKUP_FORMAT = "maibot-onekey-backup" as const;
const MAIBOT_BACKUP_FORMAT_VERSION = 1 as const;
const TAR_BLOCK_SIZE = 512;

function uniqueExistingPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const existing: string[] = [];

  for (const path of paths) {
    const normalized = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(normalized) || !existsSync(path)) {
      continue;
    }
    seen.add(normalized);
    existing.push(path);
  }

  return existing;
}

function readRuntimePathOverride(paths: RuntimePaths, key: RuntimePathKey): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(paths.userDataRoot, RUNTIME_PATH_CONFIG_FILE), "utf8")) as StoredRuntimePathFile;
    const value = raw.paths?.[key]?.trim();
    return value ? resolve(value) : undefined;
  } catch {
    return undefined;
  }
}

function uniquePythonCandidates(candidates: PythonRuntimeCandidate[]): PythonRuntimeCandidate[] {
  const seen = new Set<string>();
  const unique: PythonRuntimeCandidate[] = [];

  for (const candidate of candidates) {
    if (isWindowsAppsPythonAlias(candidate.path)) {
      continue;
    }
    const normalized = normalizePathForCompare(candidate.path);
    if (seen.has(normalized) || !existsSync(candidate.path)) {
      continue;
    }
    seen.add(normalized);
    unique.push(candidate);
  }

  return unique;
}

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function sameOrInsidePath(parent: string, child: string): boolean {
  if (samePath(parent, child)) {
    return true;
  }
  const diff = relative(resolve(parent), resolve(child));
  return Boolean(diff) && diff !== ".." && !diff.startsWith(`..${sep}`);
}

interface StorageStatSummary {
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  latestModifiedAt?: number;
}

type MaiBotBackupProgressCallback = (progress: MaiBotBackupProgress) => void;

const emptyStorageStat: StorageStatSummary = {
  exists: false,
  sizeBytes: 0,
  fileCount: 0,
  directoryCount: 0,
};

function clampProgressPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function progressInRange(start: number, end: number, processed: number, total: number): number {
  if (total <= 0) {
    return start;
  }
  return clampProgressPercent(start + ((end - start) * processed) / total);
}

function emitMaiBotBackupProgress(
  onProgress: MaiBotBackupProgressCallback | undefined,
  progress: Omit<MaiBotBackupProgress, "timestamp">,
): void {
  onProgress?.({
    ...progress,
    percent: clampProgressPercent(progress.percent),
    timestamp: Date.now(),
  });
}

function createMaiBotBackupAbortError(): Error {
  const error = new Error("操作已取消");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function assertMaiBotBackupNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createMaiBotBackupAbortError();
  }
}

function normalizeMaiBotBackupIoError(error: unknown): Error {
  if (isAbortError(error)) {
    return error;
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOSPC") {
    return new Error("磁盘空间不足，迁移操作已失败。");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function mergeStorageStats(stats: StorageStatSummary[]): StorageStatSummary {
  return stats.reduce<StorageStatSummary>(
    (merged, item) => ({
      exists: merged.exists || item.exists,
      sizeBytes: merged.sizeBytes + item.sizeBytes,
      fileCount: merged.fileCount + item.fileCount,
      directoryCount: merged.directoryCount + item.directoryCount,
      latestModifiedAt: Math.max(merged.latestModifiedAt ?? 0, item.latestModifiedAt ?? 0) || undefined,
    }),
    { ...emptyStorageStat },
  );
}

async function readStorageStats(targetPath: string): Promise<StorageStatSummary> {
  if (!existsSync(targetPath)) {
    return { ...emptyStorageStat };
  }

  const targetStat = await stat(targetPath);
  const latestModifiedAt = targetStat.mtimeMs;
  if (!targetStat.isDirectory()) {
    return {
      exists: true,
      sizeBytes: targetStat.size,
      fileCount: targetStat.isFile() ? 1 : 0,
      directoryCount: 0,
      latestModifiedAt,
    };
  }

  const children = await readdir(targetPath, { withFileTypes: true });
  const childStats = await Promise.all(
    children.map(async (entry) => readStorageStats(join(targetPath, entry.name))),
  );
  const mergedChildren = mergeStorageStats(childStats);
  return {
    exists: true,
    sizeBytes: mergedChildren.sizeBytes,
    fileCount: mergedChildren.fileCount,
    directoryCount: mergedChildren.directoryCount + 1,
    latestModifiedAt: Math.max(latestModifiedAt, mergedChildren.latestModifiedAt ?? 0) || latestModifiedAt,
  };
}

function backupManifestPathInfo(stats: StorageStatSummary): MaiBotBackupManifest["paths"]["data"] {
  return {
    exists: stats.exists,
    sizeBytes: stats.sizeBytes,
    fileCount: stats.fileCount,
    directoryCount: stats.directoryCount,
  };
}

function tarPaddingSize(size: number): number {
  return (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  encoded.copy(buffer, offset, 0, Math.min(encoded.length, length));
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeTarString(buffer, offset, length, `${encoded}\0`);
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);
  const actualEnd = end >= offset && end < offset + length ? end : offset + length;
  return buffer.toString("utf8", offset, actualEnd).trim();
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number {
  const value = readTarString(buffer, offset, length).replace(/\0/gu, "").trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function makePaxRecord(key: string, value: string): string {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload, "utf8") + 3;
  while (true) {
    const record = `${length} ${payload}`;
    const actualLength = Buffer.byteLength(record, "utf8");
    if (actualLength === length) {
      return record;
    }
    length = actualLength;
  }
}

function parsePaxRecords(content: Buffer): Record<string, string> {
  const text = content.toString("utf8");
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const spaceIndex = text.indexOf(" ", offset);
    if (spaceIndex < 0) break;
    const length = Number.parseInt(text.slice(offset, spaceIndex), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(spaceIndex + 1, offset + length).replace(/\n$/u, "");
    const equalsIndex = record.indexOf("=");
    if (equalsIndex > 0) {
      records[record.slice(0, equalsIndex)] = record.slice(equalsIndex + 1);
    }
    offset += length;
  }
  return records;
}

function createTarHeader(path: string, size: number, type: "0" | "5" | "x"): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const fallbackName =
    type === "x"
      ? `./PaxHeaders/${basename(path).replace(/[^a-z0-9._-]/giu, "_").slice(0, 80) || "entry"}`
      : path.replace(/[^a-z0-9/._-]/giu, "_").slice(0, 100) || "entry";
  writeTarString(header, 0, 100, fallbackName);
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, type);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8).padStart(6, "0").slice(-6);
  writeTarString(header, 148, 8, `${checksumText}\0 `);
  return header;
}

function normalizeArchivePath(path: string): string {
  return path
    .replace(/\\/gu, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function isAllowedBackupArchivePath(path: string): boolean {
  const normalized = normalizeArchivePath(path);
  return (
    normalized === "manifest.json" ||
    normalized === "maibot" ||
    normalized === "maibot/data" ||
    normalized === "maibot/config" ||
    normalized.startsWith("maibot/data/") ||
    normalized.startsWith("maibot/config/")
  );
}

function assertSafeArchivePath(root: string, archivePath: string): string {
  const normalized = normalizeArchivePath(archivePath);
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    parts.some((part) => part === "." || part === "..") ||
    !isAllowedBackupArchivePath(normalized)
  ) {
    throw new Error(`备份包包含不允许的路径: ${archivePath}`);
  }
  const target = resolve(root, ...parts);
  if (!sameOrInsidePath(root, target)) {
    throw new Error(`备份包路径越界: ${archivePath}`);
  }
  return target;
}

async function waitForStreamFinish(stream: NodeJS.EventEmitter, signal?: AbortSignal): Promise<void> {
  assertMaiBotBackupNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener("finish", onFinish);
      stream.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onFinish = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(normalizeMaiBotBackupIoError(error));
    };
    const onAbort = (): void => {
      cleanup();
      reject(createMaiBotBackupAbortError());
    };
    stream.once("finish", onFinish);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  assertMaiBotBackupNotAborted(signal);
}

async function writeStreamChunk(stream: NodeJS.WritableStream, chunk: Buffer, signal?: AbortSignal): Promise<void> {
  assertMaiBotBackupNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(normalizeMaiBotBackupIoError(error));
    };
    const onAbort = (): void => {
      cleanup();
      reject(createMaiBotBackupAbortError());
    };
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.write(chunk, (error?: Error | null) => {
      cleanup();
      if (error) {
        reject(normalizeMaiBotBackupIoError(error));
        return;
      }
      resolve();
    });
  });
  assertMaiBotBackupNotAborted(signal);
}

class TarGzipWriter {
  private readonly gzip = createGzip();
  private readonly output: ReturnType<typeof createWriteStream>;
  private streamError: Error | null = null;

  constructor(private readonly targetPath: string, private readonly signal?: AbortSignal) {
    this.output = createWriteStream(targetPath);
    this.output.on("error", (error) => {
      this.streamError = normalizeMaiBotBackupIoError(error);
      this.gzip.destroy(this.streamError);
    });
    this.gzip.on("error", (error) => {
      this.streamError = normalizeMaiBotBackupIoError(error);
      this.output.destroy(this.streamError);
    });
    this.signal?.addEventListener("abort", () => {
      const error = createMaiBotBackupAbortError();
      this.streamError = error;
      this.gzip.destroy(error);
      this.output.destroy(error);
    }, { once: true });
    this.gzip.pipe(this.output);
  }

  async addBuffer(path: string, content: Buffer): Promise<void> {
    await this.addPaxHeader(path);
    await this.write(createTarHeader(path, content.length, "0"));
    await this.write(content);
    await this.writePadding(content.length);
  }

  async addDirectory(path: string): Promise<void> {
    await this.addPaxHeader(path);
    await this.write(createTarHeader(path, 0, "5"));
  }

  async addFile(path: string, sourcePath: string, size: number): Promise<void> {
    await this.addPaxHeader(path);
    await this.write(createTarHeader(path, size, "0"));
    for await (const chunk of createReadStream(sourcePath)) {
      this.throwIfFailed();
      await this.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await this.writePadding(size);
  }

  async close(): Promise<void> {
    await this.write(Buffer.alloc(TAR_BLOCK_SIZE * 2));
    const finishPromise = waitForStreamFinish(this.output, this.signal);
    this.gzip.end();
    await finishPromise;
    this.throwIfFailed();
  }

  async destroy(): Promise<void> {
    const error = this.streamError ?? createMaiBotBackupAbortError();
    const closePromise = this.output.closed
      ? Promise.resolve()
      : once(this.output, "close").then(() => undefined).catch(() => undefined);
    this.gzip.destroy(error);
    this.output.destroy(error);
    await closePromise;
  }

  private async addPaxHeader(path: string): Promise<void> {
    const content = Buffer.from(makePaxRecord("path", normalizeArchivePath(path)), "utf8");
    await this.write(createTarHeader(path, content.length, "x"));
    await this.write(content);
    await this.writePadding(content.length);
  }

  private async writePadding(size: number): Promise<void> {
    const padding = tarPaddingSize(size);
    if (padding > 0) {
      await this.write(Buffer.alloc(padding));
    }
  }

  private async write(chunk: Buffer): Promise<void> {
    this.throwIfFailed();
    await writeStreamChunk(this.gzip, chunk, this.signal);
    this.throwIfFailed();
  }

  private throwIfFailed(): void {
    assertMaiBotBackupNotAborted(this.signal);
    if (this.streamError) {
      throw this.streamError;
    }
  }
}

async function extractTarGzipArchive(
  archivePath: string,
  targetRoot: string,
  onCompressedRead?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  assertMaiBotBackupNotAborted(signal);
  const source = createReadStream(archivePath);
  if (onCompressedRead) {
    source.on("data", (chunk: Buffer | string) => {
      onCompressedRead(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
    });
  }
  const input = source.pipe(createGunzip());
  signal?.addEventListener("abort", () => {
    const error = createMaiBotBackupAbortError();
    source.destroy(error);
    input.destroy(error);
  }, { once: true });
  const iterator = input[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let pendingPax: Record<string, string> | null = null;

  const readExactly = async (size: number): Promise<Buffer> => {
    assertMaiBotBackupNotAborted(signal);
    while (pending.length < size) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error("备份包内容不完整");
      }
      pending = Buffer.concat([pending, Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)]);
    }
    const result = pending.subarray(0, size);
    pending = pending.subarray(size);
    assertMaiBotBackupNotAborted(signal);
    return result;
  };

  const discard = async (size: number): Promise<void> => {
    let remaining = size;
    assertMaiBotBackupNotAborted(signal);
    while (remaining > 0) {
      if (pending.length === 0) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error("备份包内容不完整");
        }
        pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      }
      const consumed = Math.min(remaining, pending.length);
      pending = pending.subarray(consumed);
      remaining -= consumed;
      assertMaiBotBackupNotAborted(signal);
    }
  };

  const writeFileContent = async (targetPath: string, size: number): Promise<void> => {
    assertMaiBotBackupNotAborted(signal);
    await mkdir(dirname(targetPath), { recursive: true });
    const output = createWriteStream(targetPath);
    signal?.addEventListener("abort", () => {
      output.destroy(createMaiBotBackupAbortError());
    }, { once: true });
    let remaining = size;
    try {
      while (remaining > 0) {
        assertMaiBotBackupNotAborted(signal);
        if (pending.length === 0) {
          const next = await iterator.next();
          if (next.done) {
            throw new Error("备份包文件内容不完整");
          }
          pending = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        }
        const chunk = pending.subarray(0, Math.min(remaining, pending.length));
        pending = pending.subarray(chunk.length);
        remaining -= chunk.length;
        await writeStreamChunk(output, chunk, signal);
      }
    } finally {
      const finishPromise = waitForStreamFinish(output, signal);
      output.end();
      await finishPromise;
    }
  };

  while (true) {
    assertMaiBotBackupNotAborted(signal);
    const header = await readExactly(TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const rawName = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = readTarOctal(header, 124, 12);
    const type = readTarString(header, 156, 1) || "0";
    const headerPath = prefix ? `${prefix}/${rawName}` : rawName;

    if (type === "x") {
      const content = await readExactly(size);
      pendingPax = parsePaxRecords(content);
      await discard(tarPaddingSize(size));
      continue;
    }

    const archiveEntryPath = pendingPax?.path ?? headerPath;
    pendingPax = null;
    const targetPath = assertSafeArchivePath(targetRoot, archiveEntryPath);

    if (type === "5") {
      await mkdir(targetPath, { recursive: true });
      continue;
    }

    if (type === "0" || type === "") {
      await writeFileContent(targetPath, size);
      await discard(tarPaddingSize(size));
      continue;
    }

    await discard(size + tarPaddingSize(size));
  }
}

function storageCategory(
  key: MaiBotStorageCategory["key"],
  label: string,
  description: string,
  path: string,
  stats: StorageStatSummary,
  cleanupTarget?: MaiBotStorageCleanupTarget,
): MaiBotStorageCategory {
  return {
    key,
    label,
    description,
    path,
    exists: stats.exists,
    sizeBytes: stats.sizeBytes,
    fileCount: stats.fileCount,
    directoryCount: stats.directoryCount,
    latestModifiedAt: stats.latestModifiedAt,
    cleanupTarget,
  };
}

function normalizeRelativePath(path: string): string {
  return path.split(/[\\/]+/u).filter(Boolean).join("/");
}

function isExactOrInsideRelativePath(path: string, protectedPath: string): boolean {
  return path === protectedPath || path.startsWith(`${protectedPath}/`);
}

function isProtectedByList(path: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((protectedPath) => isExactOrInsideRelativePath(path, protectedPath));
}

function isNapcatComponentProtectedPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const fileName = normalized.split("/").at(-1) ?? normalized;
  return (
    isProtectedByList(normalized, NAPCAT_COMPONENT_PROTECTED_PATHS) ||
    NAPCAT_VERSION_CONFIG_PATTERN.test(normalized) ||
    COMPONENT_DATA_FILE_PATTERN.test(fileName) ||
    COMPONENT_LOG_FILE_PATTERN.test(fileName)
  );
}

function isSnowLumaComponentProtectedPath(relativePath: string): boolean {
  return isProtectedByList(normalizeRelativePath(relativePath), SNOWLUMA_COMPONENT_PROTECTED_PATHS);
}

function cleanPathEntry(entry: string): string {
  return entry.trim().replace(/^"|"$/gu, "");
}

function isWindowsAppsAlias(path: string): boolean {
  return process.platform === "win32" && /\\microsoft\\windowsapps\\git\.exe$/iu.test(path);
}

function isWindowsAppsPythonAlias(path: string): boolean {
  return process.platform === "win32" && /\\microsoft\\windowsapps\\python(?:3)?\.exe$/iu.test(path);
}

function pathGitCandidates(): string[] {
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map(cleanPathEntry)
    .filter(Boolean);
  const candidates: string[] = [];

  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = join(entry, name);
      if (!isWindowsAppsAlias(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function pathPythonCandidates(): string[] {
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map(cleanPathEntry)
    .filter(Boolean);
  const candidates: string[] = [];

  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = join(entry, name);
      if (!isWindowsAppsPythonAlias(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function childPythonCandidates(root: string | undefined): string[] {
  if (!root || !existsSync(root)) {
    return [];
  }

  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, process.platform === "win32" ? "python.exe" : "bin/python3"))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => right.localeCompare(left, "en-US", { numeric: true, sensitivity: "base" }));
  } catch {
    return [];
  }
}

function childPythonCandidateDetails(root: string | undefined, source: string): PythonRuntimeCandidate[] {
  return childPythonCandidates(root).map((path) => ({ path, source }));
}

function systemPythonCandidates(): string[] {
  return systemPythonCandidateDetails().map((candidate) => candidate.path);
}

function systemPythonCandidateDetails(): PythonRuntimeCandidate[] {
  if (process.platform !== "win32") {
    return uniquePythonCandidates([
      ...pathPythonCandidates().map((path) => ({ path, source: "PATH" })),
      { path: "/usr/bin/python3", source: "/usr/bin" },
      { path: "/usr/local/bin/python3", source: "/usr/local/bin" },
      { path: "/opt/homebrew/bin/python3", source: "Homebrew" },
    ]);
  }

  const candidates: PythonRuntimeCandidate[] = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(...childPythonCandidateDetails(join(process.env.LOCALAPPDATA, "Programs", "Python"), "用户 Python"));
  }
  candidates.push(...childPythonCandidateDetails(process.env.ProgramFiles, "Program Files"));
  candidates.push(...childPythonCandidateDetails(process.env["ProgramFiles(x86)"], "Program Files (x86)"));
  if (process.env.USERPROFILE) {
    candidates.push(...childPythonCandidateDetails(join(process.env.USERPROFILE, ".pyenv", "pyenv-win", "versions"), "pyenv-win"));
  }
  candidates.push(...pathPythonCandidates().map((path) => ({ path, source: "PATH" })));
  return uniquePythonCandidates(candidates);
}

function systemGitCandidates(): string[] {
  if (process.platform !== "win32") {
    return [
      ...pathGitCandidates(),
      "/usr/bin/git",
      "/usr/local/bin/git",
      "/opt/homebrew/bin/git",
    ];
  }

  const candidates: string[] = [];
  const addWindowsGitRoot = (root: string | undefined): void => {
    if (!root) return;
    candidates.push(
      join(root, "Git", "cmd", "git.exe"),
      join(root, "Git", "bin", "git.exe"),
      join(root, "Git", "mingw64", "bin", "git.exe"),
    );
  };

  addWindowsGitRoot(process.env.ProgramFiles);
  addWindowsGitRoot(process.env["ProgramFiles(x86)"]);
  addWindowsGitRoot(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : undefined);

  if (process.env.USERPROFILE) {
    candidates.push(join(process.env.USERPROFILE, "scoop", "apps", "git", "current", "cmd", "git.exe"));
  }
  if (process.env.ProgramData) {
    candidates.push(join(process.env.ProgramData, "chocolatey", "bin", "git.exe"));
  }

  candidates.push(...pathGitCandidates());
  return candidates;
}

const AGREEMENT_FILES: Array<{ id: AgreementDocumentId; title: string; fileName: string; envVar: string }> = [
  { id: "eula", title: "最终用户许可协议", fileName: "EULA.md", envVar: "EULA_AGREE" },
  { id: "privacy", title: "隐私政策", fileName: "PRIVACY.md", envVar: "PRIVACY_AGREE" },
];

const AGREEMENT_STORE_FILE = "agreement.json";

/**
 * NapCat startup wrapper .cmd: switch the console to UTF-8 before launching the exe.
 * The content is fixed and does not interpolate runtime variables, avoiding cmd quote parsing issues.
 */
const NAPCAT_LAUNCHER_FILE = "napcat-launch.cmd";
const NAPCAT_LAUNCHER_CONTENT = [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  '"%~dp0NapCatWinBootMain.exe" %*',
  "",
].join("\r\n");

const NAPCAT_ADAPTER_DIR = join("plugins", "napcat-adapter");
const NAPCAT_ADAPTER_CONFIG_VERSION = "0.1.0";
const NAPCAT_ADAPTER_PLUGIN_ID = "maibot-team.napcat-adapter";
const SNOWLUMA_ADAPTER_DIR = join("plugins", "snowluma-adapter");
const SNOWLUMA_ADAPTER_CONFIG_VERSION = "1.0.0";
const SNOWLUMA_ADAPTER_PLUGIN_ID = "maibot-team.snowluma-adapter";
const NAPCAT_ADAPTER_HOST = "127.0.0.1";
const NAPCAT_ADAPTER_PORT = 7998;
const SNOWLUMA_ONEBOT_PORT = 7988;
const SNOWLUMA_WEBUI_PORT = 5099;

interface NapcatWebsocketServerConfig {
  host: string;
  port: number;
  token: string;
}

function buildDefaultNapcatAdapterConfig(token = "", port = NAPCAT_ADAPTER_PORT): NapcatAdapterConfig {
  return {
    plugin: {
      enabled: true,
      configVersion: NAPCAT_ADAPTER_CONFIG_VERSION,
    },
    server: {
      host: NAPCAT_ADAPTER_HOST,
      port,
      token,
      heartbeatInterval: 30,
      reconnectDelaySec: 5,
      actionTimeoutSec: 15,
      connectionId: "",
    },
    chat: {
      enableChatListFilter: true,
      showDroppedChatListMessages: false,
      groupListType: "whitelist",
      groupList: [],
      privateListType: "whitelist",
      privateList: [],
      banUserId: [],
      banQqBot: false,
    },
    filters: {
      ignoreSelfMessage: true,
    },
  };
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "bigint" && value > 0n) return Number(value);
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const num = asPositiveNumber(value, fallback);
  return Math.max(1, Math.floor(num));
}

function asTcpPort(value: unknown, fallback: number): number {
  const port = asPositiveInt(value, fallback);
  return port <= 65535 ? port : fallback;
}

function localWebUiHost(host: string): string {
  const normalized = host.trim();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]" || normalized === "*") {
    return MAIBOT_WEBUI_FALLBACK_HOST;
  }
  return normalized;
}

function hostForUrl(host: string): string {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unwrapped.includes(":") ? `[${unwrapped}]` : unwrapped;
}

function buildMaiBotWebUiEndpoint(host = MAIBOT_WEBUI_FALLBACK_HOST, port = MAIBOT_WEBUI_FALLBACK_PORT): {
  host: string;
  port: number;
  url: string;
} {
  const resolvedHost = localWebUiHost(host);
  const resolvedPort = asTcpPort(port, MAIBOT_WEBUI_FALLBACK_PORT);
  try {
    return {
      host: resolvedHost,
      port: resolvedPort,
      url: new URL(`http://${hostForUrl(resolvedHost)}:${resolvedPort}`).origin,
    };
  } catch {
    return {
      host: MAIBOT_WEBUI_FALLBACK_HOST,
      port: MAIBOT_WEBUI_FALLBACK_PORT,
      url: `http://${MAIBOT_WEBUI_FALLBACK_HOST}:${MAIBOT_WEBUI_FALLBACK_PORT}`,
    };
  }
}

function asListMode(value: unknown, fallback: NapcatChatListMode): NapcatChatListMode {
  if (value === "whitelist" || value === "blacklist") return value;
  return fallback;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === "string" ? item.trim() : String(item ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeNapcatAdapterConfig(
  raw: Record<string, unknown>,
  defaults: NapcatAdapterConfig,
): NapcatAdapterConfig {
  const pluginRaw = (raw["plugin"] as Record<string, unknown> | undefined) ?? {};
  const serverRaw =
    ((raw["napcat_server"] ?? raw["luma_client"] ?? raw["connection"]) as Record<string, unknown> | undefined) ?? {};
  const chatRaw = (raw["chat"] as Record<string, unknown> | undefined) ?? {};
  const filtersRaw = (raw["filters"] as Record<string, unknown> | undefined) ?? {};

  return {
    plugin: {
      enabled: asBool(pluginRaw["enabled"], defaults.plugin.enabled),
      configVersion: asString(pluginRaw["config_version"], defaults.plugin.configVersion),
    },
    server: {
      host: asString(serverRaw["host"] ?? serverRaw["server"], defaults.server.host).trim() || defaults.server.host,
      port: asPositiveInt(serverRaw["port"], defaults.server.port),
      token: asString(serverRaw["token"] ?? serverRaw["access_token"], defaults.server.token),
      heartbeatInterval: asPositiveNumber(
        serverRaw["heartbeat_interval"] ?? serverRaw["heartbeat_sec"],
        defaults.server.heartbeatInterval,
      ),
      reconnectDelaySec: asPositiveNumber(
        serverRaw["reconnect_delay_sec"],
        defaults.server.reconnectDelaySec,
      ),
      actionTimeoutSec: asPositiveNumber(
        serverRaw["action_timeout_sec"],
        defaults.server.actionTimeoutSec,
      ),
      connectionId: asString(serverRaw["connection_id"], defaults.server.connectionId),
    },
    chat: {
      enableChatListFilter: asBool(
        chatRaw["enable_chat_list_filter"],
        defaults.chat.enableChatListFilter,
      ),
      showDroppedChatListMessages: asBool(
        chatRaw["show_dropped_chat_list_messages"],
        defaults.chat.showDroppedChatListMessages,
      ),
      groupListType: asListMode(chatRaw["group_list_type"], defaults.chat.groupListType),
      groupList: asStringList(chatRaw["group_list"] ?? defaults.chat.groupList),
      privateListType: asListMode(chatRaw["private_list_type"], defaults.chat.privateListType),
      privateList: asStringList(chatRaw["private_list"] ?? defaults.chat.privateList),
      banUserId: asStringList(chatRaw["ban_user_id"] ?? defaults.chat.banUserId),
      banQqBot: asBool(chatRaw["ban_qq_bot"], defaults.chat.banQqBot),
    },
    filters: {
      ignoreSelfMessage: asBool(filtersRaw["ignore_self_message"], defaults.filters.ignoreSelfMessage),
    },
  };
}

function napcatAdapterConfigToToml(config: NapcatAdapterConfig): string {
  const document = {
    plugin: {
      enabled: config.plugin.enabled,
      config_version: config.plugin.configVersion,
    },
    napcat_server: {
      host: config.server.host,
      port: config.server.port,
      token: config.server.token,
      heartbeat_interval: config.server.heartbeatInterval,
      reconnect_delay_sec: config.server.reconnectDelaySec,
      action_timeout_sec: config.server.actionTimeoutSec,
      connection_id: config.server.connectionId,
    },
    chat: {
      enable_chat_list_filter: config.chat.enableChatListFilter,
      show_dropped_chat_list_messages: config.chat.showDroppedChatListMessages,
      group_list_type: config.chat.groupListType,
      group_list: config.chat.groupList,
      private_list_type: config.chat.privateListType,
      private_list: config.chat.privateList,
      ban_user_id: config.chat.banUserId,
      ban_qq_bot: config.chat.banQqBot,
    },
    filters: {
      ignore_self_message: config.filters.ignoreSelfMessage,
    },
  } as const;
  return stringifyToml(document);
}

function snowlumaAdapterConfigToToml(config: NapcatAdapterConfig): string {
  const document = {
    plugin: {
      enabled: config.plugin.enabled,
      config_version: config.plugin.configVersion,
    },
    luma_client: {
      server: config.server.host,
      port: config.server.port,
      token: config.server.token,
      connection_id: config.server.connectionId,
      reconnect_delay_sec: config.server.reconnectDelaySec,
      action_timeout_sec: config.server.actionTimeoutSec,
    },
    chat: {
      enable_chat_list_filter: config.chat.enableChatListFilter,
      show_dropped_chat_list_messages: config.chat.showDroppedChatListMessages,
      group_list_type: config.chat.groupListType,
      group_list: config.chat.groupList,
      private_list_type: config.chat.privateListType,
      private_list: config.chat.privateList,
      ban_user_id: config.chat.banUserId,
      ban_qq_bot: config.chat.banQqBot,
    },
    filters: {
      ignore_self_message: config.filters.ignoreSelfMessage,
    },
  } as const;
  return stringifyToml(document);
}

function applyChatOverrides(
  base: NapcatAdapterChatConfig,
  override?: Partial<NapcatAdapterChatConfig>,
): NapcatAdapterChatConfig {
  if (!override) return base;
  return {
    enableChatListFilter: override.enableChatListFilter ?? base.enableChatListFilter,
    showDroppedChatListMessages:
      override.showDroppedChatListMessages ?? base.showDroppedChatListMessages,
    groupListType: override.groupListType ?? base.groupListType,
    groupList: override.groupList !== undefined ? asStringList(override.groupList) : base.groupList,
    privateListType: override.privateListType ?? base.privateListType,
    privateList: override.privateList !== undefined ? asStringList(override.privateList) : base.privateList,
    banUserId: override.banUserId !== undefined ? asStringList(override.banUserId) : base.banUserId,
    banQqBot: override.banQqBot ?? base.banQqBot,
  };
}

function hasUsableWebsocketServerConfig(server: NapcatWebsocketServerConfig | undefined): server is NapcatWebsocketServerConfig {
  return Boolean(
    server?.host.trim()
    && Number.isFinite(server.port)
    && server.port > 0
    && server.token.trim(),
  );
}

interface StoredAgreementFile {
  version: 1;
  hashes: Partial<Record<AgreementDocumentId, string>>;
  confirmedAt?: number;
}

interface StoredMessagePlatformFile {
  version: 1;
  backend?: QqBackend;
  qqAccount?: string;
  configuredAt?: number;
  adapterConfigInitialized?: Partial<Record<QqBackend, number>>;
}

interface BundledComponentUpgradeSpec {
  id: QqComponentUpgradeId;
  name: string;
  moduleName: string;
  isProtectedPath: (relativePath: string) => boolean;
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeTomlLineEndings(content: string): string {
  return content.replace(/\r\n?/gu, "\n");
}

function readTomlTable(content: string, tableName: string): Record<string, unknown> | undefined {
  const normalized = normalizeTomlLineEndings(content);
  const tablePattern = new RegExp(
    `(^|\\n)\\s*\\[${escapeRegExp(tableName)}\\]\\s*(?:#.*)?(?:\\n|$)`,
    "u",
  );
  const tableMatch = tablePattern.exec(normalized);
  if (!tableMatch) {
    return undefined;
  }

  const tableStart = tableMatch.index + tableMatch[0].length;
  const nextTableOffset = normalized
    .slice(tableStart)
    .search(/\n\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?(?:\n|$)/u);
  const tableBody = nextTableOffset === -1
    ? normalized.slice(tableStart)
    : normalized.slice(tableStart, tableStart + nextTableOffset);

  try {
    const parsed = parseToml(`[${tableName}]\n${tableBody.trimEnd()}\n`);
    const table = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[tableName]
      : undefined;
    return table && typeof table === "object" && !Array.isArray(table)
      ? table as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function ensureBotQqConfig(content: string, account: string): string {
  return ensureBotPlatformConfig(content, {
    platform: "qq",
    qqAccount: account,
  });
}

function ensureBotPlatformConfig(
  content: string,
  options: { platform?: string; qqAccount?: string },
): string {
  const botSectionMatch = content.match(/(^|\r?\n)(\s*\[bot\]\s*(?:#.*)?)(?:\r?\n|$)/u);
  if (!botSectionMatch) {
    const platformLine = options.platform ? `platform = "${options.platform}"\n` : "";
    const qqAccountLine = options.qqAccount ? `qq_account = ${options.qqAccount}\n` : "";
    return `${content.trimEnd()}\n\n[bot]\n${platformLine}${qqAccountLine}`;
  }

  const botSectionStart = (botSectionMatch.index ?? 0) + botSectionMatch[0].length;
  const nextSectionOffset = content
    .slice(botSectionStart)
    .search(/\r?\n\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?(?:\r?\n|$)/u);
  const botSectionEnd =
    nextSectionOffset === -1 ? content.length : botSectionStart + nextSectionOffset;
  const beforeBotSection = content.slice(0, botSectionStart);
  const botSection = content.slice(botSectionStart, botSectionEnd);
  const afterBotSection = content.slice(botSectionEnd);
  let nextBotSection = botSection;

  if (options.platform) {
    if (/^\s*platform\s*=/mu.test(nextBotSection)) {
      nextBotSection = nextBotSection.replace(
        /^\s*platform\s*=\s*["'][^"']*["'](\s*#.*)?$/mu,
        `platform = "${options.platform}"$1`,
      );
    } else {
      nextBotSection = `platform = "${options.platform}"\n${nextBotSection}`;
    }
  }

  if (options.qqAccount) {
    if (/^\s*qq_account\s*=/mu.test(nextBotSection)) {
      nextBotSection = nextBotSection.replace(
        QQ_ACCOUNT_ASSIGNMENT_PATTERN,
        `$1${options.qqAccount}$2`,
      );
    } else {
      nextBotSection = `${nextBotSection.trimEnd()}\nqq_account = ${options.qqAccount}\n`;
    }
  }

  return `${beforeBotSection}${nextBotSection}${afterBotSection}`;
}

function checkFile(path: string, label: string, id: string): InitCheck {
  if (existsSync(path)) {
    return { id, label, status: "ok", detail: "已找到", path };
  }

  return { id, label, status: "error", detail: "缺失", path };
}

function checkDir(path: string, label: string, id: string): InitCheck {
  if (existsSync(path)) {
    return { id, label, status: "ok", detail: "已找到", path };
  }

  return { id, label, status: "error", detail: "缺失", path };
}

function runProcess(file: string, args: string[], cwd: string, timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (error) {
          reject(new Error(output || error.message));
          return;
        }

        resolve(output);
      },
    );
  });
}

function isCleanPipCheckOutput(output: string): boolean {
  return /(?:^|\n)\s*No broken requirements found\.\s*$/iu.test(output.trim());
}

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePyLauncherPaths(output: string): PythonRuntimeCandidate[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/(?:-\d+(?:\.\d+)?(?:-\d+)?\s+\*?\s*)?(.+?python(?:3)?\.exe)$/iu);
      return match?.[1]?.trim();
    })
    .filter((path): path is string => Boolean(path))
    .map((path) => ({ path, source: "py launcher" }));
}

function createWebsocketToken(): string {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

function md5Utf8(content: string): string {
  // Match Python `open(path, encoding="utf-8").read()` behavior.
  // Python text mode normalizes CRLF / CR to LF before passing content to hashlib.
  // Node readFile(path, "utf8") preserves original CRLF, so normalize here to match MaiBot hashes.
  const normalized = content.replace(/\r\n?/g, "\n");
  return createHash("md5").update(normalized, "utf8").digest("hex");
}

function hasInnerVersion(content: string): boolean {
  const innerMatch = content.match(/(^|\n)\s*\[inner\]\s*(?:\n|$)/u);
  if (!innerMatch) {
    return false;
  }

  const sectionStart = (innerMatch.index ?? 0) + innerMatch[0].length;
  const nextSection = content.slice(sectionStart).search(/\n\s*\[[^\]]+\]\s*(?:\n|$)/u);
  const section =
    nextSection === -1
      ? content.slice(sectionStart)
      : content.slice(sectionStart, sectionStart + nextSection);
  return /^\s*version\s*=\s*["'][^"']+["']\s*$/mu.test(section);
}

function ensureInnerVersion(content: string, version: string): string {
  if (hasInnerVersion(content)) {
    return content;
  }

  const innerMatch = content.match(/(^|\n)(\s*\[inner\]\s*)(?:\n|$)/u);
  if (!innerMatch) {
    return `[inner]\nversion = "${version}"\n\n${content.replace(/^\uFEFF/u, "")}`;
  }

  const insertAt = (innerMatch.index ?? 0) + innerMatch[0].length;
  return `${content.slice(0, insertAt)}version = "${version}"\n${content.slice(insertAt)}`;
}

function maibotInitialConfigVersion(templateVersion: string): string {
  const match = templateVersion.match(/^(.*?)(\d+)([^\d]*)$/u);
  if (!match) {
    return templateVersion;
  }

  const current = Number(match[2]);
  if (!Number.isSafeInteger(current) || current <= 0) {
    return templateVersion;
  }

  return `${match[1]}${current - 1}${match[3]}`;
}

async function runWithoutAsar<T>(operation: () => Promise<T>): Promise<T> {
  const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
  const previousNoAsar = electronProcess.noAsar;
  electronProcess.noAsar = true;

  try {
    return await operation();
  } finally {
    electronProcess.noAsar = previousNoAsar;
  }
}

export class InitManager {
  private dependencyCache?: { expiresAt: number; checks: InitCheck[] };

  constructor(private readonly paths: RuntimePaths) {}

  getQqBackendSync(): QqBackend {
    try {
      const parsed = JSON.parse(readFileSync(this.qqBackendPath(), "utf8")) as { backend?: unknown };
      return parsed.backend === "snowluma" ? "snowluma" : "napcat";
    } catch {
      return "napcat";
    }
  }

  async readQqBackend(): Promise<QqBackend> {
    return this.getQqBackendSync();
  }

  hasMessagePlatformConfigured(): boolean {
    const store = this.readMessagePlatformStore();
    const qqAccount = store?.qqAccount?.trim();
    return Boolean(qqAccount && isDigits(qqAccount));
  }

  async setQqBackend(backend: QqBackend, options: { syncAdapters?: boolean } = {}): Promise<void> {
    await mkdir(dirname(this.qqBackendPath()), { recursive: true });
    await writeFile(
      this.qqBackendPath(),
      `${JSON.stringify({ version: 1, backend, updatedAt: Date.now() }, null, 2)}\n`,
      "utf8",
    );
    await this.ensureServiceReady("napcat");
    if (options.syncAdapters !== false) {
      const qqAccount = await this.readConfiguredQqAccount();
      if (qqAccount) {
        const syncedPaths = await this.syncSelectedQqAdapterConfigs();
        const selectedConfigPath = backend === "snowluma"
          ? this.snowlumaAdapterConfigPath()
          : this.napcatAdapterConfigPath();
        if (syncedPaths.some((path) => samePath(path, selectedConfigPath))) {
          await this.markMessagePlatformConfigured(backend, qqAccount, backend);
        }
      }
    }
  }

  async getState(options: { refreshDependencies?: boolean } = {}): Promise<InitState> {
    const qqAccount = await this.readConfiguredQqAccount();
    const qqBackend = await this.readQqBackend();
    const messagePlatformConfigured = this.hasMessagePlatformConfigured();
    const dependencyChecks = options.refreshDependencies === false
      ? this.getCachedDependencyChecks()
      : await this.checkDependencies();
    const napCatWebUiCheck = await this.checkNapCatWebUi();
    const qqModuleChecks = qqBackend === "snowluma"
      ? [
          checkDir(this.paths.snowlumaRoot, "SnowLuma 模块", "snowluma-module"),
          checkFile(join(this.paths.snowlumaRoot, "index.mjs"), "SnowLuma 启动文件", "snowluma-entry"),
        ]
      : [
          checkDir(this.paths.napcatRoot, "NapCat 模块", "napcat-module"),
          checkFile(
            join(this.paths.napcatRoot, "NapCatWinBootMain.exe"),
            "NapCat 启动文件",
            "napcat-entry",
          ),
          napCatWebUiCheck,
        ];
    const checks: InitCheck[] = [
      this.checkRuntimeRoot(),
      this.checkPythonRuntime(),
      checkDir(this.paths.maibotRoot, "MaiBot 主模块", "maibot-module"),
      checkFile(join(this.paths.maibotRoot, "bot.py"), "MaiBot 启动文件", "maibot-entry"),
      ...qqModuleChecks,
      ...dependencyChecks,
    ];
    const isReady = checks.every((check) => check.status !== "error");
    return { isReady, qqAccount, qqBackend, messagePlatformConfigured, checks };
  }

  async refreshDependencyChecks(): Promise<InitCheck[]> {
    return this.checkDependencies();
  }

  async repair(): Promise<InitRepairResult> {
    const changedFiles = await this.ensureModulesReady();

    const state = {
      ...(await this.getState()),
      repairedAt: Date.now(),
    };
    return { state, changedFiles };
  }

  async getAgreementState(): Promise<StartupAgreementState> {
    const stored = await this.readAgreementStore();
    const documents = await Promise.all(
      AGREEMENT_FILES.map((agreement) => this.readAgreementDocument(agreement, stored)),
    );
    return {
      isConfirmed: documents.every((document) => document.exists && document.confirmed),
      documents,
    };
  }

  async confirmAgreements(): Promise<StartupAgreementConfirmResult> {
    const state = await this.getAgreementState();
    const missing = state.documents.find((document) => !document.exists);
    if (missing) {
      throw new Error(`${missing.title} 文件缺失: ${missing.sourcePath}`);
    }

    const hashes: Partial<Record<AgreementDocumentId, string>> = {};
    for (const document of state.documents) {
      hashes[document.id] = document.hash;
    }

    const storePath = this.agreementStorePath();
    const payload: StoredAgreementFile = {
      version: 1,
      hashes,
      confirmedAt: Date.now(),
    };
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    return {
      state: await this.getAgreementState(),
      changedFiles: [storePath],
    };
  }

  async assertAgreementsConfirmed(): Promise<void> {
    const state = await this.getAgreementState();
    if (!state.isConfirmed) {
      throw new Error("请先阅读并同意 MaiBot EULA 与隐私政策。");
    }
  }

  /**
   * Calculate the latest EULA / PRIVACY MD5 and inject it as environment variables on each MaiBot start.
   * MaiBot bot.py reads `EULA_AGREE` and `PRIVACY_AGREE`; matching the current file hash means accepted.
   * When agreements change, the hash changes automatically and MaiBot will trigger confirmation again.
   */
  async getAgreementEnvVars(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const agreement of AGREEMENT_FILES) {
      const sourcePath = this.agreementSourcePath(agreement.fileName);
      if (!existsSync(sourcePath)) {
        continue;
      }
      try {
        const content = await readFile(sourcePath, "utf8");
        env[agreement.envVar] = md5Utf8(content);
      } catch {
        // Ignore read failures; MaiBot will fall back to interactive confirmation.
      }
    }
    return env;
  }

  getMaiBotDataDir(): string {
    return join(this.paths.maibotRoot, "data");
  }

  getMaiBotConfigDir(): string {
    return join(this.paths.maibotRoot, "config");
  }

  async exportMaiBotBackup(
    targetPath: string,
    launcherVersion: string,
    onProgress?: MaiBotBackupProgressCallback,
    signal?: AbortSignal,
  ): Promise<MaiBotBackupExportResult> {
    assertMaiBotBackupNotAborted(signal);
    if (!targetPath) {
      throw new Error("未选择备份保存位置");
    }
    emitMaiBotBackupProgress(onProgress, {
      operation: "export",
      phase: "scanning",
      percent: 2,
      detail: "正在扫描 MaiBot 数据与配置",
    });
    const dataDir = this.getMaiBotDataDir();
    const configDir = this.getMaiBotConfigDir();
    const dataStats = await readStorageStats(dataDir);
    const configStats = await readStorageStats(configDir);
    const totalBytes = dataStats.sizeBytes + configStats.sizeBytes;
    const totalFiles = dataStats.fileCount + configStats.fileCount;
    let processedBytes = 0;
    let processedFiles = 0;
    const exportedAt = Date.now();
    const manifest: MaiBotBackupManifest = {
      format: MAIBOT_BACKUP_FORMAT,
      formatVersion: MAIBOT_BACKUP_FORMAT_VERSION,
      createdAt: exportedAt,
      createdAtIso: new Date(exportedAt).toISOString(),
      launcherVersion,
      maibotRoot: this.paths.maibotRoot,
      includesPlugins: false,
      includedEntries: [
        ...(dataStats.exists ? (["maibot/data"] as const) : []),
        ...(configStats.exists ? (["maibot/config"] as const) : []),
      ],
      excludedEntries: ["maibot/plugins"],
      paths: {
        data: backupManifestPathInfo(dataStats),
        config: backupManifestPathInfo(configStats),
      },
    };

    await mkdir(dirname(targetPath), { recursive: true });
    const writer = new TarGzipWriter(targetPath, signal);
    try {
      assertMaiBotBackupNotAborted(signal);
      emitMaiBotBackupProgress(onProgress, {
        operation: "export",
        phase: "packing",
        percent: 8,
        detail: "正在写入 manifest.json",
        currentPath: "manifest.json",
        processedBytes,
        totalBytes,
        processedFiles,
        totalFiles,
      });
      await writer.addBuffer("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
      const reportFilePacked = (archivePath: string, sizeBytes: number): void => {
        processedBytes += sizeBytes;
        processedFiles += 1;
        emitMaiBotBackupProgress(onProgress, {
          operation: "export",
          phase: "packing",
          percent: progressInRange(8, 98, processedBytes, totalBytes),
          detail: "正在打包文件",
          currentPath: archivePath,
          processedBytes,
          totalBytes,
          processedFiles,
          totalFiles,
        });
      };
      if (dataStats.exists) {
        await this.addDirectoryToBackup(writer, dataDir, "maibot/data", new Set(), reportFilePacked);
      }
      if (configStats.exists) {
        await this.addDirectoryToBackup(writer, configDir, "maibot/config", new Set(), reportFilePacked);
      }
      emitMaiBotBackupProgress(onProgress, {
        operation: "export",
        phase: "writing",
        percent: 98,
        detail: "正在完成迁移包写入",
        processedBytes,
        totalBytes,
        processedFiles,
        totalFiles,
      });
      await writer.close();
    } catch (error) {
      await writer.destroy();
      await rm(targetPath, { force: true });
      throw normalizeMaiBotBackupIoError(error);
    }

    assertMaiBotBackupNotAborted(signal);
    const archiveStat = await stat(targetPath);
    emitMaiBotBackupProgress(onProgress, {
      operation: "export",
      phase: "completed",
      percent: 100,
      detail: "迁移包导出完成",
      currentPath: targetPath,
      processedBytes,
      totalBytes,
      processedFiles,
      totalFiles,
    });
    return {
      filePath: targetPath,
      manifest,
      sizeBytes: archiveStat.size,
      exportedAt,
    };
  }

  async importMaiBotBackup(
    sourcePath: string,
    onProgress?: MaiBotBackupProgressCallback,
    signal?: AbortSignal,
  ): Promise<MaiBotBackupImportResult> {
    assertMaiBotBackupNotAborted(signal);
    if (samePath(this.paths.maibotRoot, join(this.paths.bundledModulesRoot, "MaiBot"))) {
      throw new Error("当前指向内置模板目录，拒绝导入迁移包；请在打包后的环境执行。");
    }
    if (!sourcePath) {
      throw new Error("未选择迁移包");
    }
    if (!existsSync(sourcePath)) {
      throw new Error(`迁移包不存在: ${sourcePath}`);
    }
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error("选择的路径不是文件");
    }

    const tempRoot = join(this.paths.userDataRoot, `.maibot-backup-import-${Date.now()}-${randomBytes(4).toString("hex")}`);
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
    try {
      let compressedReadBytes = 0;
      let lastExtractProgressAt = 0;
      emitMaiBotBackupProgress(onProgress, {
        operation: "import",
        phase: "extracting",
        percent: 1,
        detail: "正在解包迁移包",
        currentPath: sourcePath,
        processedBytes: compressedReadBytes,
        totalBytes: sourceStat.size,
      });
      await extractTarGzipArchive(sourcePath, tempRoot, (bytes) => {
        compressedReadBytes += bytes;
        const now = Date.now();
        if (now - lastExtractProgressAt < 120 && compressedReadBytes < sourceStat.size) {
          return;
        }
        lastExtractProgressAt = now;
        emitMaiBotBackupProgress(onProgress, {
          operation: "import",
          phase: "extracting",
          percent: progressInRange(1, 35, compressedReadBytes, sourceStat.size),
          detail: "正在解包迁移包",
          currentPath: sourcePath,
          processedBytes: compressedReadBytes,
          totalBytes: sourceStat.size,
        });
      }, signal);
      emitMaiBotBackupProgress(onProgress, {
        operation: "import",
        phase: "validating",
        percent: 38,
        detail: "正在校验 manifest.json",
        currentPath: "manifest.json",
        processedBytes: sourceStat.size,
        totalBytes: sourceStat.size,
      });
      const manifestPath = join(tempRoot, "manifest.json");
      if (!existsSync(manifestPath)) {
        throw new Error("迁移包缺少 manifest.json");
      }
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MaiBotBackupManifest;
      this.validateMaiBotBackupManifest(manifest);

      const stagingDataDir = join(tempRoot, "maibot", "data");
      const stagingConfigDir = join(tempRoot, "maibot", "config");
      const hasData = existsSync(stagingDataDir);
      const hasConfig = existsSync(stagingConfigDir);
      if (!hasData && !hasConfig) {
        throw new Error("迁移包没有可恢复的数据或配置目录");
      }
      const stagingDataStats = hasData ? await readStorageStats(stagingDataDir) : { ...emptyStorageStat };
      const stagingConfigStats = hasConfig ? await readStorageStats(stagingConfigDir) : { ...emptyStorageStat };
      const totalRestoreBytes = stagingDataStats.sizeBytes + stagingConfigStats.sizeBytes;
      const totalRestoreFiles = stagingDataStats.fileCount + stagingConfigStats.fileCount;
      let restoredBytes = 0;
      let restoredFiles = 0;
      const reportFileRestored = (targetPath: string, sizeBytes: number): void => {
        restoredBytes += sizeBytes;
        restoredFiles += 1;
        emitMaiBotBackupProgress(onProgress, {
          operation: "import",
          phase: "restoring",
          percent: progressInRange(58, 96, restoredBytes, totalRestoreBytes),
          detail: "正在恢复文件",
          currentPath: targetPath,
          processedBytes: restoredBytes,
          totalBytes: totalRestoreBytes,
          processedFiles: restoredFiles,
          totalFiles: totalRestoreFiles,
        });
      };

      await mkdir(this.paths.maibotRoot, { recursive: true });
      const importedAt = Date.now();
      const result: MaiBotBackupImportResult = {
        sourcePath,
        manifest,
        sizeBytes: sourceStat.size,
        importedAt,
      };
      const dataDir = this.getMaiBotDataDir();
      const configDir = this.getMaiBotConfigDir();
      let backupDataDir: string | undefined;
      let backupConfigDir: string | undefined;

      try {
        assertMaiBotBackupNotAborted(signal);
        if (hasData) {
          emitMaiBotBackupProgress(onProgress, {
            operation: "import",
            phase: "backing-up",
            percent: 45,
            detail: "正在备份当前 data 目录",
            currentPath: dataDir,
          });
          backupDataDir = await this.retireExistingPath(dataDir, importedAt);
          result.backupDataDir = backupDataDir;
          emitMaiBotBackupProgress(onProgress, {
            operation: "import",
            phase: "restoring",
            percent: 58,
            detail: "正在恢复 data 目录",
            currentPath: dataDir,
          });
          await this.copyDirectoryForBackupImport(stagingDataDir, dataDir, signal, reportFileRestored);
          result.restoredDataDir = dataDir;
        }

        assertMaiBotBackupNotAborted(signal);
        if (hasConfig) {
          emitMaiBotBackupProgress(onProgress, {
            operation: "import",
            phase: "backing-up",
            percent: hasData ? 74 : 55,
            detail: "正在备份当前 config 目录",
            currentPath: configDir,
          });
          backupConfigDir = await this.retireExistingPath(configDir, importedAt);
          result.backupConfigDir = backupConfigDir;
          emitMaiBotBackupProgress(onProgress, {
            operation: "import",
            phase: "restoring",
            percent: hasData ? 86 : 78,
            detail: "正在恢复 config 目录",
            currentPath: configDir,
          });
          await this.copyDirectoryForBackupImport(stagingConfigDir, configDir, signal, reportFileRestored);
          result.restoredConfigDir = configDir;
        }
      } catch (error) {
        emitMaiBotBackupProgress(onProgress, {
          operation: "import",
          phase: "rollback",
          percent: 92,
          detail: "导入失败，正在回退原 data/config 目录",
        });
        try {
          await this.rollbackMaiBotBackupImport({
            dataDir,
            configDir,
            backupDataDir,
            backupConfigDir,
            restoreData: hasData,
            restoreConfig: hasConfig,
          });
        } catch (rollbackError) {
          const importMessage = error instanceof Error ? error.message : String(error);
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(`导入失败，且自动回退未完全完成。导入错误: ${importMessage}; 回退错误: ${rollbackMessage}`);
        }
        throw error;
      }

      emitMaiBotBackupProgress(onProgress, {
        operation: "import",
        phase: "completed",
        percent: 100,
        detail: "迁移包导入完成",
        processedBytes: sourceStat.size,
        totalBytes: sourceStat.size,
      });
      return result;
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  /**
   * Copy user-provided bot_config.toml / model_config.toml into MaiBot/config.
   * Prepare the writable MaiBot module config directory and back up original files with timestamps.
   */
  async importMaiBotConfig(
    fileName: MaiBotConfigFileName,
    sourcePath: string,
  ): Promise<MaiBotConfigImportResult> {
    if (fileName !== "bot_config.toml" && fileName !== "model_config.toml") {
      throw new Error(`Unsupported config file name: ${fileName}`);
    }
    if (!sourcePath) {
      throw new Error("No config file selected");
    }
    if (!existsSync(sourcePath)) {
      throw new Error(`Config file does not exist: ${sourcePath}`);
    }
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error("选择的路径不是文件");
    }

    const configDir = this.getMaiBotConfigDir();
    await mkdir(configDir, { recursive: true });
    const destPath = join(configDir, fileName);

    let backupPath: string | undefined;
    if (existsSync(destPath)) {
      backupPath = `${destPath}.bak.${Date.now()}`;
      await copyFile(destPath, backupPath);
    }

    await copyFile(sourcePath, destPath);

    return {
      fileName,
      sourcePath,
      destPath,
      backupPath,
      sizeBytes: sourceStat.size,
      importedAt: Date.now(),
    };
  }

  /**
   * Copy user-provided MaiBot.db into MaiBot/data/MaiBot.db.
   * Prepare the writable MaiBot module data directory.
   */
  async importMaiBotDatabase(sourcePath: string): Promise<MaiBotDataImportResult> {
    if (!sourcePath) {
      throw new Error("未选择数据库文件");
    }
    if (!existsSync(sourcePath)) {
      throw new Error(`数据库文件不存在: ${sourcePath}`);
    }
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error("选择的路径不是文件");
    }

    const dataDir = this.getMaiBotDataDir();
    await mkdir(dataDir, { recursive: true });
    const destPath = join(dataDir, "MaiBot.db");

    let backupPath: string | undefined;
    if (existsSync(destPath)) {
      backupPath = `${destPath}.bak.${Date.now()}`;
      await copyFile(destPath, backupPath);
    }

    await copyFile(sourcePath, destPath);

    return {
      sourcePath,
      destPath,
      backupPath,
      sizeBytes: sourceStat.size,
      importedAt: Date.now(),
    };
  }

  /**
   * Clear all contents under MaiBot/data without deleting the data directory itself.
   * Only applies to writable module directories; bundled template mode refuses to run this.
   */
  async resetMaiBotData(): Promise<MaiBotDataResetResult> {
    if (samePath(this.paths.maibotRoot, join(this.paths.bundledModulesRoot, "MaiBot"))) {
      throw new Error("当前指向内置模板目录，拒绝清空数据；请在打包后的环境执行。");
    }

    const dataDir = this.getMaiBotDataDir();
    if (!existsSync(dataDir)) {
      return { dataDir, removedEntries: [], clearedAt: Date.now() };
    }

    const entries = await readdir(dataDir);
    const removed: string[] = [];
    for (const entry of entries) {
      const target = join(dataDir, entry);
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    }

    return { dataDir, removedEntries: removed, clearedAt: Date.now() };
  }

  async getMaiBotStorageStats(): Promise<MaiBotStorageStats> {
    const dataDir = this.getMaiBotDataDir();
    const logsDir = join(this.paths.maibotRoot, "logs");
    const databasePaths = ["MaiBot.db", "MaiBot.db-shm", "MaiBot.db-wal"].map((fileName) => join(dataDir, fileName));
    const marketCachePaths = await this.getMaiBotMarketCachePaths(dataDir);
    const webuiPaths = ["webui.json", "local_store.json"].map((fileName) => join(dataDir, fileName));
    const knownDataNames = new Set([
      "MaiBot.db",
      "MaiBot.db-shm",
      "MaiBot.db-wal",
      "a-memorix",
      "custom_prompts",
      "emoji",
      "emoji_thumbnails",
      "images",
      "plugins",
      "webui.json",
      "local_store.json",
      ...marketCachePaths.map((path) => basename(path)),
    ]);
    const otherDataPaths = await this.getMaiBotOtherDataPaths(dataDir, knownDataNames);

    const categories = [
      storageCategory(
        "database",
        "数据库",
        "MaiBot.db 以及 SQLite 辅助文件；当前只展示占用，不在这里清理。",
        join(dataDir, "MaiBot.db"),
        mergeStorageStats(await Promise.all(databasePaths.map(readStorageStats))),
      ),
      storageCategory(
        "images",
        "图片缓存",
        "聊天图片与消息图片文件。",
        join(dataDir, "images"),
        await readStorageStats(join(dataDir, "images")),
        "images",
      ),
      storageCategory(
        "emoji",
        "表情包缓存",
        "表情包文件与缩略图缓存。",
        join(dataDir, "emoji"),
        mergeStorageStats(await Promise.all([join(dataDir, "emoji"), join(dataDir, "emoji_thumbnails")].map(readStorageStats))),
        "emoji",
      ),
      storageCategory(
        "memory",
        "记忆数据",
        "A-Memorix 等长期记忆数据；当前只展示占用。",
        join(dataDir, "a-memorix"),
        await readStorageStats(join(dataDir, "a-memorix")),
      ),
      storageCategory(
        "plugins",
        "插件数据",
        "插件运行时写入 data/plugins 的数据。",
        join(dataDir, "plugins"),
        await readStorageStats(join(dataDir, "plugins")),
      ),
      storageCategory(
        "prompts",
        "自定义提示词",
        "Dashboard 保存的自定义 prompt 覆盖文件。",
        join(dataDir, "custom_prompts"),
        await readStorageStats(join(dataDir, "custom_prompts")),
      ),
      storageCategory(
        "webui",
        "WebUI 偏好",
        "webui.json 与本地偏好文件。",
        join(dataDir, "webui.json"),
        mergeStorageStats(await Promise.all(webuiPaths.map(readStorageStats))),
      ),
      storageCategory(
        "marketCache",
        "插件市场缓存",
        "OneKey 插件市场列表与统计缓存，可随时重建。",
        dataDir,
        mergeStorageStats(await Promise.all(marketCachePaths.map(readStorageStats))),
        "marketCache",
      ),
      storageCategory(
        "logs",
        "MaiBot 日志",
        "MaiBot Core 写入的本地日志目录。",
        logsDir,
        await readStorageStats(logsDir),
        "logs",
      ),
      storageCategory(
        "other",
        "其他 data 项",
        "未归类的 data 目录项。",
        dataDir,
        mergeStorageStats(await Promise.all(otherDataPaths.map(readStorageStats))),
      ),
    ] satisfies MaiBotStorageCategory[];

    return {
      maibotRoot: this.paths.maibotRoot,
      dataDir,
      logsDir,
      totalSizeBytes: categories.reduce((total, category) => total + category.sizeBytes, 0),
      categories,
      scannedAt: Date.now(),
    };
  }

  async cleanupMaiBotStorage(target: MaiBotStorageCleanupTarget): Promise<MaiBotStorageCleanupResult> {
    if (samePath(this.paths.maibotRoot, join(this.paths.bundledModulesRoot, "MaiBot"))) {
      throw new Error("当前指向内置模板目录，拒绝清理数据；请在打包后的环境执行。");
    }

    const dataDir = this.getMaiBotDataDir();
    const logsDir = join(this.paths.maibotRoot, "logs");
    const paths =
      target === "images"
        ? [join(dataDir, "images")]
        : target === "emoji"
          ? [join(dataDir, "emoji"), join(dataDir, "emoji_thumbnails")]
          : target === "marketCache"
            ? await this.getMaiBotMarketCachePaths(dataDir)
            : [logsDir];
    const root = target === "logs" ? logsDir : dataDir;

    let removedBytes = 0;
    const removedEntries: string[] = [];
    for (const targetPath of paths) {
      const result = await this.removeStorageTargetContents(root, targetPath);
      removedBytes += result.removedBytes;
      removedEntries.push(...result.removedEntries);
    }

    return {
      target,
      removedEntries,
      removedBytes,
      cleanedAt: Date.now(),
    };
  }

  private async addDirectoryToBackup(
    writer: TarGzipWriter,
    sourceDir: string,
    archiveDir: string,
    excludedTopLevelEntries = new Set<string>(),
    onFilePacked?: (archivePath: string, sizeBytes: number) => void,
  ): Promise<void> {
    await writer.addDirectory(archiveDir);
    if (!existsSync(sourceDir)) {
      return;
    }

    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (excludedTopLevelEntries.has(entry.name)) {
        continue;
      }
      const sourcePath = join(sourceDir, entry.name);
      const archivePath = `${archiveDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.addDirectoryToBackup(writer, sourcePath, archivePath, new Set(), onFilePacked);
      } else if (entry.isFile()) {
        const fileStat = await stat(sourcePath);
        await writer.addFile(archivePath, sourcePath, fileStat.size);
        onFilePacked?.(archivePath, fileStat.size);
      }
    }
  }

  private validateMaiBotBackupManifest(manifest: MaiBotBackupManifest): void {
    if (
      manifest?.format !== MAIBOT_BACKUP_FORMAT ||
      manifest.formatVersion !== MAIBOT_BACKUP_FORMAT_VERSION ||
      !Array.isArray(manifest.includedEntries)
    ) {
      throw new Error("不支持的 MaiBot 迁移包格式");
    }
    for (const entry of manifest.includedEntries) {
      if (entry !== "maibot/data" && entry !== "maibot/config") {
        throw new Error(`迁移包包含不支持的入口: ${entry}`);
      }
    }
  }

  private async retireExistingPath(targetPath: string, timestamp: number): Promise<string | undefined> {
    if (!existsSync(targetPath)) {
      return undefined;
    }
    const backupPath = `${targetPath}.bak.${timestamp}`;
    await rm(backupPath, { recursive: true, force: true });
    await rename(targetPath, backupPath);
    return backupPath;
  }

  private async rollbackMaiBotBackupImport({
    dataDir,
    configDir,
    backupDataDir,
    backupConfigDir,
    restoreData,
    restoreConfig,
  }: {
    dataDir: string;
    configDir: string;
    backupDataDir?: string;
    backupConfigDir?: string;
    restoreData: boolean;
    restoreConfig: boolean;
  }): Promise<void> {
    const errors: string[] = [];
    const rollbackPath = async (targetPath: string, backupPath: string | undefined): Promise<void> => {
      try {
        await rm(targetPath, { recursive: true, force: true });
        if (backupPath && existsSync(backupPath)) {
          await rename(backupPath, targetPath);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    };

    if (restoreConfig) {
      await rollbackPath(configDir, backupConfigDir);
    }
    if (restoreData) {
      await rollbackPath(dataDir, backupDataDir);
    }
    if (errors.length > 0) {
      throw new Error(`导入失败且自动回退未完全完成: ${errors.join("; ")}`);
    }
  }

  private async copyDirectoryForBackupImport(
    sourceDir: string,
    targetDir: string,
    signal: AbortSignal | undefined,
    onFileCopied?: (targetPath: string, sizeBytes: number) => void,
  ): Promise<void> {
    assertMaiBotBackupNotAborted(signal);
    await mkdir(targetDir, { recursive: true });
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      assertMaiBotBackupNotAborted(signal);
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirectoryForBackupImport(sourcePath, targetPath, signal, onFileCopied);
        continue;
      }
      if (entry.isFile()) {
        const sourceStat = await stat(sourcePath);
        await this.copyFileForBackupImport(sourcePath, targetPath, signal);
        onFileCopied?.(targetPath, sourceStat.size);
      }
    }
  }

  private async copyFileForBackupImport(
    sourcePath: string,
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertMaiBotBackupNotAborted(signal);
    await mkdir(dirname(targetPath), { recursive: true });
    const input = createReadStream(sourcePath);
    const output = createWriteStream(targetPath);
    signal?.addEventListener("abort", () => {
      const error = createMaiBotBackupAbortError();
      input.destroy(error);
      output.destroy(error);
    }, { once: true });
    try {
      for await (const chunk of input) {
        assertMaiBotBackupNotAborted(signal);
        await writeStreamChunk(output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), signal);
      }
      const finishPromise = waitForStreamFinish(output, signal);
      output.end();
      await finishPromise;
    } catch (error) {
      input.destroy();
      output.destroy();
      await rm(targetPath, { force: true });
      throw normalizeMaiBotBackupIoError(error);
    }
  }

  private async getMaiBotMarketCachePaths(dataDir: string): Promise<string[]> {
    if (!existsSync(dataDir)) {
      return [];
    }

    const entries = await readdir(dataDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^onekey-plugin-market-.+\.json$/u.test(entry.name))
      .map((entry) => join(dataDir, entry.name));
  }

  private async getMaiBotOtherDataPaths(dataDir: string, knownNames: Set<string>): Promise<string[]> {
    if (!existsSync(dataDir)) {
      return [];
    }

    const entries = await readdir(dataDir, { withFileTypes: true });
    return entries
      .filter((entry) => !knownNames.has(entry.name))
      .map((entry) => join(dataDir, entry.name));
  }

  private async removeStorageTargetContents(
    root: string,
    targetPath: string,
  ): Promise<{ removedEntries: string[]; removedBytes: number }> {
    if (!existsSync(targetPath)) {
      return { removedEntries: [], removedBytes: 0 };
    }
    if (!sameOrInsidePath(root, targetPath)) {
      throw new Error(`拒绝清理不在允许目录内的路径: ${targetPath}`);
    }

    const targetStats = await stat(targetPath);
    if (targetStats.isDirectory()) {
      const entries = await readdir(targetPath);
      let removedBytes = 0;
      const removedEntries: string[] = [];
      for (const entry of entries) {
        const entryPath = join(targetPath, entry);
        const stats = await readStorageStats(entryPath);
        removedBytes += stats.sizeBytes;
        await rm(entryPath, { recursive: true, force: true });
        removedEntries.push(entryPath);
      }
      return { removedEntries, removedBytes };
    }

    const stats = await readStorageStats(targetPath);
    await rm(targetPath, { force: true });
    return { removedEntries: [targetPath], removedBytes: stats.sizeBytes };
  }

  async resetSnowLumaComponent(): Promise<SnowLumaResetResult> {
    const bundledRoot = join(this.paths.bundledModulesRoot, "SnowLuma");
    const snowlumaRoot = this.paths.snowlumaRoot;

    if (!existsSync(bundledRoot)) {
      throw new Error(`内置 SnowLuma 模板缺失: ${bundledRoot}`);
    }

    if (samePath(bundledRoot, snowlumaRoot)) {
      throw new Error("当前 SnowLuma 目录指向内置模板，拒绝重置。请在打包后的可写数据目录中执行。");
    }

    const removed = existsSync(snowlumaRoot);
    await rm(snowlumaRoot, { recursive: true, force: true });
    await mkdir(dirname(snowlumaRoot), { recursive: true });
    await runWithoutAsar(() =>
      cp(bundledRoot, snowlumaRoot, {
        recursive: true,
        force: true,
        errorOnExist: false,
      }),
    );

    return {
      snowlumaRoot,
      bundledRoot,
      removed,
      copied: true,
      resetAt: Date.now(),
    };
  }

  async upgradeQqComponents(): Promise<QqComponentUpgradeResult> {
    const components: QqComponentUpgradeEntry[] = [];
    components.push(
      await this.upgradeBundledComponent({
        id: "napcat",
        name: "NapCat",
        moduleName: "napcat",
        isProtectedPath: isNapcatComponentProtectedPath,
      }),
    );
    components.push(
      await this.upgradeBundledComponent({
        id: "snowluma",
        name: "SnowLuma",
        moduleName: "SnowLuma",
        isProtectedPath: isSnowLumaComponentProtectedPath,
      }),
    );
    return { components, upgradedAt: Date.now() };
  }

  private agreementStorePath(): string {
    return join(this.paths.userDataRoot, AGREEMENT_STORE_FILE);
  }

  private async readAgreementStore(): Promise<StoredAgreementFile | undefined> {
    const storePath = this.agreementStorePath();
    if (!existsSync(storePath)) {
      return undefined;
    }
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredAgreementFile>;
      if (!parsed || typeof parsed !== "object" || !parsed.hashes) {
        return undefined;
      }
      return {
        version: 1,
        hashes: parsed.hashes,
        confirmedAt: typeof parsed.confirmedAt === "number" ? parsed.confirmedAt : undefined,
      };
    } catch {
      return undefined;
    }
  }

  async setQqAccount(
    qqAccount: string,
    websocketToken?: string,
    chatOverrides?: Partial<NapcatAdapterChatConfig>,
    qqBackend: QqBackend = "napcat",
  ): Promise<InitState> {
    if (!isDigits(qqAccount)) {
      throw new Error("QQ 号必须是纯数字");
    }

    await this.setQqBackend(qqBackend, { syncAdapters: false });
    const existingWebsocketServer = qqBackend === "snowluma"
      ? await this.readSnowLumaWebsocketServer(qqAccount)
      : await this.readNapcatWebsocketServer(qqAccount);
    const adapterWebsocketServer = await this.readAdapterServerFromConfig(qqBackend);
    const configuredWebsocketServer = existingWebsocketServer
      ?? (hasUsableWebsocketServerConfig(adapterWebsocketServer) ? adapterWebsocketServer : undefined);
    const resolvedWebsocketServer: NapcatWebsocketServerConfig = {
      host: configuredWebsocketServer?.host || NAPCAT_ADAPTER_HOST,
      port: configuredWebsocketServer?.port || (qqBackend === "snowluma" ? SNOWLUMA_ONEBOT_PORT : NAPCAT_ADAPTER_PORT),
      token: configuredWebsocketServer?.token || websocketToken || createWebsocketToken(),
    };

    if (qqBackend === "snowluma") {
      await this.createSnowLumaConfigs(qqAccount, resolvedWebsocketServer.token, resolvedWebsocketServer.port);
    } else {
      await this.createNapCatConfigs(qqAccount, resolvedWebsocketServer.token, resolvedWebsocketServer.port);
      await this.ensureNapCatWebUiConfig();
    }
    const initializedAdapterConfig = await this.writeQqAdapterConfigsForBackend(
      qqBackend,
      resolvedWebsocketServer,
      qqAccount,
      chatOverrides,
    );
    await this.markMessagePlatformConfigured(
      qqBackend,
      qqAccount,
      initializedAdapterConfig ? qqBackend : undefined,
    );
    return this.getState();
  }

  napcatAdapterConfigPath(): string {
    return join(
      this.findMaiBotPluginDirByManifestId(NAPCAT_ADAPTER_PLUGIN_ID) ?? join(this.paths.maibotRoot, NAPCAT_ADAPTER_DIR),
      "config.toml",
    );
  }

  snowlumaAdapterConfigPath(): string {
    return join(
      this.findMaiBotPluginDirByManifestId(SNOWLUMA_ADAPTER_PLUGIN_ID) ?? join(this.paths.maibotRoot, SNOWLUMA_ADAPTER_DIR),
      "config.toml",
    );
  }

  /**
   * Read the latest onebot11_<qq>.json that contains a WebSocket Token.
   * Reuse the same token in napcat-adapter config to avoid failed MaiBot connections.
   */
  async readNapcatWebsocketServer(qqAccount?: string): Promise<NapcatWebsocketServerConfig | undefined> {
    try {
      const configDirs = await this.findNapCatRuntimeConfigDirs();
      const onebotPattern = qqAccount
        ? new RegExp(`^onebot11_${escapeRegExp(qqAccount)}\\.json$`, "i")
        : /^onebot11_\d+\.json$/i;
      for (const configDir of configDirs) {
        if (!existsSync(configDir)) continue;
        const entries = await readdir(configDir);
        const onebotFile = entries.find((name) => onebotPattern.test(name));
        if (!onebotFile) continue;
        const raw = await readFile(join(configDir, onebotFile), "utf8");
        const parsed = JSON.parse(raw) as {
          network?: { websocketServers?: Array<{ host?: string; token?: string; port?: number }> };
        };
        const server =
          parsed?.network?.websocketServers?.find((entry) => entry?.port === NAPCAT_ADAPTER_PORT && entry?.token) ??
          parsed?.network?.websocketServers?.find((entry) => entry?.token);
        if (server?.token) {
          return {
            host: server.host ? String(server.host) : NAPCAT_ADAPTER_HOST,
            port: Number.isFinite(server.port) && server.port ? Math.floor(server.port) : NAPCAT_ADAPTER_PORT,
            token: String(server.token),
          };
        }
      }
    } catch {
      // ignore and fall through to empty token
    }
    return undefined;
  }

  async readNapcatWebsocketToken(qqAccount?: string): Promise<string> {
    return (await this.readNapcatWebsocketServer(qqAccount))?.token ?? "";
  }

  async readSnowLumaWebsocketServer(qqAccount?: string): Promise<NapcatWebsocketServerConfig | undefined> {
    if (!qqAccount) {
      return undefined;
    }

    try {
      const raw = await readFile(join(this.paths.snowlumaRoot, "config", `onebot_${qqAccount}.json`), "utf8");
      const parsed = JSON.parse(raw) as {
        networks?: {
          wsServers?: Array<{ host?: string; port?: number; accessToken?: string }>;
        };
      };
      const server =
        parsed.networks?.wsServers?.find((entry) => entry?.port === SNOWLUMA_ONEBOT_PORT && entry?.accessToken) ??
        parsed.networks?.wsServers?.find((entry) => entry?.accessToken) ??
        parsed.networks?.wsServers?.[0];
      if (!server?.port) {
        return undefined;
      }
      return {
        host: server.host ? String(server.host) : NAPCAT_ADAPTER_HOST,
        port: Number.isFinite(server.port) ? Math.floor(server.port) : SNOWLUMA_ONEBOT_PORT,
        token: server.accessToken ? String(server.accessToken) : "",
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Create/update napcat-adapter config.toml. The token comes from the current setQqAccount flow.
   * Chat settings use values entered in the setup UI, falling back to defaults when absent.
   */
  private async writeQqAdapterConfigsForBackend(
    qqBackend: QqBackend,
    selectedWebsocketServer: NapcatWebsocketServerConfig,
    qqAccount?: string,
    chatOverrides?: Partial<NapcatAdapterChatConfig>,
  ): Promise<boolean> {
    const napcatServer = qqBackend === "napcat"
      ? selectedWebsocketServer
      : await this.resolveNapcatAdapterServer(qqAccount);
    const snowlumaServer = qqBackend === "snowluma"
      ? selectedWebsocketServer
      : await this.resolveSnowLumaAdapterServer(qqAccount);

    if (qqBackend === "snowluma") {
      const wroteInactive = await this.writeNapcatAdapterConfigForServer(napcatServer, chatOverrides, false);
      const wroteSelected = await this.writeSnowLumaAdapterConfigForServer(snowlumaServer, chatOverrides, true);
      return wroteSelected || wroteInactive;
    }

    const wroteSelected = await this.writeNapcatAdapterConfigForServer(napcatServer, chatOverrides, true);
    const wroteInactive = await this.writeSnowLumaAdapterConfigForServer(snowlumaServer, chatOverrides, false);
    return wroteSelected || wroteInactive;
  }

  private async resolveNapcatAdapterServer(qqAccount?: string): Promise<NapcatWebsocketServerConfig> {
    const existing = await this.readNapcatWebsocketServer(qqAccount);
    return {
      host: NAPCAT_ADAPTER_HOST,
      port: NAPCAT_ADAPTER_PORT,
      token: existing?.token || createWebsocketToken(),
    };
  }

  private async resolveSnowLumaAdapterServer(qqAccount?: string): Promise<NapcatWebsocketServerConfig> {
    const existing = await this.readSnowLumaWebsocketServer(qqAccount);
    return {
      host: NAPCAT_ADAPTER_HOST,
      port: SNOWLUMA_ONEBOT_PORT,
      token: existing?.token || createWebsocketToken(),
    };
  }

  private async syncSelectedQqAdapterConfigs(): Promise<string[]> {
    const qqAccount = await this.readConfiguredQqAccount();
    if (!qqAccount) {
      return [];
    }

    const qqBackend = await this.readQqBackend();
    let websocketServer = qqBackend === "snowluma"
      ? await this.readSnowLumaWebsocketServer(qqAccount)
      : await this.readNapcatWebsocketServer(qqAccount);

    websocketServer = {
      host: websocketServer?.host || NAPCAT_ADAPTER_HOST,
      port: websocketServer?.port || (qqBackend === "snowluma" ? SNOWLUMA_ONEBOT_PORT : NAPCAT_ADAPTER_PORT),
      token: websocketServer?.token || createWebsocketToken(),
    };
    if (qqBackend === "snowluma") {
      await this.createSnowLumaConfigs(qqAccount, websocketServer.token, websocketServer.port);
    } else {
      await this.createNapCatConfigs(qqAccount, websocketServer.token, websocketServer.port);
      await this.ensureNapCatWebUiConfig();
    }

    await this.writeQqAdapterConfigsForBackend(qqBackend, websocketServer, qqAccount);
    return [
      this.napcatAdapterConfigPath(),
      this.snowlumaAdapterConfigPath(),
    ].filter((path) => existsSync(path));
  }

  private async writeNapcatAdapterConfigForServer(
    websocketServer: NapcatWebsocketServerConfig,
    chatOverrides?: Partial<NapcatAdapterChatConfig>,
    enabled = true,
  ): Promise<boolean> {
    const defaults = buildDefaultNapcatAdapterConfig(websocketServer.token, websocketServer.port);
    let existing: NapcatAdapterConfig = defaults;
    const configPath = this.napcatAdapterConfigPath();
    const adapterRoot = dirname(configPath);

    if (!existsSync(adapterRoot)) {
      return false;
    }

    if (existsSync(configPath)) {
      try {
        const text = await readFile(configPath, "utf8");
        const parsed = parseToml(text);
        if (parsed && typeof parsed === "object") {
          existing = normalizeNapcatAdapterConfig(parsed as Record<string, unknown>, defaults);
        }
      } catch {
        // On parse failure, use default values directly.
      }
    }

    const merged: NapcatAdapterConfig = {
      ...existing,
      plugin: {
        enabled,
        configVersion: NAPCAT_ADAPTER_CONFIG_VERSION,
      },
      server: {
        ...existing.server,
        host: websocketServer.host,
        port: websocketServer.port,
        token: websocketServer.token,
      },
      chat: applyChatOverrides(existing.chat, chatOverrides),
    };

    await writeFile(configPath, napcatAdapterConfigToToml(merged), "utf8");
    return true;
  }

  private async writeSnowLumaAdapterConfigForServer(
    websocketServer: NapcatWebsocketServerConfig,
    chatOverrides?: Partial<NapcatAdapterChatConfig>,
    enabled = true,
  ): Promise<boolean> {
    const defaults = buildDefaultNapcatAdapterConfig(websocketServer.token, websocketServer.port);
    defaults.plugin.configVersion = SNOWLUMA_ADAPTER_CONFIG_VERSION;
    defaults.server.actionTimeoutSec = 10;

    let existing: NapcatAdapterConfig = defaults;
    const configPath = this.snowlumaAdapterConfigPath();
    const adapterRoot = dirname(configPath);

    if (!existsSync(adapterRoot)) {
      return false;
    }

    if (existsSync(configPath)) {
      try {
        const text = await readFile(configPath, "utf8");
        const parsed = parseToml(text);
        if (parsed && typeof parsed === "object") {
          existing = normalizeNapcatAdapterConfig(parsed as Record<string, unknown>, defaults);
        }
      } catch {
        // 解析失败则直接以默认值覆盖
      }
    }

    const merged: NapcatAdapterConfig = {
      ...existing,
      plugin: {
        enabled,
        configVersion: SNOWLUMA_ADAPTER_CONFIG_VERSION,
      },
      server: {
        ...existing.server,
        host: websocketServer.host,
        port: websocketServer.port,
        token: websocketServer.token,
      },
      chat: applyChatOverrides(existing.chat, chatOverrides),
    };

    await writeFile(configPath, snowlumaAdapterConfigToToml(merged), "utf8");
    return true;
  }

  async ensureModulesReady(): Promise<string[]> {
    return [
      ...(await this.ensureServiceReady("maibot")),
      ...(await this.ensureServiceReady("napcat")),
      ...(await this.ensureBundledPythonOverrides()),
    ];
  }

  async ensureServiceReady(serviceId: ServiceId): Promise<string[]> {
    await mkdir(this.paths.logsRoot, { recursive: true });

    if (!existsSync(this.paths.bundledModulesRoot)) {
      throw new Error(`内置 modules 模板缺失: ${this.paths.bundledModulesRoot}`);
    }

    if (serviceId === "maibot") {
      const changedFiles = await this.ensureBundledModuleSubtree("MaiBot", ["bot.py"], {
        excludeRelativePaths: [NAPCAT_ADAPTER_DIR, SNOWLUMA_ADAPTER_DIR],
      });
      changedFiles.push(...(await this.ensureBundledMaiBotPluginSubtree(NAPCAT_ADAPTER_DIR, ["plugin.py"], NAPCAT_ADAPTER_PLUGIN_ID)));
      changedFiles.push(...(await this.ensureBundledMaiBotPluginSubtree(SNOWLUMA_ADAPTER_DIR, ["plugin.py"], SNOWLUMA_ADAPTER_PLUGIN_ID)));
      const repairedConfig = await this.repairBotConfigVersionInfo();
      return [...changedFiles, ...(repairedConfig ? [repairedConfig] : [])];
    }

    const qqBackend = await this.readQqBackend();
    if (qqBackend === "snowluma") {
      return this.ensureBundledModuleSubtree("SnowLuma", [
        "node.exe",
        "index.mjs",
        "launcher.bat",
      ], {
        excludeRelativePaths: ["config", "data", "logs"],
      });
    }

    const changedFiles = await this.ensureBundledModuleSubtree("napcat", [
      "node.exe",
      "index.js",
      "config.json",
      join("napcat", "package.json"),
    ], {
      excludeRelativePaths: [
        "config",
        "data",
        "logs",
        join("napcat", "config"),
        join("napcat", "data"),
        join("napcat", "logs"),
      ],
    });
    const launcher = await this.ensureNapCatLauncher();
    if (launcher) {
      changedFiles.push(launcher);
    }
    return changedFiles;
  }

  private async upgradeBundledComponent(spec: BundledComponentUpgradeSpec): Promise<QqComponentUpgradeEntry> {
    const bundledRoot = join(this.paths.bundledModulesRoot, spec.moduleName);
    const targetRoot = this.moduleTargetRoot(spec.moduleName);
    const upgradedAt = Date.now();

    if (!existsSync(bundledRoot)) {
      throw new Error(`内置 ${spec.name} 模板缺失: ${bundledRoot}`);
    }

    if (samePath(bundledRoot, targetRoot)) {
      return {
        id: spec.id,
        name: spec.name,
        root: targetRoot,
        bundledRoot,
        preservedEntries: [],
        copied: false,
        skipped: true,
        upgradedAt,
      };
    }

    const backupRoot = join(dirname(targetRoot), `.maibot-${spec.id}-upgrade-${upgradedAt}`);
    const preservedEntries = existsSync(targetRoot)
      ? await this.moveProtectedComponentEntries(targetRoot, backupRoot, spec.isProtectedPath)
      : [];

    try {
      await rm(targetRoot, { recursive: true, force: true });
      await mkdir(dirname(targetRoot), { recursive: true });
      await runWithoutAsar(() =>
        cp(bundledRoot, targetRoot, {
          recursive: true,
          force: true,
          errorOnExist: false,
          filter: (sourcePath) => {
            if (samePath(sourcePath, bundledRoot)) {
              return true;
            }
            const relativePath = normalizeRelativePath(relative(bundledRoot, sourcePath));
            return !spec.isProtectedPath(relativePath);
          },
        }),
      );
      await this.restoreProtectedComponentEntries(backupRoot, targetRoot, preservedEntries);
    } catch (error) {
      await this.restoreProtectedComponentEntries(backupRoot, targetRoot, preservedEntries).catch(() => undefined);
      throw error;
    } finally {
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      id: spec.id,
      name: spec.name,
      root: targetRoot,
      bundledRoot,
      preservedEntries,
      copied: true,
      skipped: false,
      upgradedAt,
    };
  }

  private async moveProtectedComponentEntries(
    root: string,
    backupRoot: string,
    isProtectedPath: (relativePath: string) => boolean,
  ): Promise<string[]> {
    const entries: string[] = [];

    const visit = async (currentRoot: string, relativeRoot = ""): Promise<void> => {
      let children: Dirent[];
      try {
        children = await readdir(currentRoot, { withFileTypes: true });
      } catch {
        return;
      }

      for (const child of children) {
        const relativePath = normalizeRelativePath(join(relativeRoot, child.name));
        const sourcePath = join(root, relativePath);
        if (isProtectedPath(relativePath)) {
          const backupPath = join(backupRoot, ...relativePath.split("/"));
          await mkdir(dirname(backupPath), { recursive: true });
          await this.movePath(sourcePath, backupPath);
          entries.push(relativePath);
          continue;
        }

        if (child.isDirectory()) {
          await visit(sourcePath, relativePath);
        }
      }
    };

    await visit(root);
    return entries;
  }

  private async restoreProtectedComponentEntries(backupRoot: string, targetRoot: string, relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      const backupPath = join(backupRoot, ...relativePath.split("/"));
      if (!existsSync(backupPath)) {
        continue;
      }
      const targetPath = join(targetRoot, ...relativePath.split("/"));
      await mkdir(dirname(targetPath), { recursive: true });
      await rm(targetPath, { recursive: true, force: true });
      await this.movePath(backupPath, targetPath);
    }
  }

  private async movePath(source: string, target: string): Promise<void> {
    try {
      await rename(source, target);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EXDEV") {
        throw error;
      }
      await cp(source, target, { recursive: true, force: true, errorOnExist: false });
      await rm(source, { recursive: true, force: true });
    }
  }

  async ensureBundledPythonOverrides(): Promise<string[]> {
    const bundledRoot = join(dirname(this.paths.runtimeRoot), "python-overrides");
    const targetRoot = this.paths.pythonOverridesRoot;
    if (!existsSync(bundledRoot) || samePath(bundledRoot, targetRoot)) {
      return [];
    }

    let bundledEntries: string[];
    try {
      bundledEntries = (await readdir(bundledRoot)).filter((entry) => !PYTHON_OVERRIDES_IGNORED_ENTRIES.has(entry));
    } catch {
      return [];
    }
    if (bundledEntries.length === 0) {
      return [];
    }

    let targetEntries: string[] = [];
    try {
      targetEntries = (await readdir(targetRoot)).filter((entry) => !PYTHON_OVERRIDES_IGNORED_ENTRIES.has(entry));
    } catch {
      targetEntries = [];
    }
    if (targetEntries.length > 0) {
      return [];
    }

    await mkdir(dirname(targetRoot), { recursive: true });
    await runWithoutAsar(() =>
      cp(bundledRoot, targetRoot, {
        recursive: true,
        force: false,
        errorOnExist: false,
      }),
    );
    return [targetRoot];
  }

  /**
   * Generate a fixed launcher .cmd under the napcat directory; it runs chcp 65001 before the exe.
   * Avoid building a `cmd /C` command string in source while keeping the console in UTF-8.
   * This prevents garbled Chinese output.
   */
  private async ensureNapCatLauncher(): Promise<string | undefined> {
    const napcatRoot = this.paths.napcatRoot;
    if (!existsSync(napcatRoot)) {
      return undefined;
    }

    const launcherPath = join(napcatRoot, NAPCAT_LAUNCHER_FILE);
    const desired = NAPCAT_LAUNCHER_CONTENT;

    if (existsSync(launcherPath)) {
      try {
        const current = await readFile(launcherPath, "utf8");
        if (current === desired) {
          return undefined;
        }
      } catch {
        // 读不到就重写
      }
    }

    await writeFile(launcherPath, desired, "utf8");
    return launcherPath;
  }

  async readQqAccount(): Promise<string | undefined> {
    const botConfigPath = this.botConfigPath();
    if (!existsSync(botConfigPath)) {
      return undefined;
    }

    const content = await readFile(botConfigPath, "utf8");
    const match = content.match(QQ_PATTERN);
    return match?.[1];
  }

  async getBotAccountConfigState(): Promise<{ configured: boolean; qqAccount?: string }> {
    const qqAccount = await this.readQqAccount();
    return {
      configured: Boolean(qqAccount && isDigits(qqAccount) && !UNCONFIGURED_QQ_ACCOUNTS.has(qqAccount)),
      qqAccount,
    };
  }

  private async readConfiguredQqAccount(): Promise<string | undefined> {
    const qqAccount = await this.readQqAccount();
    if (qqAccount) {
      return qqAccount;
    }

    return this.readStoredMessagePlatformQqAccount();
  }

  private readStoredMessagePlatformQqAccount(): string | undefined {
    const storedQqAccount = this.readMessagePlatformStore()?.qqAccount?.trim();
    return storedQqAccount && isDigits(storedQqAccount) ? storedQqAccount : undefined;
  }

  private async repairBotConfigQqAccountFromMessagePlatformStore(): Promise<string | undefined> {
    const storedQqAccount = this.readStoredMessagePlatformQqAccount();
    if (!storedQqAccount || await this.readQqAccount()) {
      return undefined;
    }

    const botConfigPath = this.botConfigPath();
    const content = await this.readOrCreateBotConfigContent();
    const repaired = ensureBotQqConfig(content, storedQqAccount);
    if (repaired === content) {
      return undefined;
    }

    await mkdir(dirname(botConfigPath), { recursive: true });
    await writeFile(botConfigPath, repaired, "utf8");
    return botConfigPath;
  }

  getPythonPath(): string {
    const bundledPython = this.getBundledPythonPath();
    if (bundledPython) {
      return bundledPython;
    }

    return this.findSystemPythonPath() ?? this.getBundledPythonCandidates()[0];
  }

  async listSystemPythonRuntimeCandidates(): Promise<PythonRuntimeCandidate[]> {
    const candidates = systemPythonCandidateDetails();
    if (process.platform !== "win32") {
      return candidates;
    }

    try {
      const output = await runProcess("py", ["-0p"], this.paths.installRoot, 3_000);
      return uniquePythonCandidates([...parsePyLauncherPaths(output), ...candidates]);
    } catch {
      return candidates;
    }
  }

  getGitPath(): string {
    const customGit = readRuntimePathOverride(this.paths, "git");
    if (customGit) {
      return customGit;
    }

    return this.getDefaultGitPath();
  }

  getDefaultGitPath(): string {
    const bundledGit = this.getBundledGitPath();
    if (bundledGit) {
      return bundledGit;
    }

    return this.findSystemGitPath() ?? this.getBundledGitCandidates()[0];
  }

  private getPythonRoot(): string {
    return join(this.paths.runtimeRoot, PYTHON_RUNTIME_DIR);
  }

  private getBundledPythonCandidates(): string[] {
    const root = this.getPythonRoot();
    return [
      join(root, "python.exe"),
      join(root, "bin", "python.exe"),
      join(root, "python"),
      join(root, "bin", "python3"),
      join(root, "bin", "python"),
    ];
  }

  private getBundledPythonPath(): string | undefined {
    return uniqueExistingPaths(this.getBundledPythonCandidates())[0];
  }

  private findSystemPythonPath(): string | undefined {
    return uniqueExistingPaths(systemPythonCandidates())[0];
  }

  private getGitRoot(): string {
    return join(this.paths.runtimeRoot, GIT_RUNTIME_DIR);
  }

  private getBundledGitCandidates(): string[] {
    const root = this.getGitRoot();
    return [
      join(root, "bin", "git.exe"),
      join(root, "cmd", "git.exe"),
      join(root, "git.exe"),
      join(root, "bin", "git"),
    ];
  }

  private getBundledGitPath(): string | undefined {
    return uniqueExistingPaths(this.getBundledGitCandidates())[0];
  }

  private findSystemGitPath(): string | undefined {
    return uniqueExistingPaths(systemGitCandidates())[0];
  }

  private checkRuntimeRoot(): InitCheck {
    if (existsSync(this.paths.runtimeRoot)) {
      return {
        id: "runtime",
        label: "内置 runtime",
        status: "ok",
        detail: "已找到",
        path: this.paths.runtimeRoot,
      };
    }

    return {
      id: "runtime",
      label: "内置 runtime",
      status: "warning",
      detail: "未找到内置 runtime，将使用系统 Python 与 Git",
      path: this.paths.runtimeRoot,
    };
  }

  private checkPythonRuntime(): InitCheck {
    const bundledPython = this.getBundledPythonPath();
    if (bundledPython) {
      return {
        id: "python-runtime",
        label: "Python 运行时",
        status: "ok",
        detail: "使用内置 Python",
        path: bundledPython,
      };
    }

    const systemPython = this.findSystemPythonPath();
    if (systemPython) {
      return {
        id: "python-runtime",
        label: "Python 运行时",
        status: "ok",
        detail: `使用系统 Python，后台检查版本是否 >= ${PYTHON_MINIMUM_VERSION}`,
        path: systemPython,
      };
    }

    return {
      id: "python-runtime",
      label: "Python 运行时",
      status: "error",
      detail: `未找到内置 Python 或系统 Python ${PYTHON_MINIMUM_VERSION}+`,
      path: this.getBundledPythonCandidates()[0],
      actionLabel: "下载 Python",
      actionUrl: PYTHON_DOWNLOAD_URL,
    };
  }

  private async ensureBundledModuleSubtree(
    moduleName: string,
    requiredRelativePaths: string[],
    optionalOrOptions: boolean | { optional?: boolean; excludeRelativePaths?: string[] } = false,
  ): Promise<string[]> {
    const options = typeof optionalOrOptions === "boolean" ? { optional: optionalOrOptions } : optionalOrOptions;
    const source = join(this.paths.bundledModulesRoot, moduleName);
    const target = this.moduleTargetRoot(moduleName);

    if (!existsSync(source)) {
      if (options.optional) {
        return [];
      }

      throw new Error(`内置 ${moduleName} 模板缺失: ${source}`);
    }

    if (samePath(source, target)) {
      return [];
    }

    const isReady = requiredRelativePaths.every((relativePath) => existsSync(join(target, relativePath)));
    if (isReady) {
      return [];
    }

    await mkdir(dirname(target), { recursive: true });
    const excludedSources = (options.excludeRelativePaths ?? []).map((relativePath) => join(source, relativePath));
    await runWithoutAsar(() =>
      cp(source, target, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (sourcePath) => !excludedSources.some((excludedSource) => sameOrInsidePath(excludedSource, sourcePath)),
      }),
    );

    return [target];
  }

  private async ensureBundledMaiBotPluginSubtree(
    pluginRelativePath: string,
    requiredRelativePaths: string[],
    expectedPluginId?: string,
  ): Promise<string[]> {
    const source = join(this.paths.bundledModulesRoot, "MaiBot", pluginRelativePath);
    const target = join(this.paths.maibotRoot, pluginRelativePath);

    if (!existsSync(source) || samePath(source, target)) {
      return [];
    }

    const sourcePluginId = expectedPluginId ?? this.readPluginManifestId(source);
    if (sourcePluginId && this.findMaiBotPluginDirByManifestId(sourcePluginId)) {
      return [];
    }

    const isReady = requiredRelativePaths.every((relativePath) => existsSync(join(target, relativePath)));
    if (isReady) {
      return [];
    }

    await mkdir(dirname(target), { recursive: true });
    await runWithoutAsar(() =>
      cp(source, target, {
        recursive: true,
        force: false,
        errorOnExist: false,
      }),
    );
    return [target];
  }

  private findMaiBotPluginDirByManifestId(pluginId: string): string | undefined {
    const pluginsRoot = join(this.paths.maibotRoot, "plugins");
    if (!existsSync(pluginsRoot)) {
      return undefined;
    }

    try {
      for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const pluginDir = join(pluginsRoot, entry.name);
        if (this.readPluginManifestId(pluginDir) === pluginId) {
          return pluginDir;
        }
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private readPluginManifestId(pluginDir: string): string | undefined {
    const manifestPath = join(pluginDir, "_manifest.json");
    if (!existsSync(manifestPath)) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: unknown };
      return typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private moduleTargetRoot(moduleName: string): string {
    if (moduleName === "MaiBot") {
      return this.paths.maibotRoot;
    }
    if (moduleName === "napcat") {
      return this.paths.napcatRoot;
    }
    if (moduleName === "SnowLuma") {
      return this.paths.snowlumaRoot;
    }
    return join(this.paths.modulesRoot, moduleName);
  }

  async ensureNapCatWebUiConfig(): Promise<string | undefined> {
    const existing = await this.readNapCatWebUiToken();
    if (existing.token) {
      return existing.token;
    }

    if (existing.exists) {
      throw new Error(existing.error ?? "NapCat WebUI config exists but token is missing; please check webui.json manually");
    }

    const configDirs = await this.findNapCatWebUiConfigDirs();
    if (configDirs.length === 0) {
      return undefined;
    }

    const token = randomBytes(6).toString("hex");
    const defaultJson = {
      host: "0.0.0.0",
      port: 6099,
      token,
      loginRate: 10,
      autoLoginAccount: "",
      theme: { dark: {}, light: {} },
      disableWebUI: false,
      disableNonLANAccess: false,
    };

    for (const configDir of configDirs) {
      const target = join(configDir, "webui.json");
      if (existsSync(target)) {
        continue;
      }

      await mkdir(configDir, { recursive: true });
      await writeFile(target, JSON.stringify(defaultJson, null, 2), "utf8");
    }

    return token;
  }

  async readNapCatWebUiToken(): Promise<{ token?: string; exists: boolean; error?: string }> {
    const candidates = await this.findNapCatWebUiFiles();
    let sawExisting = false;
    let firstError: string | undefined;

    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue;
      }

      sawExisting = true;
      try {
        const raw = JSON.parse(await readFile(candidate, "utf8")) as { token?: unknown };
        if (typeof raw.token === "string" && raw.token.length > 0) {
          return { token: raw.token, exists: true };
        }
        firstError ??= `缺少 token: ${candidate}`;
      } catch (error) {
        firstError ??= `JSON 格式错误: ${candidate}: ${toDetail(error)}`;
      }
    }

    return { exists: sawExisting, error: firstError };
  }

  readMaiBotWebUiEndpointSync(): { host: string; port: number; url: string } {
    const fallback = buildMaiBotWebUiEndpoint();
    const candidates = uniqueExistingPaths([
      this.botConfigPath(),
      join(this.paths.bundledModulesRoot, "MaiBot", "config", "bot_config.toml"),
    ]);

    for (const candidate of candidates) {
      try {
        const config = readTomlTable(readFileSync(candidate, "utf8"), "webui");
        if (!config) {
          continue;
        }

        return buildMaiBotWebUiEndpoint(
          asString(config["host"], fallback.host),
          asTcpPort(config["port"], fallback.port),
        );
      } catch {
        continue;
      }
    }

    return fallback;
  }

  /**
   * Read MaiBot Core WebUI access_token for composing the WebUI entry URL.
   * `?token=<access_token>` performs automatic login.
   * If the file or field is missing, return an empty token and let callers use the plain root URL.
   */
  async readMaiBotWebUiToken(): Promise<{ token?: string; exists: boolean; error?: string }> {
    const candidates = [
      join(this.paths.maibotRoot, "data", "webui.json"),
      join(this.paths.bundledModulesRoot, "MaiBot", "data", "webui.json"),
    ];

    let sawExisting = false;
    let firstError: string | undefined;

    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue;
      }

      sawExisting = true;
      try {
        const raw = JSON.parse(await readFile(candidate, "utf8")) as { access_token?: unknown };
        if (typeof raw.access_token === "string" && raw.access_token.length > 0) {
          return { token: raw.access_token, exists: true };
        }
        firstError ??= `缺少 access_token: ${candidate}`;
      } catch (error) {
        firstError ??= `JSON 格式错误: ${candidate}: ${toDetail(error)}`;
      }
    }

    return { exists: sawExisting, error: firstError };
  }

  private botConfigPath(): string {
    return join(this.paths.maibotRoot, "config", "bot_config.toml");
  }

  private qqBackendPath(): string {
    return join(this.paths.userDataRoot, QQ_BACKEND_FILE);
  }

  private messagePlatformPath(): string {
    return join(this.paths.userDataRoot, MESSAGE_PLATFORM_FILE);
  }

  private readMessagePlatformStore(): StoredMessagePlatformFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.messagePlatformPath(), "utf8")) as Partial<StoredMessagePlatformFile>;
      const backend = parsed.backend === "snowluma" ? "snowluma" : parsed.backend === "napcat" ? "napcat" : undefined;
      const initialized = parsed.adapterConfigInitialized && typeof parsed.adapterConfigInitialized === "object"
        ? parsed.adapterConfigInitialized
        : {};
      return {
        version: 1,
        backend,
        qqAccount: typeof parsed.qqAccount === "string" ? parsed.qqAccount : undefined,
        configuredAt: typeof parsed.configuredAt === "number" ? parsed.configuredAt : undefined,
        adapterConfigInitialized: {
          napcat: typeof initialized.napcat === "number" ? initialized.napcat : undefined,
          snowluma: typeof initialized.snowluma === "number" ? initialized.snowluma : undefined,
        },
      };
    } catch {
      return undefined;
    }
  }

  private hasAdapterConfigInitializedMarker(backend: QqBackend): boolean {
    return typeof this.readMessagePlatformStore()?.adapterConfigInitialized?.[backend] === "number";
  }

  private async isAdapterConfigInitialized(backend: QqBackend): Promise<boolean> {
    const configPath = backend === "snowluma"
      ? this.snowlumaAdapterConfigPath()
      : this.napcatAdapterConfigPath();
    if (!existsSync(configPath)) {
      return false;
    }

    if (this.hasAdapterConfigInitializedMarker(backend)) {
      return true;
    }

    return hasUsableWebsocketServerConfig(await this.readAdapterServerFromConfig(backend));
  }

  private async readAdapterServerFromConfig(backend: QqBackend): Promise<NapcatWebsocketServerConfig | undefined> {
    const configPath = backend === "snowluma"
      ? this.snowlumaAdapterConfigPath()
      : this.napcatAdapterConfigPath();
    if (!existsSync(configPath)) {
      return undefined;
    }

    const defaults = buildDefaultNapcatAdapterConfig(
      "",
      backend === "snowluma" ? SNOWLUMA_ONEBOT_PORT : NAPCAT_ADAPTER_PORT,
    );
    if (backend === "snowluma") {
      defaults.plugin.configVersion = SNOWLUMA_ADAPTER_CONFIG_VERSION;
      defaults.server.actionTimeoutSec = 10;
    }

    try {
      const parsed = parseToml(await readFile(configPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        return normalizeNapcatAdapterConfig(parsed as Record<string, unknown>, defaults).server;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private async markMessagePlatformConfigured(
    backend: QqBackend,
    qqAccount: string,
    initializedBackend?: QqBackend,
  ): Promise<void> {
    const existing = this.readMessagePlatformStore();
    const adapterConfigInitialized = {
      ...(existing?.adapterConfigInitialized ?? {}),
    };
    if (initializedBackend) {
      adapterConfigInitialized[initializedBackend] = Date.now();
    }

    await mkdir(dirname(this.messagePlatformPath()), { recursive: true });
    await writeFile(
      this.messagePlatformPath(),
      `${JSON.stringify({
        version: 1,
        backend,
        qqAccount,
        configuredAt: existing?.configuredAt ?? Date.now(),
        updatedAt: Date.now(),
        adapterConfigInitialized,
      }, null, 2)}\n`,
      "utf8",
    );
  }

  private agreementSourcePath(fileName: string): string {
    const writablePath = join(this.paths.maibotRoot, fileName);
    if (existsSync(writablePath)) {
      return writablePath;
    }

    return join(this.paths.bundledModulesRoot, "MaiBot", fileName);
  }

  private async readAgreementDocument(
    {
      id,
      title,
      fileName,
    }: {
      id: AgreementDocumentId;
      title: string;
      fileName: string;
      envVar: string;
    },
    stored: StoredAgreementFile | undefined,
  ): Promise<AgreementDocument> {
    const sourcePath = this.agreementSourcePath(fileName);
    const confirmPath = this.agreementStorePath();
    if (!existsSync(sourcePath)) {
      return {
        id,
        title,
        fileName,
        sourcePath,
        confirmPath,
        content: "",
        hash: "",
        exists: false,
        confirmed: false,
        error: `${fileName} 文件缺失`,
      };
    }

    try {
      const content = await readFile(sourcePath, "utf8");
      const hash = md5Utf8(content);
      const confirmed = stored?.hashes?.[id] === hash;
      return {
        id,
        title,
        fileName,
        sourcePath,
        confirmPath,
        content,
        hash,
        exists: true,
        confirmed,
      };
    } catch (error) {
      return {
        id,
        title,
        fileName,
        sourcePath,
        confirmPath,
        content: "",
        hash: "",
        exists: false,
        confirmed: false,
        error: toDetail(error),
      };
    }
  }

  private async readOrCreateBotConfigContent(): Promise<string> {
    const botConfigPath = this.botConfigPath();
    const configVersion = maibotInitialConfigVersion(await this.readMaiBotConfigVersion());
    if (!existsSync(botConfigPath)) {
      return `[inner]\nversion = "${configVersion}"\n\n[bot]\nplatform = "qq"\n`;
    }

    const content = await readFile(botConfigPath, "utf8");
    return ensureInnerVersion(content, configVersion);
  }

  private async repairBotConfigVersionInfo(): Promise<string | undefined> {
    const botConfigPath = this.botConfigPath();
    if (!existsSync(botConfigPath)) {
      return undefined;
    }

    const content = await readFile(botConfigPath, "utf8");
    const repaired = ensureInnerVersion(content, maibotInitialConfigVersion(await this.readMaiBotConfigVersion()));
    if (repaired === content) {
      return undefined;
    }

    await writeFile(botConfigPath, repaired, "utf8");
    return botConfigPath;
  }

  private async readMaiBotConfigVersion(): Promise<string> {
    const candidates = [
      join(this.paths.maibotRoot, "src", "config", "config.py"),
      join(this.paths.bundledModulesRoot, "MaiBot", "src", "config", "config.py"),
    ];

    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue;
      }

      try {
        const content = await readFile(candidate, "utf8");
        const match = content.match(/^\s*CONFIG_VERSION\s*:\s*str\s*=\s*["']([^"']+)["']/mu)
          ?? content.match(/^\s*CONFIG_VERSION\s*=\s*["']([^"']+)["']/mu);
        const version = match?.[1]?.trim();
        if (version) {
          return version;
        }
      } catch {
        // Try the next source, then fall back to the bundled-safe version.
      }
    }

    return MAIBOT_FALLBACK_CONFIG_VERSION;
  }

  private async checkDependencies(): Promise<InitCheck[]> {
    const cached = this.dependencyCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.checks;
    }

    const checks: InitCheck[] = [];
    const python = this.getPythonPath();
    const bundledPython = this.getBundledPythonPath();
    const pythonSource = bundledPython && samePath(bundledPython, python) ? "内置 Python" : "系统 Python";
    if (!existsSync(python)) {
      checks.push({
        id: "python-dependencies",
        label: "Python 依赖完整性",
        status: "error",
        detail: `未找到内置 Python 或系统 Python ${PYTHON_MINIMUM_VERSION}+，无法检查依赖`,
        path: python,
        actionLabel: "下载 Python",
        actionUrl: PYTHON_DOWNLOAD_URL,
      });
    } else {
      try {
        const output = await runProcess(
          python,
          [
            "-c",
            [
              "import sys, ssl, sqlite3, tomllib",
              `minimum = (${PYTHON_MINIMUM_VERSION.split(".").join(", ")})`,
              "version = f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}'",
              `if sys.version_info < minimum: raise SystemExit(f'Python {version} is too old; need >= ${PYTHON_MINIMUM_VERSION}')`,
              "print(f'Python {version}')",
            ].join("\n"),
          ],
          this.paths.installRoot,
        );
        checks.push({
          id: "python-runtime-smoke",
          label: "Python 标准库",
          status: "ok",
          detail: output ? `${output} (${pythonSource})` : `${pythonSource} 可启动，ssl/sqlite3/tomllib 可导入`,
          path: python,
        });
      } catch (error) {
        checks.push({
          id: "python-runtime-smoke",
          label: "Python 标准库",
          status: "error",
          detail: `Python 版本或标准库不符合要求: ${toDetail(error)}`,
          path: python,
          actionLabel: "下载 Python",
          actionUrl: PYTHON_DOWNLOAD_URL,
        });
      }

      try {
        const output = await runProcess(python, ["-m", "pip", "check"], this.paths.installRoot, 15_000);
        checks.push({
          id: "python-pip-check",
          label: "Python 包依赖",
          status: "ok",
          detail: output || "pip check 未发现损坏依赖",
          path: python,
        });
      } catch (error) {
        const detail = toDetail(error);
        checks.push(
          isCleanPipCheckOutput(detail)
            ? {
                id: "python-pip-check",
                label: "Python 包依赖",
                status: "ok",
                detail,
                path: python,
              }
            : {
                id: "python-pip-check",
                label: "Python 包依赖",
                status: "error",
                detail: `pip 检查失败: ${detail}`,
                path: python,
                actionLabel: "下载 Python",
                actionUrl: PYTHON_DOWNLOAD_URL,
              },
        );
      }
    }

    const git = this.getGitPath();
    const bundledGit = this.getBundledGitPath();
    const gitSource = bundledGit && samePath(bundledGit, git) ? "内置 Git" : "系统 Git";
    if (!existsSync(git)) {
      checks.push({
        id: "git-runtime",
        label: "Git",
        status: "error",
        detail: "未找到可用 Git",
        path: git,
        actionLabel: "下载 Git",
        actionUrl: GIT_DOWNLOAD_URL,
      });
    } else {
      try {
        const output = await runProcess(git, ["--version"], this.paths.installRoot);
        checks.push({
          id: "git-runtime",
          label: "Git",
          status: "ok",
          detail: output ? `${output} (${gitSource})` : `${gitSource} 可启动`,
          path: git,
        });
      } catch (error) {
        checks.push({
        id: "git-runtime",
        label: "Git",
        status: "error",
        detail: `Git 损坏或不可启动: ${toDetail(error)}`,
        path: git,
        actionLabel: "下载 Git",
        actionUrl: GIT_DOWNLOAD_URL,
      });
      }
    }

    this.dependencyCache = { expiresAt: Date.now() + DEPENDENCY_CACHE_MS, checks };
    return checks;
  }

  clearDependencyCache(): void {
    this.dependencyCache = undefined;
  }

  private getCachedDependencyChecks(): InitCheck[] {
    if (this.dependencyCache) {
      return this.dependencyCache.checks;
    }

    return [
      {
        id: "python-runtime-smoke",
        label: "Python 标准库",
        status: "warning",
        detail: "后台检查中",
        path: this.getPythonPath(),
      },
      {
        id: "python-pip-check",
        label: "Python 包依赖",
        status: "warning",
        detail: "后台检查中",
        path: this.getPythonPath(),
      },
      {
        id: "git-runtime",
        label: "Git",
        status: "warning",
        detail: "后台检查中",
        path: this.getGitPath(),
      },
    ];
  }

  private async checkNapCatWebUi(): Promise<InitCheck> {
    const result = await this.readNapCatWebUiToken();
    if (result.token) {
      return {
        id: "napcat-webui-token",
        label: "NapCat WebUI token",
        status: "ok",
        detail: "token found",
      };
    }

    if (result.exists) {
      return {
        id: "napcat-webui-token",
        label: "NapCat WebUI token",
        status: "error",
        detail: result.error ?? "webui.json 存在但缺少 token",
      };
    }

    return {
      id: "napcat-webui-token",
      label: "NapCat WebUI token",
      status: "warning",
      detail: "尚未创建，保存 QQ 或启动 NapCat 前会自动生成",
    };
  }

  private async createNapCatConfigs(
    qqAccount: string,
    websocketToken: string,
    websocketPort = NAPCAT_ADAPTER_PORT,
  ): Promise<void> {
    const napcatProtocolConfig = {
      enable: false,
      network: {
        httpServers: [],
        websocketServers: [],
        websocketClients: [],
      },
    };
    const napcatConfig = {
      fileLog: false,
      consoleLog: true,
      fileLogLevel: "debug",
      consoleLogLevel: "info",
      packetBackend: "auto",
      packetServer: "",
      o3HookMode: 1,
      bypass: {
        hook: false,
        window: false,
        module: false,
        process: false,
        container: false,
        js: false,
      },
      autoTimeSync: true,
    };
    const onebotConfig = {
      network: {
        httpServers: [],
        httpSseServers: [],
        httpClients: [],
        websocketServers: [
          {
            enable: true,
            name: "MaiBot Main",
            host: "127.0.0.1",
            port: websocketPort,
            reportSelfMessage: false,
            enableForcePushEvent: true,
            messagePostFormat: "array",
            token: websocketToken,
            debug: false,
            heartInterval: 30000,
          },
        ],
        websocketClients: [],
        plugins: [],
      },
      musicSignUrl: "",
      enableLocalFile2Url: false,
      parseMultMsg: false,
      imageDownloadProxy: "",
      timeout: {
        baseTimeout: 10000,
        uploadSpeedKBps: 256,
        downloadSpeedKBps: 256,
        maxTimeout: 1800000,
      },
    };

    for (const configDir of await this.findNapCatRuntimeConfigDirs()) {
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, `napcat_protocol_${qqAccount}.json`),
        JSON.stringify(napcatProtocolConfig, null, 2),
        "utf8",
      );
      await writeFile(
        join(configDir, `onebot11_${qqAccount}.json`),
        JSON.stringify(onebotConfig, null, 2),
        "utf8",
      );
      await writeFile(
        join(configDir, `napcat_${qqAccount}.json`),
        JSON.stringify(napcatConfig, null, 2),
        "utf8",
      );
    }
  }

  private async createSnowLumaConfigs(
    qqAccount: string,
    websocketToken: string,
    websocketPort = SNOWLUMA_ONEBOT_PORT,
  ): Promise<void> {
    const configDir = join(this.paths.snowlumaRoot, "config");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "runtime.json"),
      JSON.stringify({ webuiPort: SNOWLUMA_WEBUI_PORT, hookAutoLoad: false }, null, 2),
      "utf8",
    );
    const onebotConfig = {
      networks: {
        httpServers: [],
        httpClients: [],
        wsServers: [
          {
            name: "MaiBot Main",
            host: "127.0.0.1",
            port: websocketPort,
            path: "/",
            role: "Universal",
            accessToken: websocketToken,
            messageFormat: "array",
            reportSelfMessage: false,
          },
        ],
        wsClients: [],
      },
      musicSignUrl: "",
    };
    const serialized = JSON.stringify(onebotConfig, null, 2);
    await writeFile(join(configDir, "onebot.json"), serialized, "utf8");
    await writeFile(join(configDir, `onebot_${qqAccount}.json`), serialized, "utf8");
  }

  private async findNapCatWebUiFiles(): Promise<string[]> {
    const configDirs = await this.findNapCatWebUiConfigDirs();
    return configDirs.map((configDir) => join(configDir, "webui.json"));
  }

  private async findNapCatWebUiConfigDirs(): Promise<string[]> {
    return this.findNapCatRuntimeConfigDirs();
  }

  private async findNapCatRuntimeConfigDirs(): Promise<string[]> {
    return [join(this.paths.napcatRoot, "napcat", "config")];
  }

}
