import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InitCheck, InitRepairResult, InitState, RuntimePaths } from "../../shared/contracts";

const QQ_PATTERN = /qq_account\s*=\s*["']?(\d+)["']?/;
const DEPENDENCY_CACHE_MS = 15_000;

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

export class InitManager {
  private dependencyCache?: { expiresAt: number; checks: InitCheck[] };

  constructor(private readonly paths: RuntimePaths) {}

  async getState(): Promise<InitState> {
    const qqAccount = await this.readQqAccount();
    const dependencyChecks = await this.checkDependencies();
    const napCatWebUiCheck = await this.checkNapCatWebUi();
    const checks: InitCheck[] = [
      checkDir(this.paths.runtimeRoot, "内置 runtime", "runtime"),
      checkFile(this.getPythonPath(), "内置 Python", "python"),
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
    const changedFiles: string[] = [];

    await mkdir(this.paths.logsRoot, { recursive: true });

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
    const candidates = [
      join(this.paths.runtimeRoot, "python31211", "bin", "python.exe"),
      join(this.paths.runtimeRoot, "python31211", "python.exe"),
    ];

    return candidates.find((path) => existsSync(path)) ?? candidates[0];
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

    const python = this.getPythonPath();
    if (!existsSync(python)) {
      const checks = [
        {
          id: "python-dependencies",
          label: "Python 依赖完整性",
          status: "error" as const,
          detail: "内置 Python 缺失，无法检查依赖",
          path: python,
        },
      ];
      this.dependencyCache = { expiresAt: Date.now() + DEPENDENCY_CACHE_MS, checks };
      return checks;
    }

    const checks: InitCheck[] = [];
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
    const versionRoots = [
      join(this.paths.modulesRoot, "napcat", "versions"),
      join(this.paths.modulesRoot, "napcatframework", "versions"),
    ];
    const versionDirs: string[] = [];

    for (const root of versionRoots) {
      if (!existsSync(root)) {
        continue;
      }

      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          versionDirs.push(join(root, entry.name));
        }
      }
    }

    if (versionDirs.length === 0) {
      return [
        join(
          this.paths.modulesRoot,
          "napcat",
          "versions",
          "9.9.21-39038",
          "resources",
          "app",
          "napcat",
          "config",
        ),
        join(
          this.paths.modulesRoot,
          "napcatframework",
          "versions",
          "9.9.21-39038",
          "resources",
          "app",
          "LiteLoader",
          "plugins",
          "NapCat",
          "config",
        ),
      ];
    }

    return versionDirs.flatMap((versionDir) => [
      join(versionDir, "resources", "app", "napcat", "config"),
      join(versionDir, "resources", "app", "LiteLoader", "plugins", "NapCat", "config"),
    ]);
  }

  private async findNapCatVersions(): Promise<string[]> {
    const roots = [
      join(this.paths.modulesRoot, "napcat", "versions"),
      join(this.paths.modulesRoot, "napcatframework", "versions"),
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

    return versions.size > 0 ? [...versions] : ["9.9.21-39038"];
  }
}
