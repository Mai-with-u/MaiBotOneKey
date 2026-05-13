import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
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
  RuntimePaths,
  PythonRuntimeCandidate,
  ServiceId,
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
const MAIBOT_LEGACY_CONFIG_VERSION = "1.0.0";

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
 * NapCat 鍚姩鍖呰 .cmd锛氬湪鍚姩 exe 鍓嶅厛鍒囨帶鍒跺彴鍒?UTF-8锛岄伩鍏嶄腑鏂囦贡鐮併€?
 * 鍐呭鏄浐瀹氱殑銆佷笉渚濊禆浠讳綍杩愯鏃舵嫾鎺ョ殑鍙橀噺锛氫笉浼氶亣鍒?cmd 寮曞彿瑙ｆ瀽闂銆?
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
const NAPCAT_ADAPTER_HOST = "127.0.0.1";
const NAPCAT_ADAPTER_PORT = 7998;

function buildDefaultNapcatAdapterConfig(token = ""): NapcatAdapterConfig {
  return {
    plugin: {
      enabled: true,
      configVersion: NAPCAT_ADAPTER_CONFIG_VERSION,
    },
    server: {
      host: NAPCAT_ADAPTER_HOST,
      port: NAPCAT_ADAPTER_PORT,
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
  const serverRaw = ((raw["napcat_server"] ?? raw["connection"]) as Record<string, unknown> | undefined) ?? {};
  const chatRaw = (raw["chat"] as Record<string, unknown> | undefined) ?? {};
  const filtersRaw = (raw["filters"] as Record<string, unknown> | undefined) ?? {};

  return {
    plugin: {
      enabled: asBool(pluginRaw["enabled"], defaults.plugin.enabled),
      configVersion: asString(pluginRaw["config_version"], defaults.plugin.configVersion),
    },
    server: {
      host: asString(serverRaw["host"], defaults.server.host).trim() || defaults.server.host,
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
    groupList: override.groupList ? asStringList(override.groupList) : base.groupList,
    privateListType: override.privateListType ?? base.privateListType,
    privateList: override.privateList ? asStringList(override.privateList) : base.privateList,
    banUserId: override.banUserId ? asStringList(override.banUserId) : base.banUserId,
    banQqBot: override.banQqBot ?? base.banQqBot,
  };
}

interface StoredAgreementFile {
  version: 1;
  hashes: Partial<Record<AgreementDocumentId, string>>;
  confirmedAt?: number;
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function checkFile(path: string, label: string, id: string): InitCheck {
  if (existsSync(path)) {
    return { id, label, status: "ok", detail: "已找到", path };
  }

  return { id, label, status: "error", detail: "缂哄け", path };
}

function checkDir(path: string, label: string, id: string): InitCheck {
  if (existsSync(path)) {
    return { id, label, status: "ok", detail: "已找到", path };
  }

  return { id, label, status: "error", detail: "缂哄け", path };
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
  // 涓?Python `open(path, encoding="utf-8").read()` 琛屼负瀵归綈锛?
  // Python 鏂囨湰妯″紡浼氭妸 \r\n / \r 缁熶竴杞垚 \n锛屽啀浜ょ粰 hashlib銆?
  // Node 鐨?readFile(path, 'utf8') 淇濈暀鍘熷 CRLF锛屾墍浠ヨ繖閲屾墜鍔ㄥ綊涓€鍖栦互鍖归厤 MaiBot 鐨勫搱甯岀粨鏋溿€?
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

  async getState(options: { refreshDependencies?: boolean } = {}): Promise<InitState> {
    const qqAccount = await this.readQqAccount();
    const dependencyChecks = options.refreshDependencies === false
      ? this.getCachedDependencyChecks()
      : await this.checkDependencies();
    const napCatWebUiCheck = await this.checkNapCatWebUi();
    const checks: InitCheck[] = [
      this.checkRuntimeRoot(),
      this.checkPythonRuntime(),
      checkDir(this.paths.maibotRoot, "MaiBot 主模块", "maibot-module"),
      checkFile(join(this.paths.maibotRoot, "bot.py"), "MaiBot 启动文件", "maibot-entry"),
      checkDir(this.paths.napcatRoot, "NapCat 模块", "napcat-module"),
      checkFile(
        join(this.paths.napcatRoot, "NapCatWinBootMain.exe"),
        "NapCat 启动文件",
        "napcat-entry",
      ),
      napCatWebUiCheck,
      ...dependencyChecks,
    ];
    const isReady = checks.every((check) => check.status !== "error");
    return { isReady, qqAccount, checks };
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
      throw new Error(`${missing.title} 鏂囦欢缂哄け: ${missing.sourcePath}`);
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
   * 璁＄畻褰撳墠 EULA / PRIVACY 鐨勬渶鏂?MD5锛屼綔涓虹幆澧冨彉閲忓湪姣忔鍚姩 MaiBot 鏃舵敞鍏ャ€?
   * 楹﹂害鐨?bot.py 浼氳鍙?`EULA_AGREE` 涓?`PRIVACY_AGREE`锛岀瓑浜庡綋鍓嶆枃浠?hash 鍗宠涓哄凡鍚屾剰锛?
   * 鍗忚鏈夋洿鏂版椂 hash 鑷姩鍙樺寲锛岄害楹︾浼氳Е鍙戦噸鏂扮‘璁ゆ祦绋嬨€?
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
        // 蹇界暐璇诲彇澶辫触锛岄害楹︿細鍥為€€鍒颁氦浜掑紡纭
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
   * 鎶婄敤鎴锋彁渚涚殑 bot_config.toml / model_config.toml 瑕嗙洊鍒?MaiBot/config 涓嬶紝
   * 鑷姩鍑嗗濂藉彲鍐欑殑 MaiBot 妯″潡鐩綍涓?config 瀛愮洰褰曪紝骞跺鍘熸枃浠跺仛鏃堕棿鎴冲浠姐€?
   */
  async importMaiBotConfig(
    fileName: MaiBotConfigFileName,
    sourcePath: string,
  ): Promise<MaiBotConfigImportResult> {
    if (fileName !== "bot_config.toml" && fileName !== "model_config.toml") {
      throw new Error(`涓嶆敮鎸佺殑閰嶇疆鏂囦欢鍚? ${fileName}`);
    }
    if (!sourcePath) {
      throw new Error("鏈€夋嫨閰嶇疆鏂囦欢");
    }
    if (!existsSync(sourcePath)) {
      throw new Error(`閰嶇疆鏂囦欢涓嶅瓨鍦? ${sourcePath}`);
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
   * 鎶婄敤鎴锋彁渚涚殑 MaiBot.db 瑕嗙洊鍒?MaiBot/data/MaiBot.db锛?
   * 鑷姩鍑嗗濂藉彲鍐欑殑 MaiBot 妯″潡鐩綍涓?data 瀛愮洰褰曘€?
   */
  async importMaiBotDatabase(sourcePath: string): Promise<MaiBotDataImportResult> {
    if (!sourcePath) {
      throw new Error("未选择数据库文件");
    }
    if (!existsSync(sourcePath)) {
      throw new Error(`鏁版嵁搴撴枃浠朵笉瀛樺湪: ${sourcePath}`);
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
   * 娓呯┖ MaiBot/data 鐩綍涓嬬殑鎵€鏈夊唴瀹癸紙涓嶄細鍒犻櫎 data 鐩綍鏈韩锛夈€?
   * 浠呬綔鐢ㄤ簬鍙啓妯″潡鐩綍锛屽紑鍙戞€佹寚鍚?bundled 妯℃澘鏃朵細鎷掔粷鎵ц銆?
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
    websocketToken = createWebsocketToken(),
    chatOverrides?: Partial<NapcatAdapterChatConfig>,
  ): Promise<InitState> {
    if (!isDigits(qqAccount)) {
      throw new Error("QQ 号必须是纯数字");
    }

    const botConfigPath = this.botConfigPath();
    let content = await this.readOrCreateBotConfigContent();

    if (QQ_PATTERN.test(content)) {
      content = content.replace(QQ_PATTERN, `qq_account = ${qqAccount}`);
    } else if (/\[bot\]/.test(content)) {
      content = content.replace(/\[bot\]/, `[bot]\nqq_account = ${qqAccount}`);
    } else {
      content += `\n[bot]\nqq_account = ${qqAccount}\n`;
    }

    await mkdir(dirname(botConfigPath), { recursive: true });
    await writeFile(botConfigPath, content, "utf8");
    await this.createNapCatConfigs(qqAccount, websocketToken);
    await this.ensureNapCatWebUiConfig();
    await this.writeNapcatAdapterConfigForToken(websocketToken, chatOverrides);
    return this.getState();
  }

  napcatAdapterConfigPath(): string {
    return join(this.paths.maibotRoot, NAPCAT_ADAPTER_DIR, "config.toml");
  }

  /**
   * 璇诲彇鏈€鏂颁竴浠?onebot11_<qq>.json 涓凡鍐欏叆鐨?WebSocket Token锛?
   * 鐢ㄤ簬鍦?napcat-adapter 閰嶇疆涓鐢ㄥ悓涓€涓?token锛岄伩鍏嶉害楹︾杩炰笉涓娿€?
   */
  async readNapcatWebsocketToken(): Promise<string> {
    try {
      const versions = await this.findNapCatConfigVersions();
      for (const version of versions) {
        const configDir = join(
          this.paths.napcatRoot,
          "versions",
          version,
          "resources",
          "app",
          "napcat",
          "config",
        );
        if (!existsSync(configDir)) continue;
        const entries = await readdir(configDir);
        const onebotFile = entries.find((name) => /^onebot11_\d+\.json$/i.test(name));
        if (!onebotFile) continue;
        const raw = await readFile(join(configDir, onebotFile), "utf8");
        const parsed = JSON.parse(raw) as {
          network?: { websocketServers?: Array<{ token?: string; port?: number }> };
        };
        const server = parsed?.network?.websocketServers?.find((entry) => entry?.token);
        if (server?.token) {
          return String(server.token);
        }
      }
    } catch {
      // ignore 鈥?fall through to empty token
    }
    return "";
  }

  /**
   * 鍒涘缓/鏇存柊 napcat-adapter 鐨?config.toml锛?   * token 鐩存帴鏉ヨ嚜褰撳墠 setQqAccount 娴佺▼鐢熸垚鐨?websocket token锛?
   * chat 璁剧疆鍒欏彇鐢ㄦ埛鍦ㄥ紩瀵肩晫闈㈠～鍐欑殑瑕嗙洊鍊硷紙缂虹渷鍗抽粯璁わ級銆?
   */
  private async writeNapcatAdapterConfigForToken(
    websocketToken: string,
    chatOverrides?: Partial<NapcatAdapterChatConfig>,
  ): Promise<void> {
    const defaults = buildDefaultNapcatAdapterConfig(websocketToken);
    let existing: NapcatAdapterConfig = defaults;
    const configPath = this.napcatAdapterConfigPath();
    const adapterRoot = dirname(configPath);

    if (!existsSync(adapterRoot)) {
      return;
    }

    if (existsSync(configPath)) {
      try {
        const text = await readFile(configPath, "utf8");
        const parsed = parseToml(text);
        if (parsed && typeof parsed === "object") {
          existing = normalizeNapcatAdapterConfig(parsed as Record<string, unknown>, defaults);
        }
      } catch {
        // 瑙ｆ瀽澶辫触鍒欑洿鎺ヤ互榛樿鍊艰鐩?
      }
    }

    const merged: NapcatAdapterConfig = {
      ...existing,
      plugin: {
        enabled: true,
        configVersion: NAPCAT_ADAPTER_CONFIG_VERSION,
      },
      server: {
        ...existing.server,
        host: NAPCAT_ADAPTER_HOST,
        port: NAPCAT_ADAPTER_PORT,
        token: websocketToken,
      },
      chat: applyChatOverrides(existing.chat, chatOverrides),
    };

    await writeFile(configPath, napcatAdapterConfigToToml(merged), "utf8");
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
      throw new Error(`鍐呯疆 modules 妯℃澘缂哄け: ${this.paths.bundledModulesRoot}`);
    }

    if (serviceId === "maibot") {
      const changedFiles = await this.ensureBundledModuleSubtree("MaiBot", ["bot.py"], {
        excludeRelativePaths: [NAPCAT_ADAPTER_DIR],
      });
      const repairedConfig = await this.repairBotConfigVersionInfo();
      return repairedConfig ? [...changedFiles, repairedConfig] : changedFiles;
    }

    const changedFiles = [
      ...(await this.ensureBundledModuleSubtree("napcat", [
        "node.exe",
        "index.js",
        join("napcat", "package.json"),
      ])),
      ...(await this.ensureBundledModuleSubtree("napcatframework", ["versions"], true)),
    ];
    const launcher = await this.ensureNapCatLauncher();
    if (launcher) {
      changedFiles.push(launcher);
    }
    return changedFiles;
  }

  /**
   * 鍦?napcat 鐩綍涓嬬敓鎴愪竴涓浐瀹氱殑寮曞 .cmd锛屽惎鍔ㄦ椂鍏?chcp 65001 鍐嶈皟 exe锛?
   * 閬垮厤鍦ㄦ簮鐮侀噷鎷兼帴 `cmd /C` 瀛楃涓插甫鏉ョ殑寮曞彿闂锛屽悓鏃朵繚鐣欐帶鍒跺彴 UTF-8
   * 浠ュ厤涓枃杈撳嚭涔辩爜銆?
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
        // 璇讳笉鍒板氨閲嶅啓
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

  private checkGitRuntime(): InitCheck {
    const bundledGit = this.getBundledGitPath();
    if (bundledGit) {
      return {
        id: "git-runtime",
        label: "Git 运行时",
        status: "ok",
        detail: "使用内置 Git",
        path: bundledGit,
      };
    }

    const systemGit = this.findSystemGitPath();
    if (systemGit) {
      return {
        id: "git-runtime",
        label: "Git 运行时",
        status: "ok",
        detail: "使用系统 Git",
        path: systemGit,
      };
    }

    return {
      id: "git-runtime",
      label: "Git 运行时",
      status: "error",
      detail: "未找到内置 Git 或系统 Git",
      path: this.getBundledGitCandidates()[0],
      actionLabel: "下载 Git",
      actionUrl: GIT_DOWNLOAD_URL,
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

      throw new Error(`鍐呯疆 ${moduleName} 妯℃澘缂哄け: ${source}`);
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
      throw new Error(existing.error ?? "NapCat WebUI 閰嶇疆瀛樺湪浣嗙己灏?token锛岃鎵嬪姩妫€鏌?webui.json");
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
        firstError ??= `缂哄皯 token: ${candidate}`;
      } catch (error) {
        firstError ??= `JSON 鏍煎紡閿欒: ${candidate}: ${toDetail(error)}`;
      }
    }

    return { exists: sawExisting, error: firstError };
  }

  /**
   * 璇诲彇 MaiBot Core WebUI 鐨?access_token锛岀敤浜庡湪 WebUI 鍏ュ彛鎷兼帴
   * `?token=<access_token>` 瀹炵幇鑷姩鐧诲綍銆?
   * 鏂囦欢涓嶅瓨鍦ㄦ垨缂哄瓧娈垫椂杩斿洖绌?token锛岃皟鐢ㄦ柟搴斿洖閫€涓轰笉甯﹀弬鏁扮殑鍦板潃銆?
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
        firstError ??= `缂哄皯 access_token: ${candidate}`;
      } catch (error) {
        firstError ??= `JSON 鏍煎紡閿欒: ${candidate}: ${toDetail(error)}`;
      }
    }

    return { exists: sawExisting, error: firstError };
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
        error: `${fileName} 鏂囦欢缂哄け`,
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
    if (!existsSync(botConfigPath)) {
      return `[inner]\nversion = "${MAIBOT_LEGACY_CONFIG_VERSION}"\n\n[bot]\n`;
    }

    const content = await readFile(botConfigPath, "utf8");
    return ensureInnerVersion(content, MAIBOT_LEGACY_CONFIG_VERSION);
  }

  private async repairBotConfigVersionInfo(): Promise<string | undefined> {
    const botConfigPath = this.botConfigPath();
    if (!existsSync(botConfigPath)) {
      return undefined;
    }

    const content = await readFile(botConfigPath, "utf8");
    const repaired = ensureInnerVersion(content, MAIBOT_LEGACY_CONFIG_VERSION);
    if (repaired === content) {
      return undefined;
    }

    await writeFile(botConfigPath, repaired, "utf8");
    return botConfigPath;
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
        checks.push({
          id: "python-pip-check",
          label: "Python 包依赖",
          status: "error",
          detail: `pip 检查失败: ${toDetail(error)}`,
          path: python,
          actionLabel: "下载 Python",
          actionUrl: PYTHON_DOWNLOAD_URL,
        });
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
        detail: "宸叉壘鍒?token",
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

  private async createNapCatConfigs(qqAccount: string, websocketToken: string): Promise<void> {
    const versions = await this.findNapCatConfigVersions();
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
            port: 7998,
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

  private async findNapCatConfigVersions(): Promise<string[]> {
    const versions = await this.findNapCatVersions();
    const comparable = versions.map((version) => ({
      version,
      parts: this.parseNapCatVersion(version),
    }));

    if (comparable.some((item) => !item.parts)) {
      return versions;
    }

    const sorted = comparable.toSorted((left, right) => this.compareVersionParts(left.parts ?? [], right.parts ?? []));
    return [sorted[sorted.length - 1]?.version ?? NAPCAT_FALLBACK_VERSION];
  }

  private parseNapCatVersion(version: string): number[] | undefined {
    const match = version.match(/^(\d+(?:\.\d+)*)(?:-(\d+))?$/u);
    if (!match) {
      return undefined;
    }

    return [
      ...match[1].split(".").map((part) => Number(part)),
      match[2] ? Number(match[2]) : 0,
    ];
  }

  private compareVersionParts(left: number[], right: number[]): number {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (left[index] ?? 0) - (right[index] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }

    return 0;
  }
}
