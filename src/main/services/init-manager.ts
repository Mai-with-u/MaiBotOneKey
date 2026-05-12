import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
  NapcatAdapterConfigSaveResult,
  NapcatAdapterConfigState,
  NapcatChatListMode,
  RuntimePaths,
  ServiceId,
  StartupAgreementConfirmResult,
  StartupAgreementState,
} from "../../shared/contracts";

const QQ_PATTERN = /qq_account\s*=\s*["']?(\d+)["']?/;
const DEPENDENCY_CACHE_MS = 15_000;
const PYTHON_RUNTIME_DIR = "python";
const GIT_RUNTIME_DIR = "git";
const NAPCAT_FALLBACK_VERSION = "9.9.26-44498";
const MAIBOT_LEGACY_CONFIG_VERSION = "1.0.0";

const AGREEMENT_FILES: Array<{ id: AgreementDocumentId; title: string; fileName: string; envVar: string }> = [
  { id: "eula", title: "最终用户许可协议", fileName: "EULA.md", envVar: "EULA_AGREE" },
  { id: "privacy", title: "隐私政策", fileName: "PRIVACY.md", envVar: "PRIVACY_AGREE" },
];

const AGREEMENT_STORE_FILE = "agreement.json";

/**
 * NapCat 启动包装 .cmd：在启动 exe 前先切控制台到 UTF-8，避免中文乱码。
 * 内容是固定的、不依赖任何运行时拼接的变量：不会遇到 cmd 引号解析问题。
 */
const NAPCAT_LAUNCHER_FILE = "napcat-launch.cmd";
const NAPCAT_LAUNCHER_CONTENT = [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  '"%~dp0NapCatWinBootMain.exe" %*',
  "",
].join("\r\n");

const NAPCAT_ADAPTER_DIR = join("MaiBot", "plugins", "napcat-adapter");
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

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWebsocketToken(): string {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

function md5Utf8(content: string): string {
  // 与 Python `open(path, encoding="utf-8").read()` 行为对齐：
  // Python 文本模式会把 \r\n / \r 统一转成 \n，再交给 hashlib。
  // Node 的 readFile(path, 'utf8') 保留原始 CRLF，所以这里手动归一化以匹配 MaiBot 的哈希结果。
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

  async getState(): Promise<InitState> {
    const qqAccount = await this.readQqAccount();
    const dependencyChecks = await this.checkDependencies();
    const napCatWebUiCheck = await this.checkNapCatWebUi();
    const checks: InitCheck[] = [
      checkDir(this.paths.runtimeRoot, "内置 runtime", "runtime"),
      checkDir(this.paths.bundledModulesRoot, "内置 modules 模板", "bundled-modules"),
      checkDir(this.getPythonRoot(), "内置 Python 目录", "python-runtime"),
      checkFile(this.getPythonPath(), "内置 Python 可执行文件", "python-exe"),
      checkDir(this.getPythonLibPath(), "Python 标准库目录", "python-lib"),
      checkDir(this.getPythonDllsPath(), "Python DLLs 目录", "python-dlls"),
      checkFile(this.getPipPath(), "Python pip 命令", "python-pip-exe"),
      checkDir(this.getPipPackagePath(), "Python pip 包", "python-pip-package"),
      checkDir(this.getGitRoot(), "内置 Git", "git-runtime"),
      checkDir(join(this.paths.modulesRoot, "MaiBot"), "MaiBot 主模块", "maibot-module"),
      checkFile(join(this.paths.modulesRoot, "MaiBot", "bot.py"), "MaiBot 启动文件", "maibot-entry"),
      checkDir(join(this.paths.modulesRoot, "napcat"), "NapCat 模块", "napcat-module"),
      checkFile(
        join(this.paths.modulesRoot, "napcat", "NapCatWinBootMain.exe"),
        "NapCat 启动文件",
        "napcat-entry",
      ),
      napCatWebUiCheck,
      ...dependencyChecks,
      {
        id: "qq-account",
        label: "机器人 QQ 号",
        status: qqAccount ? "ok" : "warning",
        detail: qqAccount ? `已配置 ${qqAccount}` : "尚未配置，NapCat 启动前需要填写",
      },
    ];

    const isReady = checks.every((check) => check.status !== "error");
    return { isReady, qqAccount, checks };
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
    const changedFiles = await this.ensureServiceReady("maibot");
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
    changedFiles.push(storePath);

    return {
      state: await this.getAgreementState(),
      changedFiles,
    };
  }

  async assertAgreementsConfirmed(): Promise<void> {
    const state = await this.getAgreementState();
    if (!state.isConfirmed) {
      throw new Error("请先阅读并同意 MaiBot EULA 与隐私政策。");
    }
  }

  /**
   * 计算当前 EULA / PRIVACY 的最新 MD5，作为环境变量在每次启动 MaiBot 时注入。
   * 麦麦的 bot.py 会读取 `EULA_AGREE` 与 `PRIVACY_AGREE`，等于当前文件 hash 即视为已同意，
   * 协议有更新时 hash 自动变化，麦麦端会触发重新确认流程。
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
        // 忽略读取失败，麦麦会回退到交互式确认
      }
    }
    return env;
  }

  getMaiBotDataDir(): string {
    return join(this.paths.modulesRoot, "MaiBot", "data");
  }

  getMaiBotConfigDir(): string {
    return join(this.paths.modulesRoot, "MaiBot", "config");
  }

  /**
   * 把用户提供的 bot_config.toml / model_config.toml 覆盖到 MaiBot/config 下，
   * 自动准备好可写的 MaiBot 模块目录与 config 子目录，并对原文件做时间戳备份。
   */
  async importMaiBotConfig(
    fileName: MaiBotConfigFileName,
    sourcePath: string,
  ): Promise<MaiBotConfigImportResult> {
    if (fileName !== "bot_config.toml" && fileName !== "model_config.toml") {
      throw new Error(`不支持的配置文件名: ${fileName}`);
    }
    if (!sourcePath) {
      throw new Error("未选择配置文件");
    }
    if (!existsSync(sourcePath)) {
      throw new Error(`配置文件不存在: ${sourcePath}`);
    }
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error("选择的路径不是文件");
    }

    await this.ensureServiceReady("maibot");
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
   * 把用户提供的 MaiBot.db 覆盖到 MaiBot/data/MaiBot.db，
   * 自动准备好可写的 MaiBot 模块目录与 data 子目录。
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

    await this.ensureServiceReady("maibot");
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
   * 清空 MaiBot/data 目录下的所有内容（不会删除 data 目录本身）。
   * 仅作用于可写模块目录，开发态指向 bundled 模板时会拒绝执行。
   */
  async resetMaiBotData(): Promise<MaiBotDataResetResult> {
    if (this.paths.modulesRoot === this.paths.bundledModulesRoot) {
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

    await this.ensureServiceReady("maibot");

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
    return join(this.paths.modulesRoot, NAPCAT_ADAPTER_DIR, "config.toml");
  }

  /**
   * 读取最新一份 onebot11_<qq>.json 中已写入的 WebSocket Token，
   * 用于在 napcat-adapter 配置中复用同一个 token，避免麦麦端连不上。
   */
  async readNapcatWebsocketToken(): Promise<string> {
    try {
      const versions = await this.findNapCatConfigVersions();
      for (const version of versions) {
        const configDir = join(
          this.paths.modulesRoot,
          "napcat",
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
      // ignore — fall through to empty token
    }
    return "";
  }

  async getNapcatAdapterConfig(): Promise<NapcatAdapterConfigState> {
    const configPath = this.napcatAdapterConfigPath();
    const token = await this.readNapcatWebsocketToken();
    const defaults = buildDefaultNapcatAdapterConfig(token);

    if (!existsSync(configPath)) {
      return { configPath, exists: false, config: defaults, defaults };
    }

    let raw: Record<string, unknown> = {};
    try {
      const text = await readFile(configPath, "utf8");
      const parsed = parseToml(text);
      if (parsed && typeof parsed === "object") {
        raw = parsed as Record<string, unknown>;
      }
    } catch (error) {
      throw new Error(
        `读取 napcat-adapter 配置失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const config = normalizeNapcatAdapterConfig(raw, defaults);
    if (!config.server.token && token) {
      config.server.token = token;
    }
    return { configPath, exists: true, config, defaults };
  }

  async saveNapcatAdapterConfig(
    payload: NapcatAdapterConfig,
  ): Promise<NapcatAdapterConfigSaveResult> {
    await this.ensureServiceReady("maibot");
    const fallbackToken = await this.readNapcatWebsocketToken();
    const defaults = buildDefaultNapcatAdapterConfig(fallbackToken);
    const normalized = normalizeNapcatAdapterConfig(
      {
        plugin: {
          enabled: payload.plugin.enabled,
          config_version: payload.plugin.configVersion,
        },
        napcat_server: {
          host: payload.server.host,
          port: payload.server.port,
          token: payload.server.token,
          heartbeat_interval: payload.server.heartbeatInterval,
          reconnect_delay_sec: payload.server.reconnectDelaySec,
          action_timeout_sec: payload.server.actionTimeoutSec,
          connection_id: payload.server.connectionId,
        },
        chat: {
          enable_chat_list_filter: payload.chat.enableChatListFilter,
          show_dropped_chat_list_messages: payload.chat.showDroppedChatListMessages,
          group_list_type: payload.chat.groupListType,
          group_list: payload.chat.groupList,
          private_list_type: payload.chat.privateListType,
          private_list: payload.chat.privateList,
          ban_user_id: payload.chat.banUserId,
          ban_qq_bot: payload.chat.banQqBot,
        },
        filters: {
          ignore_self_message: payload.filters.ignoreSelfMessage,
        },
      },
      defaults,
    );

    const configPath = this.napcatAdapterConfigPath();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, napcatAdapterConfigToToml(normalized), "utf8");
    return { configPath, config: normalized, savedAt: Date.now() };
  }

  /**
   * 创建/更新 napcat-adapter 的 config.toml；
   * token 直接来自当前 setQqAccount 流程生成的 websocket token，
   * chat 设置则取用户在引导界面填写的覆盖值（缺省即默认）。
   */
  private async writeNapcatAdapterConfigForToken(
    websocketToken: string,
    chatOverrides?: Partial<NapcatAdapterChatConfig>,
  ): Promise<void> {
    const defaults = buildDefaultNapcatAdapterConfig(websocketToken);
    let existing: NapcatAdapterConfig = defaults;
    const configPath = this.napcatAdapterConfigPath();

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

    await mkdir(dirname(configPath), { recursive: true });
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

    if (this.paths.modulesRoot === this.paths.bundledModulesRoot) {
      if (serviceId === "napcat") {
        const launcher = await this.ensureNapCatLauncher();
        return launcher ? [launcher] : [];
      }
      return [];
    }

    if (!existsSync(this.paths.bundledModulesRoot)) {
      throw new Error(`内置 modules 模板缺失: ${this.paths.bundledModulesRoot}`);
    }

    if (serviceId === "maibot") {
      const changedFiles = await this.ensureBundledModuleSubtree("MaiBot", [
        "bot.py",
        join("plugins", "napcat-adapter"),
      ]);
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
   * 在 napcat 目录下生成一个固定的引导 .cmd，启动时先 chcp 65001 再调 exe，
   * 避免在源码里拼接 `cmd /C` 字符串带来的引号问题，同时保留控制台 UTF-8
   * 以免中文输出乱码。
   */
  private async ensureNapCatLauncher(): Promise<string | undefined> {
    const napcatRoot = join(this.paths.modulesRoot, "napcat");
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
    const root = this.getPythonRoot();
    const candidates = [
      join(root, "python.exe"),
      join(root, "bin", "python.exe"),
      join(root, "python"),
      join(root, "bin", "python3"),
      join(root, "bin", "python"),
    ];

    return candidates.find((path) => existsSync(path)) ?? candidates[0];
  }

  getPipPath(): string {
    const root = this.getPythonRoot();
    const candidates = [
      join(root, "Scripts", "pip.exe"),
      join(root, "Scripts", "pip3.exe"),
      join(root, "bin", "pip3"),
      join(root, "bin", "pip"),
    ];

    return candidates.find((path) => existsSync(path)) ?? candidates[0];
  }

  getGitPath(): string {
    const root = this.getGitRoot();
    const candidates = [
      join(root, "bin", "git.exe"),
      join(root, "cmd", "git.exe"),
      join(root, "git.exe"),
      join(root, "bin", "git"),
    ];

    return candidates.find((path) => existsSync(path)) ?? candidates[0];
  }

  private getPythonRoot(): string {
    return join(this.paths.runtimeRoot, PYTHON_RUNTIME_DIR);
  }

  private getPythonLibPath(): string {
    return join(this.getPythonRoot(), "Lib");
  }

  private getPythonDllsPath(): string {
    return join(this.getPythonRoot(), "DLLs");
  }

  private getPipPackagePath(): string {
    return join(this.getPythonRoot(), "Lib", "site-packages", "pip");
  }

  private getGitRoot(): string {
    return join(this.paths.runtimeRoot, GIT_RUNTIME_DIR);
  }

  private async ensureBundledModuleSubtree(
    moduleName: string,
    requiredRelativePaths: string[],
    optional = false,
  ): Promise<string[]> {
    const source = join(this.paths.bundledModulesRoot, moduleName);
    const target = join(this.paths.modulesRoot, moduleName);

    if (!existsSync(source)) {
      if (optional) {
        return [];
      }

      throw new Error(`内置 ${moduleName} 模板缺失: ${source}`);
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

  async ensureNapCatWebUiConfig(): Promise<string | undefined> {
    const existing = await this.readNapCatWebUiToken();
    if (existing.token) {
      return existing.token;
    }

    if (existing.exists) {
      throw new Error(existing.error ?? "NapCat WebUI 配置存在但缺少 token，请手动检查 webui.json");
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
   * 读取 MaiBot Core WebUI 的 access_token，用于在 WebUI 入口拼接
   * `?token=<access_token>` 实现自动登录。
   * 文件不存在或缺字段时返回空 token，调用方应回退为不带参数的地址。
   */
  async readMaiBotWebUiToken(): Promise<{ token?: string; exists: boolean; error?: string }> {
    const candidates = [
      join(this.paths.modulesRoot, "MaiBot", "data", "webui.json"),
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
    return join(this.paths.modulesRoot, "MaiBot", "config", "bot_config.toml");
  }

  private agreementSourcePath(fileName: string): string {
    const writablePath = join(this.paths.modulesRoot, "MaiBot", fileName);
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
    if (!existsSync(python)) {
      checks.push({
        id: "python-dependencies",
        label: "Python 依赖完整性",
        status: "error",
        detail: "内置 Python 缺失，无法检查依赖",
        path: python,
      });
    } else {
      try {
        await runProcess(
          python,
          ["-c", "import sys, ssl, sqlite3, tomllib; print(sys.version)"],
          this.paths.installRoot,
        );
        checks.push({
          id: "python-runtime-smoke",
          label: "Python 标准库",
          status: "ok",
          detail: "可启动，ssl/sqlite3/tomllib 可导入",
          path: python,
        });
      } catch (error) {
        checks.push({
          id: "python-runtime-smoke",
          label: "Python 标准库",
          status: "error",
          detail: `依赖损坏: ${toDetail(error)}`,
          path: python,
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
          detail: `依赖损坏: ${toDetail(error)}`,
          path: python,
        });
      }
    }

    const git = this.getGitPath();
    if (!existsSync(git)) {
      checks.push({
        id: "git-runtime-smoke",
        label: "Git 可执行文件",
        status: "error",
        detail: "内置 Git 缺失，无法检查 Git",
        path: git,
      });
    } else {
      try {
        const output = await runProcess(git, ["--version"], this.paths.installRoot);
        checks.push({
          id: "git-runtime-smoke",
          label: "Git 可执行文件",
          status: "ok",
          detail: output || "Git 可启动",
          path: git,
        });
      } catch (error) {
        checks.push({
          id: "git-runtime-smoke",
          label: "Git 可执行文件",
          status: "error",
          detail: `依赖损坏: ${toDetail(error)}`,
          path: git,
        });
      }
    }

    this.dependencyCache = { expiresAt: Date.now() + DEPENDENCY_CACHE_MS, checks };
    return checks;
  }

  private async checkNapCatWebUi(): Promise<InitCheck> {
    const result = await this.readNapCatWebUiToken();
    if (result.token) {
      return {
        id: "napcat-webui-token",
        label: "NapCat WebUI token",
        status: "ok",
        detail: "已找到 token",
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
      join(this.paths.modulesRoot, "napcat", "napcat", "config"),
      ...versions.flatMap((version) => [
      join(this.paths.modulesRoot, "napcat", "versions", version, "resources", "app", "napcat", "config"),
      join(
        this.paths.modulesRoot,
        "napcatframework",
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
      join(this.paths.modulesRoot, "napcat", "versions"),
      join(this.paths.modulesRoot, "napcatframework", "versions"),
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
