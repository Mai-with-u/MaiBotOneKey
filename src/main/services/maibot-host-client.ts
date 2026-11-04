/** One authenticated host session shared by setup and adapter operations. */
export class MaiBotHostClient {
  private session?: { endpoint: string; token: string; cookie: string };
  private login?: Promise<string>;

  constructor(
    private readonly endpoint: () => string,
    private readonly token: () => Promise<string | undefined>,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async cookie(): Promise<string> {
    const endpoint = this.endpoint();
    const token = await this.token();
    if (!token) throw new Error("请先启动 MaiBot 并完成 WebUI 初始化。");
    if (this.session?.endpoint === endpoint && this.session.token === token) return this.session.cookie;
    if (this.login) { await this.login; return this.cookie(); }
    this.login = (async () => {
      const response = await this.request(new URL("/api/webui/auth/verify", endpoint), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }), redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok || (await response.json()).valid !== true) throw new Error("MaiBot 登录失败，请检查 WebUI 密码。");
      const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0])
        .find((value) => /^maibot_host_session_[a-f0-9]+=/.test(value));
      if (!cookie) throw new Error("MaiBot 未返回宿主登录会话，请升级至 1.4.0。");
      this.session = { endpoint, token, cookie };
      return cookie;
    })();
    try { return await this.login; } finally { this.login = undefined; }
  }

  async call(path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.request(new URL(path, this.endpoint()), {
      method, headers: { Cookie: await this.cookie(), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401) this.session = undefined;
    if (!response.ok) throw new Error(`MaiBot API 返回 HTTP ${response.status}，请检查主程序状态。`);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("MaiBot 返回了无效的 API 响应");
    return result as Record<string, unknown>;
  }
}
