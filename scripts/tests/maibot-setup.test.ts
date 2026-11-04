import { expect, test } from "bun:test";
import { MaiBotHostClient } from "../../src/main/services/maibot-host-client";
import { readMaiBotSetupStatus } from "../../src/main/services/maibot-setup-client";

test("setup uses a real host session, reuses it, and logs in again after password changes", async () => {
  let token = "first";
  let completed = false;
  const logins: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/webui/auth/verify") {
      const body = await request.json() as { token: string };
      logins.push(body.token);
      return Response.json({ valid: body.token === token }, { headers: { "Set-Cookie": `maibot_host_session_abc=session-${token}; HttpOnly; Path=/` } });
    }
    expect(request.headers.get("Cookie")).toBe(`maibot_host_session_abc=session-${token}`);
    return Response.json({ is_first_setup: !completed });
  } });
  try {
    const client = new MaiBotHostClient(() => server.url.origin, async () => token);
    expect(await readMaiBotSetupStatus(client)).toBe("pending");
    expect(await readMaiBotSetupStatus(client)).toBe("pending");
    token = "changed"; completed = true;
    expect(await readMaiBotSetupStatus(client)).toBe("complete");
    expect(logins).toEqual(["first", "changed"]);
  } finally { server.stop(true); }
});

test("an expired session never silently retries a mutation", async () => {
  let mutations = 0;
  const request = (async (input: any) => {
    if (new URL(String(input)).pathname.endsWith("/verify")) return Response.json({ valid: true }, { headers: { "Set-Cookie": "maibot_host_session_abc=session; Path=/" } });
    mutations++;
    return Response.json({}, { status: 401 });
  }) as typeof fetch;
  const client = new MaiBotHostClient(() => "http://localhost:8001", async () => "password", request);
  await expect(client.call("/api/host/bots/b/proxy/api/write", "POST", {})).rejects.toThrow("401");
  expect(mutations).toBe(1);
});
