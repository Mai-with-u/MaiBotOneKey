import { MaiBotHostClient } from "./maibot-host-client";
import { importWorkspaceConfig, resetWorkspaceBotData, readWorkspaceBots, type WorkspaceBot } from "./maibot-workspace";
import { resolveGitPath } from "./git-runtime";
import { ProtocolComponentManager } from "./protocol-component-manager";
import { readMaiBotSetupStatus } from "./maibot-setup-client";
import { runProcess, runWithoutAsar, samePath, sameOrInsidePath } from "./runtime-file-utils";
import { ProtocolBackendManager } from "./protocol-backend-manager";
import { MaiBotAdapterClient } from "./maibot-adapter-client";
import type { MaiBotDeploymentManager } from "./maibot-deployment-manager";
import { isMaiBotPackageMode, readMaiBotDeployment } from "./maibot-deployment-state";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { QQ_OFFICIAL_ADAPTER_DIRECTORY, QQ_OFFICIAL_ADAPTER_PLUGIN_ID } from "../../shared/qq-official-adapter";
import type {
  AgreementDocument,
  AgreementDocumentId,
  InitCheck,
  InitRepairResult,
  InitState,
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataResetResult,
  MaiBotModuleUpdateProgress,
  QqComponentUpgradeResult,
  QqComponentUpgradeId,
  QqBackend,
  QqProtocol,
  QqProtocolOptions,
  RuntimePaths,
  ServiceId,
  SnowLumaResetResult,
  StartupAgreementDismissResult,
  StartupAgreementState,
} from "../../shared/contracts";

