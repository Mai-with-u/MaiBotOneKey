import { ProtocolComponentManager } from "./protocol-component-manager";
import { readMaiBotSetupStatus } from "./maibot-setup-client";
import { runProcess, runWithoutAsar, samePath, sameOrInsidePath } from "./runtime-file-utils";
import { ProtocolBackendManager } from "./protocol-backend-manager";
import { MaiBotAdapterClient } from "./maibot-adapter-client";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { parse as parseToml } from "smol-toml";
import { QQ_OFFICIAL_ADAPTER_DIRECTORY, QQ_OFFICIAL_ADAPTER_PLUGIN_ID } from "../../shared/qq-official-adapter";
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
  QqComponentUpgradeResult,
  QqBackend,
  QqProtocol,
  QqProtocolOptions,
  RuntimePaths,
  RuntimePathKey,
  ServiceId,
  SnowLumaResetResult,
  StartupAgreementConfirmResult,
  StartupAgreementState,
} from "../../shared/contracts";

const DEPENDENCY_CACHE_MS = 15_000;
const PYTHON_RUNTIME_DIR = "python";
const GIT_RUNTIME_DIR = "git";
const PYTHON_MINIMUM_VERSION = "3.12";
const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";
const GIT_DOWNLOAD_URL = "https://git-scm.com/download/win";
const MAIBOT_FALLBACK_CONFIG_VERSION = "8.10.22";
const MAIBOT_WEBUI_FALLBACK_HOST = "127.0.0.1";
const MAIBOT_WEBUI_FALLBACK_PORT = 8001;
const RUNTIME_PATH_CONFIG_FILE = "runtime-paths.json";
interface StoredRuntimePathFile {
  version: 1;
  paths?: Partial<Record<RuntimePathKey, string>>;
}

interface MacNapCatQqCleanupResult {
  restoredPackage: boolean;
  cleanedRuntime: boolean;
}

const MAIBOT_BACKUP_FORMAT = "maibot-onekey-backup" as const;
const MAIBOT_BACKUP_FORMAT_VERSION = 1 as const;
const TAR_BLOCK_SIZE = 512;

