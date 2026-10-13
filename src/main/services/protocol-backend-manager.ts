import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeQqAccount } from "../../shared/qq-account";
import type { QqBackend, QqProtocol, RuntimePaths } from "../../shared/contracts";

const QQ_BACKEND_FILE = "qq-backend.json";
const MESSAGE_PLATFORM_FILE = "message-platform.json";
const ONEBOT_HOST = "127.0.0.1";
const NAPCAT_ONEBOT_PORT = 7998;
const SNOWLUMA_ONEBOT_PORT = 7988;
const SNOWLUMA_WEBUI_PORT = 5099;
export interface ProtocolConnection { host: string; port: number; token: string }
interface StoredMessagePlatformFile {
  version: 1;
  backend?: QqBackend;
  qqAccount?: string;
  accounts?: Partial<Record<QqBackend, string>>;
  configuredAt?: number;
}
function toDetail(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function asTcpPort(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Owns protocol configuration only. No MaiBot paths, plugin files, or runtime APIs. */
export class ProtocolBackendManager {
  constructor(private readonly paths: Pick<RuntimePaths, "userDataRoot" | "napcatRoot" | "snowlumaRoot" | "bundledModulesRoot">) {}
  getQqBackendSync(): QqBackend {
    try {
      const parsed = JSON.parse(readFileSync(this.qqBackendPath(), "utf8")) as { backend?: unknown };
      return parsed.backend === "snowluma" ? "snowluma" : "napcat";
    } catch {
      return this.paths.bundledModulesRoot
        && !existsSync(join(this.paths.bundledModulesRoot, "napcat"))
        && existsSync(join(this.paths.bundledModulesRoot, "SnowLuma"))
        ? "snowluma" : "napcat";
    }
  }

  async readQqBackend(): Promise<QqBackend> {
    return this.getQqBackendSync();
  }

  getQqProtocolSync(): QqProtocol {
    try {
      const stored = JSON.parse(readFileSync(this.qqBackendPath(), "utf8"));
      if (stored.protocol === "official") return "official";
    } catch {
      // Existing installations use their saved QQ backend.
    }
    return this.getQqBackendSync();
  }

  async saveQqProtocolSelection(protocol: QqProtocol): Promise<void> {
    const path = this.qqBackendPath();
    const stored = await readFile(path, "utf8").then((text) => JSON.parse(text)).catch(() => ({}));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ ...stored, protocol, updatedAt: Date.now() }, null, 2)}\n`, "utf8");
  }


  private readQqBackendConnections(): Partial<Record<QqBackend, { port: number; token?: string }>> {
    const connections: Partial<Record<QqBackend, { port: number; token?: string }>> = {};
    try {
      const stored = JSON.parse(readFileSync(this.qqBackendPath(), "utf8"));
      for (const backend of ["napcat", "snowluma"] as const) {
        const saved = stored.connections?.[backend];
        const port = saved?.port ?? stored.ports?.[backend];
        if (Number.isInteger(port) && port >= 1 && port <= 65535) {
          connections[backend] = {
            port,
            token: typeof saved?.token === "string" ? saved.token : undefined,
          };
        }
      }
    } catch {
      // Older installations have no per-backend connection history.
    }
    return connections;
  }


  hasMessagePlatformConfigured(): boolean {
    return Boolean(this.getMessagePlatformQqAccount());
  }

  getMessagePlatformQqAccount(backend: QqBackend = this.getQqBackendSync()): string | undefined {
    return normalizeQqAccount(this.readMessagePlatformStore()?.accounts?.[backend]);
  }


  async readNapcatWebsocketServer(qqAccount?: string): Promise<ProtocolConnection | undefined> {
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
          network?: { websocketServers?: Array<{ name?: string; host?: string; token?: string; port?: number }> };
        };
        const server =
          parsed?.network?.websocketServers?.find((entry) => entry?.name === "MaiBot Main") ??
          parsed?.network?.websocketServers?.find((entry) => entry?.port === NAPCAT_ONEBOT_PORT) ??
          parsed?.network?.websocketServers?.find((entry) => entry?.port);
        if (server?.port) {
          return {
            host: server.host ? String(server.host) : ONEBOT_HOST,
            port: Number.isFinite(server.port) && server.port ? Math.floor(server.port) : NAPCAT_ONEBOT_PORT,
            token: typeof server.token === "string" ? server.token : "",
          };
        }
      }
    } catch {
      // A missing or invalid protocol config is reported by connection().
    }
    return undefined;
  }

  async readNapcatWebsocketToken(qqAccount?: string): Promise<string> {
    return (await this.readNapcatWebsocketServer(qqAccount))?.token ?? "";
  }

  async readSnowLumaWebsocketServer(qqAccount?: string): Promise<ProtocolConnection | undefined> {
    try {
      const raw = await readFile(join(this.paths.snowlumaRoot, "config", qqAccount ? `onebot_${qqAccount}.json` : "onebot.json"), "utf8");
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
        host: server.host ? String(server.host) : ONEBOT_HOST,
        port: Number.isFinite(server.port) ? Math.floor(server.port) : SNOWLUMA_ONEBOT_PORT,
        token: server.accessToken ? String(server.accessToken) : "",
      };
    } catch {
      return undefined;
    }
  }



  readSnowLumaServicePortsSync(): { webui: number; onebot: number; error?: string } {
    const errors: string[] = [];
    const readConfig = (name: string): Record<string, unknown> => {
      const path = join(this.paths.snowlumaRoot, "config", name);
      if (!existsSync(path)) return {};
      try {
        const config = JSON.parse(readFileSync(path, "utf8"));
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置必须是对象");
        return config;
      } catch (error) {
        errors.push(`SnowLuma 配置读取失败: ${path}: ${toDetail(error)}`);
        return {};
      }
    };
    const runtime = readConfig("runtime.json");
    const account = this.getMessagePlatformQqAccount("snowluma");
    const accountFile = account ? `onebot_${account}.json` : "onebot.json";
    const onebot = existsSync(join(this.paths.snowlumaRoot, "config", accountFile)) ? readConfig(accountFile) : readConfig("onebot.json");
    const networks = onebot.networks as { wsServers?: Array<{ name?: string; port?: number }> } | undefined;
    const server = Array.isArray(networks?.wsServers) ? networks.wsServers.find((item) => item?.name === "MaiBot Main") : undefined;
    return { webui: asTcpPort(runtime.webuiPort, SNOWLUMA_WEBUI_PORT), onebot: asTcpPort(server?.port, SNOWLUMA_ONEBOT_PORT), error: errors[0] };
  }


  async ensureNapCatWebUiConfig(): Promise<string | undefined> {
    const writeDefaultWebUiConfig = async (token: string): Promise<void> => {
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

      for (const configDir of await this.findNapCatRuntimeConfigWriteDirs()) {
        const target = join(configDir, "webui.json");
        if (existsSync(target)) {
          continue;
        }

        await mkdir(configDir, { recursive: true });
        await writeFile(target, JSON.stringify(defaultJson, null, 2), "utf8");
      }
    };

    const existing = await this.readNapCatWebUiToken();
    if (existing.token) {
      await writeDefaultWebUiConfig(existing.token);
      return existing.token;
    }

    if (existing.exists) {
      throw new Error(existing.error ?? "NapCat WebUI config exists but token is missing; please check webui.json manually");
    }

    const configDirs = await this.findNapCatRuntimeConfigWriteDirs();
    if (configDirs.length === 0) {
      return undefined;
    }

    const token = randomBytes(6).toString("hex");
    await writeDefaultWebUiConfig(token);

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


  private qqBackendPath(): string {
    return join(this.paths.userDataRoot, QQ_BACKEND_FILE);
  }

  getQqBackendAccounts(): Partial<Record<QqBackend, string>> {
    const stored = this.readMessagePlatformStore();
    return { ...stored?.accounts };
  }

  private messagePlatformPath(): string {
    return join(this.paths.userDataRoot, MESSAGE_PLATFORM_FILE);
  }

  private readMessagePlatformStore(): StoredMessagePlatformFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.messagePlatformPath(), "utf8")) as Partial<StoredMessagePlatformFile>;
      const backend = parsed.backend === "snowluma" ? "snowluma" : parsed.backend === "napcat" ? "napcat" : undefined;
      return {
        version: 1,
        backend,
        accounts: {
          napcat: typeof parsed.accounts?.napcat === "string" ? parsed.accounts.napcat
            : !parsed.accounts && backend === "napcat" && typeof parsed.qqAccount === "string" ? parsed.qqAccount : undefined,
          snowluma: typeof parsed.accounts?.snowluma === "string" ? parsed.accounts.snowluma
            : !parsed.accounts && backend === "snowluma" && typeof parsed.qqAccount === "string" ? parsed.qqAccount : undefined,
        },
        configuredAt: typeof parsed.configuredAt === "number" ? parsed.configuredAt : undefined,
      };
    } catch {
      return undefined;
    }
  }


  private async markMessagePlatformConfigured(
    backend: QqBackend,
    qqAccount: string,
    recordAccount = false,
  ): Promise<void> {
    const existing = this.readMessagePlatformStore();
    await mkdir(dirname(this.messagePlatformPath()), { recursive: true });
    await writeFile(
      this.messagePlatformPath(),
      `${JSON.stringify({
        version: 1,
        backend,
        accounts: { ...this.getQqBackendAccounts(), ...(recordAccount ? { [backend]: qqAccount } : {}) },
        configuredAt: existing?.configuredAt ?? Date.now(),
        updatedAt: Date.now(),
      }, null, 2)}\n`,
      "utf8",
    );
  }


  private async createNapCatConfigs(
    qqAccount: string,
    websocketToken: string,
    websocketPort = NAPCAT_ONEBOT_PORT,
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

    for (const configDir of await this.findNapCatRuntimeConfigWriteDirs()) {
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
    const runtimePath = join(configDir, "runtime.json");
    const runtime = existsSync(runtimePath) ? JSON.parse(await readFile(runtimePath, "utf8")) : {};
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
      throw new Error("SnowLuma 运行配置格式错误，请修复 runtime.json 后重试。");
    }
    await writeFile(runtimePath, JSON.stringify({
      ...runtime,
      webuiPort: runtime.webuiPort ?? SNOWLUMA_WEBUI_PORT,
      hookAutoLoad: false,
    }, null, 2), "utf8");
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
    if (qqAccount) {
      await writeFile(join(configDir, `onebot_${qqAccount}.json`), serialized, "utf8");
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
    if (process.platform !== "darwin") {
      return [join(this.paths.napcatRoot, "napcat", "config")];
    }

    return uniquePaths([
      this.macNapCatRuntimeConfigDir(),
      join(homedir(), "Library", "Application Support", "QQ", "NapCat", "config"),
      join(this.paths.napcatRoot, "napcat", "config"),
    ]);
  }

  private async findNapCatRuntimeConfigWriteDirs(): Promise<string[]> {
    if (process.platform === "darwin") {
      return [this.macNapCatRuntimeConfigDir()];
    }

    return [join(this.paths.napcatRoot, "napcat", "config")];
  }

  private macNapCatRuntimeConfigDir(): string {
    const qqContainer = process.env.NAPCAT_QQ_CONTAINER?.trim()
      ? resolve(process.env.NAPCAT_QQ_CONTAINER.trim())
      : join(homedir(), "Library", "Containers", "com.tencent.qq", "Data");
    return join(qqContainer, "Documents", "napcat", "config");
  }


  private async selectBackend(backend: QqBackend): Promise<void> {
    if (backend !== "napcat" && backend !== "snowluma") throw new Error("不支持的 QQ 协议端");
    const statePath = this.qqBackendPath();
    const stored = await readFile(statePath, "utf8").then(JSON.parse).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return {};
    });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ ...stored, version: 1, backend, protocol: backend, updatedAt: Date.now() }, null, 2), "utf8");
  }

  async setQqBackend(backend: QqBackend, prepare: () => Promise<unknown> = async () => {}): Promise<void> {
    const statePath = this.qqBackendPath();
    const previous = await readFile(statePath, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    try {
      await this.selectBackend(backend);
      await prepare();
      const account = this.getMessagePlatformQqAccount(backend);
      if (account) await this.configureAccount(account, backend);
    } catch (error) {
      if (previous === undefined) await rm(statePath, { force: true });
      else await writeFile(statePath, previous, "utf8");
      throw error;
    }
  }

  async configureAccount(account: string, backend: QqBackend, token?: string): Promise<string[]> {
    const normalized = normalizeQqAccount(account);
    if (!normalized) throw new Error("QQ 号必须是纯数字且不能为 0");
    if (backend !== "napcat" && backend !== "snowluma") throw new Error("不支持的 QQ 协议端");
    const existing = backend === "snowluma"
      ? await this.readSnowLumaWebsocketServer(normalized)
      : await this.readNapcatWebsocketServer(normalized);
    const saved = this.readQqBackendConnections()[backend];
    const port = existing?.port ?? saved?.port ?? (backend === "snowluma" ? SNOWLUMA_ONEBOT_PORT : NAPCAT_ONEBOT_PORT);
    const resolvedToken = token ?? existing?.token ?? saved?.token ?? randomBytes(24).toString("base64url");
    if (backend === "snowluma") await this.createSnowLumaConfigs(normalized, resolvedToken, port);
    else { await this.createNapCatConfigs(normalized, resolvedToken, port); await this.ensureNapCatWebUiConfig(); }
    await this.markMessagePlatformConfigured(backend, normalized, true);
    await this.selectBackend(backend);
    return backend === "snowluma"
      ? [join(this.paths.snowlumaRoot, "config", `onebot_${normalized}.json`)]
      : (await this.findNapCatRuntimeConfigWriteDirs()).map((dir) => join(dir, `onebot11_${normalized}.json`));
  }

  async connection(backend: QqBackend = this.getQqBackendSync()): Promise<ProtocolConnection> {
    const account = this.getMessagePlatformQqAccount(backend);
    if (!account) throw new Error("请先在消息平台中配置 QQ 账号与协议端。");
    const connection = backend === "snowluma" ? await this.readSnowLumaWebsocketServer(account) : await this.readNapcatWebsocketServer(account);
    if (!connection) throw new Error("协议端连接配置不存在，请先保存协议端账号配置。");
    return connection;
  }

  async saveQqBackendAccount(backend: QqBackend, account: string): Promise<void> {
    const normalized = normalizeQqAccount(account);
    if (!normalized) throw new Error("请输入正确的 QQ 号");
    if (backend !== "napcat" && backend !== "snowluma") throw new Error("不支持的 QQ 协议端");
    if (backend === this.getQqBackendSync() && this.getQqProtocolSync() !== "official") {
      await this.configureAccount(normalized, backend); return;
    }
    await this.markMessagePlatformConfigured(backend, normalized, true);
  }
}
