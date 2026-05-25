import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type {
  AgreementDocument,
  AgreementDocumentId,
  InitCheck,
  InitRepairResult,
  InitState,
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
  NapcatAdapterChatConfig,
  NapcatAdapterConfig,
  NapcatChatListMode,
  QqBackend,
  RuntimePaths,
  PythonRuntimeCandidate,
  ServiceId,
  SnowLumaResetResult,
  StartupAgreementConfirmResult,
  StartupAgreementState,
} from "../../shared/contracts";

const QQ_PATTERN = /qq_account\s*=\s*["']?(\d+)["']?/;
const DEPENDENCY_CACHE_MS = 15_000;
const PYTHON_RUNTIME_DIR = "python";
const GIT_RUNTIME_DIR = "git";
const PYTHON_MINIMUM_VERSION = "3.12";
const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/windows/";
const GIT_DOWNLOAD_URL = "https://git-scm.com/download/win";
const NAPCAT_FALLBACK_VERSION = "9.9.26-44498";
const MAIBOT_FALLBACK_CONFIG_VERSION = "8.10.22";
const QQ_BACKEND_FILE = "qq-backend.json";
const MESSAGE_PLATFORM_FILE = "message-platform.json";
const PYTHON_OVERRIDES_IGNORED_ENTRIES = new Set([".keep", "resource.lock"]);

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

function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
        /^\s*qq_account\s*=\s*["']?[^"'\r\n]+["']?(\s*#.*)?$/mu,
        `qq_account = ${options.qqAccount}$1`,
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
    return existsSync(this.messagePlatformPath());
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
      const qqAccount = await this.readQqAccount();
      if (qqAccount && !(await this.isAdapterConfigInitialized(backend))) {
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
    const qqAccount = await this.readQqAccount();
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

    const botConfigPath = this.botConfigPath();
    let content = await this.readOrCreateBotConfigContent();
    content = ensureBotQqConfig(content, qqAccount);

    await mkdir(dirname(botConfigPath), { recursive: true });
    await writeFile(botConfigPath, content, "utf8");
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
    const adapterConfigReady = await this.isAdapterConfigInitialized(qqBackend);
    let initializedAdapterConfig = adapterConfigReady;

    if (qqBackend === "snowluma") {
      await this.createSnowLumaConfigs(qqAccount, resolvedWebsocketServer.token, resolvedWebsocketServer.port);
    } else {
      await this.createNapCatConfigs(qqAccount, resolvedWebsocketServer.token, resolvedWebsocketServer.port);
      await this.ensureNapCatWebUiConfig();
    }
    if (!adapterConfigReady) {
      initializedAdapterConfig = await this.writeQqAdapterConfigsForBackend(
        qqBackend,
        resolvedWebsocketServer,
        qqAccount,
        chatOverrides,
      );
    }
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

    const inactiveBackend = qqBackend === "snowluma" ? "napcat" : "snowluma";
    const shouldInitializeInactive = !(await this.isAdapterConfigInitialized(inactiveBackend));

    if (qqBackend === "snowluma") {
      if (shouldInitializeInactive) {
        await this.writeNapcatAdapterConfigForServer(napcatServer, chatOverrides, false);
      }
      return this.writeSnowLumaAdapterConfigForServer(snowlumaServer, chatOverrides, true);
    }

    const wroteSelected = await this.writeNapcatAdapterConfigForServer(napcatServer, chatOverrides, true);
    if (shouldInitializeInactive) {
      await this.writeSnowLumaAdapterConfigForServer(snowlumaServer, chatOverrides, false);
    }
    return wroteSelected;
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
    const qqAccount = await this.readQqAccount();
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

    const changedFiles = [
      ...(await this.ensureBundledModuleSubtree("napcat", [
        "node.exe",
        "index.js",
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
      })),
      ...(await this.ensureBundledModuleSubtree("napcatframework", ["versions"], {
        optional: true,
        excludeRelativePaths: ["config", "data", "logs"],
      })),
    ];
    const launcher = await this.ensureNapCatLauncher();
    if (launcher) {
      changedFiles.push(launcher);
    }
    return changedFiles;
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
    if (moduleName === "napcatframework") {
      return this.napcatFrameworkRoot();
    }
    if (moduleName === "SnowLuma") {
      return this.paths.snowlumaRoot;
    }
    return join(this.paths.modulesRoot, moduleName);
  }

  private napcatFrameworkRoot(): string {
    return join(dirname(this.paths.napcatRoot), "napcatframework");
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
    const versions = await this.findNapCatVersions();
    return [
      join(this.paths.napcatRoot, "napcat", "config"),
      ...versions.flatMap((version) => [
        join(this.paths.napcatRoot, "versions", version, "resources", "app", "napcat", "config"),
        join(
          this.napcatFrameworkRoot(),
          "versions",
          version,
          "resources",
          "app",
          "LiteLoader",
          "plugins",
          "NapCat",
          "config",
        ),
      ]),
    ];
  }

  private async findNapCatVersions(): Promise<string[]> {
    const roots = [
      join(this.paths.napcatRoot, "versions"),
      join(this.napcatFrameworkRoot(), "versions"),
      join(this.paths.bundledModulesRoot, "napcat", "versions"),
      join(this.paths.bundledModulesRoot, "napcatframework", "versions"),
    ];
    const versions = new Set<string>();

    for (const root of roots) {
      if (!existsSync(root)) {
        continue;
      }

      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          versions.add(entry.name);
        }
      }
    }

    return versions.size > 0 ? [...versions] : [NAPCAT_FALLBACK_VERSION];
  }

}
