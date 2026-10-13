import { expect, test } from "bun:test";
import { MaiBotAdapterClient } from "../../src/main/services/maibot-adapter-client";
import { QQ_OFFICIAL_ADAPTER_PLUGIN_ID } from "../../src/shared/qq-official-adapter";

const id = "maibot-team.snowluma-adapter";
function fixture() {
  const calls: { path: string; method: string; body?: any; cookie?: string }[] = [];
  let enabled = false;
  const request = (async (input: any, init: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init.method!, body, cookie: (init.headers as Record<string, string>).Cookie });
    if (path.endsWith("/toggle")) {
      enabled = !enabled;
      return Response.json({ success: true, enabled, runtime_status: enabled ? "success" : "disabled" });
    }
    if (init.method === "GET") return Response.json({ success: true, config: {
      plugin: { enabled }, client: { server: "127.0.0.1", port: 7988, token: "old" },
      qq_official: { app_id: "saved-id", app_secret: "saved-fixture-secret" },
    } });
    return Response.json({ success: true });
  }) as typeof fetch;
  const client = new MaiBotAdapterClient(() => "http://127.0.0.1:8001/auth?token=unused", async () => "fixture-token", request);
  return { client, calls };
}

test("connection synchronization sends a partial patch to MaiBot without enabling the adapter", async () => {
  const { client, calls } = fixture();
  await client.configureConnection({ host: "127.0.0.1", port: 18088, token: "connection-token" });
  expect(calls.map(({ path, method }) => ({ path, method }))).toEqual([
    { path: `/api/webui/plugins/config/${id}`, method: "GET" },
    { path: `/api/webui/plugins/config/${id}`, method: "PUT" },
  ]);
  expect(calls[1].body).toEqual({ config: { client: { server: "127.0.0.1", port: 18088, token: "connection-token" } } });
  expect(calls[1].cookie).toBe('maibot_session="fixture-token"');
});

test("explicit enable/disable uses MaiBot runtime toggle and repeated enable is a no-op", async () => {
  const { client, calls } = fixture();
  await Promise.all([client.setEnabled("onebot", true), client.setEnabled("onebot", true)]);
  await client.setEnabled("onebot", false);
  expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
    `/api/webui/plugins/config/${id}/toggle`, `/api/webui/plugins/config/${id}/toggle`,
  ]);
});

test("official credentials are sent only to the official adapter, preserving unrelated configuration", async () => {
  const { client, calls } = fixture();
  await client.configureOfficial({ appId: " new-id ", appSecret: " fixture-secret " });
  expect(calls[1].path).toBe(`/api/webui/plugins/config/${QQ_OFFICIAL_ADAPTER_PLUGIN_ID}`);
  expect(calls[1].body).toEqual({ config: { plugin: { enabled: true }, qq_official: { app_id: "new-id", app_secret: "fixture-secret" } } });
  expect(client.officialConfigured).toBe(true);
});

test("missing auth and invalid inputs fail before requesting MaiBot", async () => {
  let requests = 0;
  const client = new MaiBotAdapterClient(() => "http://127.0.0.1:8001", async () => undefined, (async () => { requests++; throw new Error(); }) as typeof fetch);
  await expect(client.configureConnection({ host: "127.0.0.1", port: 7988, token: "" })).rejects.toThrow("请先启动 MaiBot");
  await expect(client.setEnabled("arbitrary-plugin" as any, true)).rejects.toThrow("不支持的适配器");
  await expect(client.configureConnection({ host: "127.0.0.1", port: 70000, token: "" })).rejects.toThrow("连接信息无效");
  expect(requests).toBe(0);
});

test("API failures are surfaced without offline file fallback or state selection changes", async () => {
  for (const request of [
    (async () => { throw new Error("offline"); }) as typeof fetch,
    (async () => Response.json({ detail: "unsupported" }, { status: 404 })) as typeof fetch,
    (async () => Response.json({ success: false })) as typeof fetch,
  ]) {
    const client = new MaiBotAdapterClient(() => "http://127.0.0.1:8001", async () => "fixture-token", request);
    await expect(client.configureOfficial()).rejects.toThrow();
    expect(client.officialConfigured).toBeUndefined();
  }
});

test("a failed enable operation does not block later mutations", async () => {
  const { client, calls } = fixture();
  await expect(client.setEnabled("invalid" as any, true)).rejects.toThrow();
  await client.setEnabled("onebot", true);
  expect(calls.at(-1)?.method).toBe("POST");
});
