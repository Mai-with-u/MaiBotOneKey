import type { MaiBotSetupStatus } from "../../shared/contracts";
import type { MaiBotHostClient } from "./maibot-host-client";

export async function readMaiBotSetupStatus(host: MaiBotHostClient): Promise<MaiBotSetupStatus> {
  const result = await host.call("/api/webui/setup/status");
  if (typeof result.is_first_setup !== "boolean") throw new Error("MaiBot 返回了无效的首次配置状态");
  return result.is_first_setup ? "pending" : "complete";
}
