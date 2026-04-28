import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InitCheck, InitRepairResult, InitState, RuntimePaths, ServiceId } from "../../shared/contracts";

const QQ_PATTERN = /qq_account\s*=\s*["']?(\d+)["']?/;
const DEPENDENCY_CACHE_MS = 15_000;
const PYTHON_RUNTIME_DIR = "python";
const GIT_RUNTIME_DIR = "git";
const NAPCAT_FALLBACK_VERSION = "9.9.26-44498";

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

  async setQqAccount(qqAccount: string): Promise<InitState> {
    if (!isDigits(qqAccount)) {
      throw new Error("QQ 号必须是纯数字");
    }

    await this.ensureServiceReady("maibot");

    const botConfigPath = this.botConfigPath();
    let content = existsSync(botConfigPath)
      ? await readFile(botConfigPath, "utf8")
      : "[bot]\n";

    if (QQ_PATTERN.test(content)) {
      content = content.replace(QQ_PATTERN, `qq_account = ${qqAccount}`);
    } else if (/\[bot\]/.test(content)) {
      content = content.replace(/\[bot\]/, `[bot]\nqq_account = ${qqAccount}`);
    } else {
      content += `\n[bot]\nqq_account = ${qqAccount}\n`;
    }

    await mkdir(dirname(botConfigPath), { recursive: true });
    await writeFile(botConfigPath, content, "utf8");
    await this.createNapCatConfigs(qqAccount);
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
      return [];
    }

    if (!existsSync(this.paths.bundledModulesRoot)) {
      throw new Error(`内置 modules 模板缺失: ${this.paths.bundledModulesRoot}`);
    }

    if (serviceId === "maibot") {
      return this.ensureBundledModuleSubtree("MaiBot", ["bot.py"]);
    }

    return [
      ...(await this.ensureBundledModuleSubtree("napcat", [
        "NapCatWinBootMain.exe",
        join("Files", "versions", "config.json"),
      ])),
      ...(await this.ensureBundledModuleSubtree("napcatframework", ["versions"], true)),
    ];
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

  private async createNapCatConfigs(qqAccount: string): Promise<void> {
    const versions = await this.findNapCatVersions();
    const napcatConfig = {
      fileLog: false,
      consoleLog: true,
      fileLogLevel: "debug",
      consoleLogLevel: "info",
      packetBackend: "auto",
      packetServer: "",
      o3HookMode: 1,
    };
    const onebotConfig = {
      network: {
        httpServers: [],
        httpSseServers: [],
        httpClients: [],
        websocketServers: [],
        websocketClients: [
          {
            enable: true,
            name: "MaiBot Main",
            url: "ws://localhost:8095",
            reportSelfMessage: false,
            messagePostFormat: "array",
            token: "",
            debug: false,
            heartInterval: 30000,
            reconnectInterval: 30000,
          },
        ],
        plugins: [],
      },
      musicSignUrl: "",
      enableLocalFile2Url: false,
      parseMultMsg: false,
    };

    for (const version of versions) {
      const configDirs = [
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
      ];

      for (const configDir of configDirs) {
        await mkdir(configDir, { recursive: true });
        await writeFile(
          join(configDir, `napcat_${qqAccount}.json`),
          JSON.stringify(napcatConfig, null, 2),
          "utf8",
        );
        await writeFile(
          join(configDir, `onebot11_${qqAccount}.json`),
          JSON.stringify(onebotConfig, null, 2),
          "utf8",
        );
      }
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
}
