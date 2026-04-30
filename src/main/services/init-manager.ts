import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgreementDocument,
  AgreementDocumentId,
  InitCheck,
  InitRepairResult,
  InitState,
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

  async setQqAccount(qqAccount: string, websocketToken = createWebsocketToken()): Promise<InitState> {
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
    return this.getState();
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
      const changedFiles = await this.ensureBundledModuleSubtree("MaiBot", ["bot.py"]);
      const repairedConfig = await this.repairBotConfigVersionInfo();
      return repairedConfig ? [...changedFiles, repairedConfig] : changedFiles;
    }

    const changedFiles = [
      ...(await this.ensureBundledModuleSubtree("napcat", [
        "NapCatWinBootMain.exe",
        join("Files", "versions", "config.json"),
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

    for (const version of versions) {
      const configDir = join(this.paths.modulesRoot, "napcat", "versions", version, "resources", "app", "napcat", "config");
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
    const versions = await this.findNapCatVersions();
    return versions.flatMap((version) => [
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
    ]);
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
