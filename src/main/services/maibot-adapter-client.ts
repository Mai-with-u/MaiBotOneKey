import { QQ_OFFICIAL_ADAPTER_PLUGIN_ID } from "../../shared/qq-official-adapter";
import type { ProtocolConnection } from "./protocol-backend-manager";
import { webuiSessionCookie } from "./local-chat-adapter";

const ONEBOT_ADAPTER_ID = "maibot-team.snowluma-adapter";
export type ManagedAdapter = "onebot" | "official";
type AdapterConfig = Record<string, unknown>;

/** A narrow API consumer, with no plugin discovery, filesystem writes or offline fallback. */
export class MaiBotAdapterClient {
  officialConfigured: boolean | undefined;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly endpoint: () => string,
    private readonly token: () => Promise<string | undefined>,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async call(path: string, config?: AdapterConfig, method?: string): Promise<Record<string, unknown>> {
    const token = await this.token();
    if (!token) throw new Error("请先启动 MaiBot Core 并完成 WebUI 初始化，再配置适配器。");
    let response: Response;
    try {
      response = await this.request(new URL(`/api/webui/plugins/${path}`, this.endpoint()), {
        cache: "no-store",
        method: method ?? (config === undefined ? "GET" : "PUT"),
        headers: { Cookie: webuiSessionCookie(token), "Content-Type": "application/json" },
        body: config === undefined ? undefined : JSON.stringify({ config }),
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
      });
    } catch {
      throw new Error("MaiBot 适配器 API 不可达，请确认 Core 已启动；一键包不会直接修改插件配置。");
    }
    if (!response.ok) {
      throw new Error(`MaiBot 适配器 API 返回 HTTP ${response.status}，请在 WebUI 检查适配器配置。`);
    }
    const result = await response.json() as Record<string, unknown>;
    if (result.success === false) throw new Error("MaiBot 拒绝了适配器配置操作，请在 WebUI 检查。");
    if (result.runtime_status === "config_error" || result.runtime_status === "failed") {
      throw new Error("MaiBot 已保存配置，但适配器运行失败，请在 WebUI 检查。");
    }
    return result;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.catch(() => {});
    return result;
  }

  setEnabled(adapter: ManagedAdapter, enabled: boolean): Promise<void> {
    return this.serialize(() => this.applyEnabled(adapter, enabled));
  }

  private async applyEnabled(adapter: ManagedAdapter, enabled: boolean): Promise<void> {
    if (adapter !== "onebot" && adapter !== "official") throw new Error("不支持的适配器");
    if (typeof enabled !== "boolean") throw new Error("适配器启用状态必须是布尔值");
    const id = adapter === "onebot" ? ONEBOT_ADAPTER_ID : QQ_OFFICIAL_ADAPTER_PLUGIN_ID;
    const config = await this.config(id);
    const plugin = config.plugin as { enabled?: boolean } | undefined;
    if (typeof plugin?.enabled !== "boolean") throw new Error("MaiBot 未返回明确的适配器启用状态，请在 WebUI 操作。");
    if (plugin.enabled === enabled) return;
    const result = await this.call(`config/${encodeURIComponent(id)}/toggle`, undefined, "POST");
    if (result.enabled !== enabled) throw new Error("适配器状态发生变化，请刷新后重新操作。");
  }

  private async config(id: string): Promise<AdapterConfig> {
    const result = await this.call(`config/${encodeURIComponent(id)}`);
    if (!result.config || typeof result.config !== "object" || Array.isArray(result.config)) {
      throw new Error("MaiBot 返回了无效的适配器配置。");
    }
    return result.config as AdapterConfig;
  }

  configureConnection(connection: ProtocolConnection): Promise<void> {
    return this.serialize(() => this.applyConnection(connection));
  }

  private async applyConnection(connection: ProtocolConnection): Promise<void> {
    if (!connection.host || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || typeof connection.token !== "string") {
      throw new Error("协议端连接信息无效。");
    }
    // Read first to verify that this instance exposes the expected adapter.
    await this.config(ONEBOT_ADAPTER_ID);
    await this.call(`config/${encodeURIComponent(ONEBOT_ADAPTER_ID)}`, {
      client: { server: connection.host, port: connection.port, token: connection.token },
    });
  }

  configureOfficial(credentials?: { appId: string; appSecret: string }): Promise<void> {
    return this.serialize(() => this.applyOfficial(credentials));
  }

  private async applyOfficial(credentials?: { appId: string; appSecret: string }): Promise<void> {
    if (credentials && (!credentials.appId.trim() || !credentials.appSecret.trim())) {
      throw new Error("请填写 AppID 和 AppSecret");
    }
    const config = await this.config(QQ_OFFICIAL_ADAPTER_PLUGIN_ID);
    const existing = config.qq_official as { app_id?: string; app_secret?: string } | undefined;
    if (!credentials && (!existing?.app_id?.trim() || !existing?.app_secret?.trim())) {
      throw new Error("请先在 MaiBot WebUI 配置官方 QQ 适配器凭据。");
    }
    await this.call(`config/${encodeURIComponent(QQ_OFFICIAL_ADAPTER_PLUGIN_ID)}`, {
      ...(credentials ? { qq_official: { app_id: credentials.appId.trim(), app_secret: credentials.appSecret.trim() } } : {}),
      plugin: { enabled: true },
    });
    this.officialConfigured = true;
  }
}
