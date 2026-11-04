import { QQ_OFFICIAL_ADAPTER_PLUGIN_ID } from "../../shared/qq-official-adapter";
import type { ProtocolConnection } from "./protocol-backend-manager";
import type { MaiBotHostClient } from "./maibot-host-client";

const ONEBOT_ADAPTER_ID = "maibot-team.snowluma-adapter";
export type ManagedAdapter = "onebot" | "official";
type AdapterConfig = Record<string, unknown>;

/** A narrow API consumer, with no plugin discovery, filesystem writes or offline fallback. */
export class MaiBotAdapterClient {
  private mutation: Promise<unknown> = Promise.resolve();

  private botId?: string;
  constructor(private readonly host: MaiBotHostClient, private readonly selectBot: () => Promise<string>) {}

  private async call(path: string, config?: AdapterConfig, method?: string): Promise<Record<string, unknown>> {
    if (!this.botId) throw new Error("请先选择要配置的机器人");
    const result = await this.host.call(`/api/host/bots/${encodeURIComponent(this.botId)}/proxy/api/webui/plugins/${path}`,
      method ?? (config === undefined ? "GET" : "PUT"), config === undefined ? undefined : { config });
    if (result.success === false) throw new Error("MaiBot 拒绝了适配器配置操作，请在 WebUI 检查。");
    if (result.runtime_status === "config_error" || result.runtime_status === "failed") {
      throw new Error("MaiBot 已保存配置，但适配器运行失败，请在 WebUI 检查。");
    }
    return result;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(async () => {
      this.botId = await this.selectBot();
      try { return await operation(); } finally { this.botId = undefined; }
    });
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
  }
}
