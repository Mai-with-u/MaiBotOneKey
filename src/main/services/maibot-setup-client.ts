import type { MaiBotSetupStatus } from "../../shared/contracts";
import { webuiSessionCookie } from "./local-chat-adapter";

/** Read the Core's persisted setup state, not page navigation or port availability. */
export async function readMaiBotSetupStatus(
  endpoint: string,
  token: string | undefined,
  request: typeof fetch = fetch,
): Promise<MaiBotSetupStatus> {
  if (!token) throw new Error("MaiBot 首次配置状态暂不可用");
  const response = await request(new URL("/api/webui/setup/status", endpoint), {
    headers: { Cookie: webuiSessionCookie(token) },
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`读取 MaiBot 首次配置状态失败（HTTP ${response.status}）`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("is_first_setup" in result) || typeof result.is_first_setup !== "boolean") {
    throw new Error("MaiBot 返回了无效的首次配置状态");
  }
  return result.is_first_setup ? "pending" : "complete";
}