interface MaiBotWebUiEndpoint {
  host: string;
  port: number;
  url: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  sourcePath?: string;
}

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

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

  constructor(targetPath: string, private readonly signal?: AbortSignal) {
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

function cleanPathEntry(entry: string): string {
  return entry.trim().replace(/^"|"$/gu, "");
}

function isWindowsAppsAlias(path: string): boolean {
  return process.platform === "win32" && /\\microsoft\\windowsapps\\git\.exe$/iu.test(path);
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
const SNOWLUMA_ADAPTER_DIR = join("plugins", "snowluma-adapter");
const QQ_OFFICIAL_ADAPTER_DIR = join("plugins", QQ_OFFICIAL_ADAPTER_DIRECTORY);
const SNOWLUMA_ADAPTER_PLUGIN_ID = "maibot-team.snowluma-adapter";

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
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

function buildMaiBotWebUiEndpoint(
  host = MAIBOT_WEBUI_FALLBACK_HOST,
  port = MAIBOT_WEBUI_FALLBACK_PORT,
): MaiBotWebUiEndpoint {
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

interface StoredAgreementFile {
  version: 1;
  hashes: Partial<Record<AgreementDocumentId, string>>;
  confirmedAt?: number;
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

function isCleanPipCheckOutput(output: string): boolean {
  return /(?:^|\n)\s*No broken requirements found\.\s*$/iu.test(output.trim());
}

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export class InitManager {
  private dependencyCache?: { expiresAt: number; checks: InitCheck[] };

  readonly protocolComponents: ProtocolComponentManager;
  readonly protocols: ProtocolBackendManager;
  readonly adapters: MaiBotAdapterClient;
  constructor(private readonly paths: RuntimePaths) {
    this.protocolComponents = new ProtocolComponentManager(paths);
    this.protocols = new ProtocolBackendManager(paths);
    this.adapters = new MaiBotAdapterClient(() => this.readMaiBotWebUiEndpointSync().url, async () => (await this.readMaiBotWebUiToken()).token);
  }

  resetSnowLumaComponent(): Promise<SnowLumaResetResult> { return this.protocolComponents.resetSnowLumaComponent(); }
  upgradeQqComponents(): Promise<QqComponentUpgradeResult> { return this.protocolComponents.upgradeQqComponents(); }
  getQqBackendSync() { return this.protocols.getQqBackendSync(); }
  async getMaiBotSetupStatus() {
    // Read the active instance's latest token on every request, including after password changes.
    const { token } = await this.readMaiBotWebUiToken();
    return readMaiBotSetupStatus(this.readMaiBotWebUiEndpointSync().url, token);
  }
  readQqBackend() { return this.protocols.readQqBackend(); }
  getQqProtocolSync() { return this.protocols.getQqProtocolSync(); }
  hasMessagePlatformConfigured() { return this.protocols.hasMessagePlatformConfigured(); }
  getMessagePlatformQqAccount(backend?: QqBackend) { return this.protocols.getMessagePlatformQqAccount(backend); }
  getQqBackendAccounts() { return this.protocols.getQqBackendAccounts(); }
  readSnowLumaServicePortsSync() { return this.protocols.readSnowLumaServicePortsSync(); }
  readNapcatWebsocketServer(account?: string) { return this.protocols.readNapcatWebsocketServer(account); }
  readNapcatWebsocketToken(account?: string) { return this.protocols.readNapcatWebsocketToken(account); }
  readSnowLumaWebsocketServer(account?: string) { return this.protocols.readSnowLumaWebsocketServer(account); }
  ensureNapCatWebUiConfig() { return this.protocols.ensureNapCatWebUiConfig(); }
  readNapCatWebUiToken() { return this.protocols.readNapCatWebUiToken(); }
  saveQqBackendAccount(backend: QqBackend, account: string) { return this.protocols.saveQqBackendAccount(backend, account); }
  async setQqBackend(backend: QqBackend): Promise<void> {
    await this.protocols.setQqBackend(backend, () => this.ensureServiceReady("napcat"));
  }
  async setQqProtocol(protocol: QqProtocol, options: QqProtocolOptions = {}): Promise<void> {
    if (protocol === "official") {
      await this.adapters.configureOfficial(options.officialCredentials);
      await this.protocols.saveQqProtocolSelection(protocol);
    } else await this.setQqBackend(protocol);
  }
  async setQqAccount(account: string, token?: string, backend: QqBackend = this.getQqBackendSync()): Promise<InitState> {
    await this.protocols.configureAccount(account, backend, token);
    await this.ensureServiceReady("napcat");
    return this.getState();
  }
  async syncQqConnections(): Promise<InitRepairResult> {
    if (this.getQqProtocolSync() === "official") throw new Error("官方 QQ 适配器不使用 OneBot 连接，无需同步。");
    await this.adapters.configureConnection(await this.protocols.connection());
    return { state: await this.getState(), changedFiles: [] };
  }

  async getState(options: { refreshDependencies?: boolean } = {}): Promise<InitState> {
    const qqBackend = await this.readQqBackend();
    const qqAccount = this.getMessagePlatformQqAccount(qqBackend);
    const messagePlatformConfigured = Boolean(qqAccount);
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
      this.checkMaiBotWebUiEndpoint(),
      ...qqModuleChecks,
      ...dependencyChecks,
    ];
    const isReady = checks.every((check) => check.status !== "error");
    return { isReady, qqAccount, qqBackend, qqProtocol: this.getQqProtocolSync(), qqOfficialConfigured: this.adapters.officialConfigured, messagePlatformConfigured, checks };
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

  async ensureModulesReady(): Promise<string[]> {
    return [
      ...(await this.ensureServiceReady("maibot")),
      ...(await this.ensureServiceReady("napcat")),
    ];
  }

  async ensureServiceReady(serviceId: ServiceId): Promise<string[]> {
    await mkdir(this.paths.logsRoot, { recursive: true });

    if (!existsSync(this.paths.bundledModulesRoot)) {
      throw new Error(`内置 modules 模板缺失: ${this.paths.bundledModulesRoot}`);
    }

    if (serviceId === "maibot") {
      const changedFiles = await this.ensureBundledModuleSubtree("MaiBot", ["bot.py"], {
        excludeRelativePaths: [NAPCAT_ADAPTER_DIR, SNOWLUMA_ADAPTER_DIR, QQ_OFFICIAL_ADAPTER_DIR],
      });
      changedFiles.push(...(await this.ensureBundledMaiBotPluginSubtree(SNOWLUMA_ADAPTER_DIR, ["plugin.py"], SNOWLUMA_ADAPTER_PLUGIN_ID)));
      changedFiles.push(...(await this.ensureBundledMaiBotPluginSubtree(QQ_OFFICIAL_ADAPTER_DIR, ["plugin.py", "settings.py", "codec.py", "_manifest.json"], QQ_OFFICIAL_ADAPTER_PLUGIN_ID)));
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

    const napcatRequiredPaths = process.platform === "darwin"
      ? [
          "napcat.mjs",
          "napcat-macos-launch.sh",
          join("node_modules", "express", "package.json"),
          join("node_modules", "ws", "package.json"),
        ]
      : [
          "node.exe",
          "index.js",
          "config.json",
          join("napcat", "package.json"),
        ];
    const changedFiles = await this.ensureBundledModuleSubtree("napcat", napcatRequiredPaths, {
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

  getPythonPath(): string {
    return this.getBundledPythonPath() ?? this.getBundledPythonCandidates()[0];
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
      detail: "未找到内置 runtime，Python 不会回退到系统环境",
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

    return {
      id: "python-runtime",
      label: "Python 运行时",
      status: "error",
      detail: `未找到内置 Python ${PYTHON_MINIMUM_VERSION}+，请检查安装包 runtime/python`,
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
    const moduleSource = join(this.paths.bundledModulesRoot, "MaiBot", pluginRelativePath);
    const source = pluginRelativePath === QQ_OFFICIAL_ADAPTER_DIR && !existsSync(moduleSource)
      ? join(dirname(this.paths.bundledModulesRoot), "resources", "bundled-plugins", QQ_OFFICIAL_ADAPTER_DIRECTORY)
      : moduleSource;
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
        filter: (sourcePath) => {
          const name = basename(sourcePath);
          return name !== "config.toml" && !name.startsWith("config.toml.") && name !== "config_back";
        },
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

  async cleanupMacNapCatQqIntegration(): Promise<MacNapCatQqCleanupResult> {
    const result: MacNapCatQqCleanupResult = {
      restoredPackage: false,
      cleanedRuntime: false,
    };
    if (process.platform !== "darwin") {
      return result;
    }

    const qqApp = process.env.NAPCAT_QQ_APP?.trim() || "/Applications/QQ.app";
    const qqPackage = join(qqApp, "Contents", "Resources", "app", "package.json");
    const packageBackup = `${qqPackage}.maibot-onekey.bak`;
    if (existsSync(qqPackage) && existsSync(packageBackup)) {
      const currentRaw = await readFile(qqPackage, "utf8");
      let currentMain: unknown;
      try {
        currentMain = (JSON.parse(currentRaw) as { main?: unknown }).main;
      } catch {
        currentMain = undefined;
      }

      if (typeof currentMain === "string" && currentMain.includes("loadNapCat.js")) {
        try {
          await copyFile(packageBackup, qqPackage);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EACCES" && code !== "EPERM") {
            throw error;
          }

          const command = `cp ${quoteShellArg(packageBackup)} ${quoteShellArg(qqPackage)}`;
          await runProcess(
            "/usr/bin/osascript",
            ["-e", `do shell script ${JSON.stringify(command)} with administrator privileges`],
            dirname(qqPackage),
            120_000,
          );
        }
        result.restoredPackage = true;
      }
    }

    const qqContainer = process.env.NAPCAT_QQ_CONTAINER?.trim()
      ? resolve(process.env.NAPCAT_QQ_CONTAINER.trim())
      : join(homedir(), "Library", "Containers", "com.tencent.qq", "Data");
    const qqDocuments = join(qqContainer, "Documents");
    const loaderPath = join(qqDocuments, "loadNapCat.js");
    const napcatWorkDir = join(qqDocuments, "napcat");

    if (existsSync(loaderPath)) {
      await rm(loaderPath, { force: true });
      result.cleanedRuntime = true;
    }

    if (existsSync(napcatWorkDir)) {
      const entries = await readdir(napcatWorkDir, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.name !== "config")
        .map((entry) => rm(join(napcatWorkDir, entry.name), { recursive: entry.isDirectory(), force: true })));
      result.cleanedRuntime ||= entries.some((entry) => entry.name !== "config");
    }

    return result;
  }

  readMaiBotWebUiEndpointSync(): MaiBotWebUiEndpoint {
    const fallback = buildMaiBotWebUiEndpoint();
    const configPath = this.botConfigPath();
    let reason = "未找到 WebUI 配置，已使用默认地址";
    try {
      const document = parseToml(readFileSync(configPath, "utf8"));
      const config = document.webui;
      if (config && typeof config === "object" && !Array.isArray(config) && !(config instanceof Date)) {
        return {
          ...buildMaiBotWebUiEndpoint(asString(config["host"], fallback.host), asTcpPort(config["port"], fallback.port)),
          sourcePath: configPath,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        reason = "读取 WebUI 配置失败: " + configPath + ": " + toDetail(error);
      }
    }
    return { ...fallback, fallbackUsed: true, fallbackReason: reason };
  }

  /** Read only the active instance's token; missing credentials use normal login. */
  async readMaiBotWebUiToken(): Promise<{ token?: string; exists: boolean; error?: string }> {
    const tokenPath = join(this.paths.maibotRoot, "data", "webui.json");
    try {
      const raw = JSON.parse(await readFile(tokenPath, "utf8")) as { access_token?: unknown };
      if (typeof raw.access_token === "string" && raw.access_token.length > 0) {
        return { token: raw.access_token, exists: true };
      }
      return { exists: true, error: "缺少 access_token: " + tokenPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      return { exists: true, error: "读取 WebUI 令牌失败: " + tokenPath + ": " + toDetail(error) };
    }
  }

  private botConfigPath(): string {
    return join(this.paths.maibotRoot, "config", "bot_config.toml");
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

  private async repairBotConfigVersionInfo(): Promise<string | undefined> {
    const botConfigPath = this.botConfigPath();
    if (!existsSync(botConfigPath)) {
      return undefined;
    }

    const content = await readFile(botConfigPath, "utf8");
    const repaired = ensureInnerVersion(
      content,
      maibotInitialConfigVersion(await this.readMaiBotConfigVersion()),
    );
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
    if (!existsSync(python)) {
      checks.push({
        id: "python-dependencies",
        label: "Python 依赖完整性",
        status: "error",
        detail: `未找到内置 Python ${PYTHON_MINIMUM_VERSION}+，无法检查依赖`,
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
          detail: output ? `${output} (内置 Python)` : "内置 Python 可启动，ssl/sqlite3/tomllib 可导入",
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

  private checkMaiBotWebUiEndpoint(): InitCheck {
    const endpoint = this.readMaiBotWebUiEndpointSync();
    if (endpoint.fallbackReason) {
      return {
        id: "maibot-webui-endpoint",
        label: "MaiBot WebUI 地址",
        status: "warning",
        detail: `${endpoint.fallbackReason}；当前使用 ${endpoint.url}`,
        path: endpoint.sourcePath,
      };
    }

    return {
      id: "maibot-webui-endpoint",
      label: "MaiBot WebUI 地址",
      status: "ok",
      detail: `使用 ${endpoint.url}`,
      path: endpoint.sourcePath,
    };
  }


}