const DEPENDENCY_CACHE_MS = 15_000;
const PYTHON_RUNTIME_DIR = "python";
const PYTHON_MINIMUM_VERSION = "3.12";
const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";
const GIT_DOWNLOAD_URL = "https://git-scm.com/download/win";
const MAIBOT_FALLBACK_CONFIG_VERSION = "8.10.22";
const MAIBOT_WEBUI_FALLBACK_HOST = "127.0.0.1";
const MAIBOT_WEBUI_FALLBACK_PORT = 8001;
interface MacNapCatQqCleanupResult {
  restoredPackage: boolean;
  cleanedRuntime: boolean;
}


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

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const AGREEMENT_FILES: Array<{ id: AgreementDocumentId; title: string; fileName: string; envVar: string }> = [
  { id: "eula", title: "使用须知", fileName: "EULA.md", envVar: "EULA_AGREE" },
  { id: "privacy", title: "隐私说明", fileName: "PRIVACY.md", envVar: "PRIVACY_AGREE" },
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
  private deploymentManager?: MaiBotDeploymentManager;

  setDeploymentManager(manager: MaiBotDeploymentManager): void { this.deploymentManager = manager; }
  cancelMaiBotInstall(): boolean { return this.deploymentManager?.cancel() ?? false; }
  async ensureMaiBotPackage(onOutput?: (line: string) => void, onProgress?: (progress: MaiBotModuleUpdateProgress) => void): Promise<void> {
    await this.deploymentManager?.ensureInstalled((progress) => {
      if (progress.log) onOutput?.(progress.log);
      onProgress?.(progress);
    });
    if (this.deploymentManager?.isPackageMode()) {
      await this.ensureBundledMaiBotPluginSubtree(SNOWLUMA_ADAPTER_DIR, ["plugin.py"], SNOWLUMA_ADAPTER_PLUGIN_ID);
      await this.ensureBundledMaiBotPluginSubtree(QQ_OFFICIAL_ADAPTER_DIR, ["plugin.py", "settings.py", "codec.py", "_manifest.json"], QQ_OFFICIAL_ADAPTER_PLUGIN_ID);
    }
  }

  readonly protocolComponents: ProtocolComponentManager;
  readonly protocols: ProtocolBackendManager;
  readonly adapters: MaiBotAdapterClient;
  readonly host: MaiBotHostClient;
  chooseBot?: (bots: WorkspaceBot[], purpose: string) => Promise<WorkspaceBot>;

  async selectBot(purpose: string): Promise<WorkspaceBot> {
    const bots = await readWorkspaceBots(this.paths.maibotRoot, this.getPythonPath());
    if (bots.length === 1) return bots[0];
    if (bots.length === 0) throw new Error("请先启动 MaiBot 1.4.0 完成工作区初始化。");
    if (!this.chooseBot) throw new Error("请选择要操作的机器人。");
    return this.chooseBot(bots, purpose);
  }
  constructor(private readonly paths: RuntimePaths) {
    this.protocolComponents = new ProtocolComponentManager(paths);
    this.protocols = new ProtocolBackendManager(paths);
    this.host = new MaiBotHostClient(() => this.readMaiBotWebUiEndpointSync().url, async () => (await this.readMaiBotWebUiToken()).token);
    this.adapters = new MaiBotAdapterClient(this.host, async () => (await this.selectBot("配置 QQ 适配器")).bot_id);
  }

  resetSnowLumaComponent(): Promise<SnowLumaResetResult> { return this.protocolComponents.resetSnowLumaComponent(); }
  upgradeQqComponents(component?: QqComponentUpgradeId): Promise<QqComponentUpgradeResult> { return this.protocolComponents.upgradeQqComponents(component); }
  getQqBackendSync() { return this.protocols.getQqBackendSync(); }
  async getMaiBotSetupStatus() {
    // Read the active instance's latest token on every request, including after password changes.
    return readMaiBotSetupStatus(this.host);
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
      isMaiBotPackageMode(this.paths)
        ? { id: "maibot-entry", label: "MaiBot PyPI 环境", status: readMaiBotDeployment(this.paths.maibotRoot) ? "ok" : "warning", detail: readMaiBotDeployment(this.paths.maibotRoot)?.packageVersion ?? "首次启动时安装 MaiBot" }
        : checkFile(join(this.paths.maibotRoot, "bot.py"), "MaiBot 启动文件", "maibot-entry"),
      this.checkMaiBotWebUiEndpoint(),
      ...qqModuleChecks,
      ...dependencyChecks,
    ];
    const isReady = checks.every((check) => check.status !== "error");
    return { isReady, qqAccount, qqBackend, qqProtocol: this.getQqProtocolSync(), messagePlatformConfigured, checks };
  }

  async refreshDependencyChecks(): Promise<InitCheck[]> {
    return this.checkDependencies();
  }

  async repair(onProgress?: (progress: MaiBotModuleUpdateProgress) => void): Promise<InitRepairResult> {
    const changedFiles = await this.ensureModulesReady(onProgress);

    const state = {
      ...(await this.getState()),
      repairedAt: Date.now(),
    };
    return { state, changedFiles };
  }

  async getAgreementState(): Promise<StartupAgreementState> {
    const documents = await Promise.all(AGREEMENT_FILES.map((agreement) => this.readAgreementDocument(agreement)));
    return { isDismissed: existsSync(this.agreementStorePath()), documents };
  }

  async dismissAgreements(): Promise<StartupAgreementDismissResult> {
    const storePath = this.agreementStorePath();
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify({ dismissedAt: Date.now() })}\n`, "utf8");
    return { state: await this.getAgreementState(), changedFiles: [storePath] };
  }

  // Older MaiBot cores still require these hashes to start without terminal input.
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

  /**
   * Import into the chosen Bot through Core, preserving shared settings and backing up the old file.
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

    const hasWorkspace = existsSync(join(this.paths.maibotRoot, "host", "registry.sqlite3"));
    const bot = hasWorkspace ? await this.selectBot("导入机器人配置") : undefined;
    const configDir = join(bot ? bot.directory : this.paths.maibotRoot, "config");
    const destPath = join(configDir, fileName);
    let backupPath: string | undefined;
    if (bot) {
      // Core validates paths and backs up both the Bot file and any affected shared catalog atomically.
      await importWorkspaceConfig(this.paths.maibotRoot, this.getPythonPath(), isMaiBotPackageMode(this.paths), bot, fileName, sourcePath);
      backupPath = join(bot.directory, "temp", "data-import");
    } else {
      // Before the first launch there is no shared catalog; Core migrates this configuration on startup.
      await mkdir(configDir, { recursive: true });
      if (existsSync(destPath)) {
        backupPath = `${destPath}.bak.${Date.now()}`;
        await copyFile(destPath, backupPath);
      }
      await copyFile(sourcePath, destPath);
    }

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
   * Clear the selected Bot data under Core process leases, never the workspace or another Bot.
   * Only applies to writable module directories; bundled template mode refuses to run this.
   */
  async resetMaiBotData(): Promise<MaiBotDataResetResult> {
    if (samePath(this.paths.maibotRoot, join(this.paths.bundledModulesRoot, "MaiBot"))) {
      throw new Error("当前指向内置模板目录，拒绝清空数据；请在打包后的环境执行。");
    }

    const bot = await this.selectBot("清空机器人数据");
    const dataDir = join(bot.directory, "data");
    const removed = await resetWorkspaceBotData(this.paths.maibotRoot, this.getPythonPath(), isMaiBotPackageMode(this.paths), bot);
    return { dataDir, removedEntries: removed, clearedAt: Date.now() };
  }

  private agreementStorePath(): string {
    return join(this.paths.userDataRoot, AGREEMENT_STORE_FILE);
  }

  async ensureModulesReady(onProgress?: (progress: MaiBotModuleUpdateProgress) => void): Promise<string[]> {
    return [
      ...(await this.ensureServiceReady("maibot", onProgress)),
      ...(await this.ensureServiceReady("napcat")),
    ];
  }

  async ensureServiceReady(serviceId: ServiceId, onProgress?: (progress: MaiBotModuleUpdateProgress) => void): Promise<string[]> {
    await mkdir(this.paths.logsRoot, { recursive: true });

    if (!existsSync(this.paths.bundledModulesRoot)) {
      throw new Error(`内置 modules 模板缺失: ${this.paths.bundledModulesRoot}`);
    }

    if (serviceId === "maibot") {
      const packageMode = isMaiBotPackageMode(this.paths);
      if (packageMode) await this.ensureMaiBotPackage(undefined, onProgress);
      const changedFiles = packageMode ? [] : await this.ensureBundledModuleSubtree("MaiBot", ["bot.py"], {
        excludeRelativePaths: [NAPCAT_ADAPTER_DIR, SNOWLUMA_ADAPTER_DIR, QQ_OFFICIAL_ADAPTER_DIR],
      });
      changedFiles.push(...(await this.ensureBundledMaiBotPluginSubtree(SNOWLUMA_ADAPTER_DIR, ["plugin.py"], SNOWLUMA_ADAPTER_PLUGIN_ID)));
      changedFiles.push(...(await this.ensureBundledMaiBotPluginSubtree(QQ_OFFICIAL_ADAPTER_DIR, ["plugin.py", "settings.py", "codec.py", "_manifest.json"], QQ_OFFICIAL_ADAPTER_PLUGIN_ID)));
      const repairedConfig = packageMode || existsSync(join(this.paths.maibotRoot, "host", "registry.sqlite3")) ? undefined : await this.repairBotConfigVersionInfo();
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
    if (this.deploymentManager?.getState()) return this.deploymentManager.getPython().getPythonPath();
    return this.getBundledPythonPath() ?? this.getBundledPythonCandidates()[0];
  }

  getGitPath(): Promise<string | undefined> {
    return resolveGitPath(this.paths.runtimeRoot);
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
    let botRoot = this.paths.maibotRoot;
    if (existsSync(join(botRoot, "host", "registry.sqlite3"))) {
      const bots = await readWorkspaceBots(botRoot, this.getPythonPath());
      const rootBot = bots.find((bot) => samePath(bot.directory, botRoot));
      if (rootBot) botRoot = rootBot.directory;
      else if (bots.length === 1) botRoot = bots[0].directory;
      else return []; // Multiple Bots without an original root Bot must install adapters explicitly in WebUI.
    }
    const moduleSource = join(this.paths.bundledModulesRoot, "MaiBot", pluginRelativePath);
    const source = pluginRelativePath === QQ_OFFICIAL_ADAPTER_DIR && !existsSync(moduleSource)
      ? join(dirname(this.paths.bundledModulesRoot), "resources", "bundled-plugins", QQ_OFFICIAL_ADAPTER_DIRECTORY)
      : moduleSource;
    const target = join(botRoot, pluginRelativePath);

    if (!existsSync(source) || samePath(source, target)) {
      return [];
    }

    const sourcePluginId = expectedPluginId ?? this.readPluginManifestId(source);
    if (sourcePluginId && this.findMaiBotPluginDirByManifestId(sourcePluginId, botRoot)) {
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

  private findMaiBotPluginDirByManifestId(pluginId: string, botRoot: string): string | undefined {
    const pluginsRoot = join(botRoot, "plugins");
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
    const configPath = join(this.paths.maibotRoot, "host", "config.toml");
    if (!existsSync(configPath)) {
      if (existsSync(join(this.paths.maibotRoot, "host", "registry.sqlite3"))) throw new Error(`公共网络配置缺失: ${configPath}`);
      return { ...buildMaiBotWebUiEndpoint(), fallbackUsed: true, fallbackReason: "工作区尚未初始化，使用默认启动地址" };
    }
    const config = parseToml(readFileSync(configPath, "utf8")).webui;
    if (!config || typeof config !== "object" || Array.isArray(config) || config instanceof Date
      || !Array.isArray(config.hosts) || typeof config.hosts[0] !== "string" || !config.hosts[0].trim()
      || typeof config.port !== "number" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error(`公共网络配置无效: ${configPath}`);
    }
    const endpoint = buildMaiBotWebUiEndpoint(config.hosts[0], config.port);
    return { ...endpoint, url: endpoint.url.replace(/^http:/, config.ssl_certfile ? "https:" : "http:"), sourcePath: configPath };
  }

  /** Read only the active instance's token; missing credentials use normal login. */
  async readMaiBotWebUiToken(): Promise<{ token?: string; exists: boolean; error?: string }> {
    const tokenPath = join(this.paths.maibotRoot, "host", "webui.json");
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
    if (isMaiBotPackageMode(this.paths)) {
      if (this.deploymentManager?.getState()) {
        return join(this.deploymentManager.getPython().getPythonPackagesRoot(), "src", "_resources", fileName);
      }
      const root = dirname(this.paths.runtimeRoot);
      const packaged = join(root, "maibot", fileName);
      return existsSync(packaged) ? packaged : join(root, "resources", "maibot-package", fileName);
    }
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
  ): Promise<AgreementDocument> {
    const sourcePath = this.agreementSourcePath(fileName);
    if (!existsSync(sourcePath)) {
      return {
        id,
        title,
        fileName,
        sourcePath,
        content: "",
        exists: false,
        error: `${fileName} 文件缺失`,
      };
    }

    try {
      const content = await readFile(sourcePath, "utf8");
      return {
        id,
        title,
        fileName,
        sourcePath,
        content,
        exists: true,
      };
    } catch (error) {
      return {
        id,
        title,
        fileName,
        sourcePath,
        content: "",
        exists: false,
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

    const git = await this.getGitPath();
    if (!git) {
      checks.push({
        id: "git-runtime",
        label: "Git",
        status: isMaiBotPackageMode(this.paths) ? "warning" : "error",
        detail: "未找到可用 Git",
        path: git,
        actionLabel: "下载 Git",
        actionUrl: GIT_DOWNLOAD_URL,
      });
    } else {
      checks.push({
        id: "git-runtime",
        label: "Git",
        status: "ok",
        detail: sameOrInsidePath(this.paths.runtimeRoot, git) ? "内置 Git 可启动" : "系统 Git 可启动",
        path: git,
      });
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
