import type { DesktopSnapshot } from "@shared/contracts";
import { createPreviewSnapshot } from "./desktop-preview";

export function validateDesktopSnapshot(value: unknown): DesktopSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("桌面状态格式错误");
  const snapshot = value as Record<string, unknown>;
  const records = ["paths", "windowState", "initState", "startupAgreement", "terminalSettings", "serviceStartupSettings", "launcherUiSettings", "appIconSettings", "codexPetSettings", "networkProxySettings", "moduleVersions"];
  const arrays = ["services", "serviceCommands", "runtimePathConfigs", "runtimeResourcePathConfigs", "recentLogs"];
  for (const key of records) {
    if (!snapshot[key] || typeof snapshot[key] !== "object" || Array.isArray(snapshot[key])) throw new Error(`桌面状态缺失或无效: ${key}`);
  }
  for (const key of arrays) {
    if (!Array.isArray(snapshot[key])) throw new Error(`桌面状态缺失或无效: ${key}`);
  }
  if (typeof snapshot.appVersion !== "string" || typeof snapshot.platform !== "string") throw new Error("桌面版本或平台信息缺失");
  if (snapshot.runtimeOperation !== null && typeof snapshot.runtimeOperation !== "string") throw new Error("桌面接口版本不一致，请完全退出并重新打开启动器。");
  const init = snapshot.initState as Record<string, unknown>;
  const agreement = snapshot.startupAgreement as Record<string, unknown>;
  if (typeof init.isReady !== "boolean" || typeof init.messagePlatformConfigured !== "boolean" || !Array.isArray(init.checks)) throw new Error("初始化状态格式错误");
  if (typeof agreement.isConfirmed !== "boolean" || !Array.isArray(agreement.documents)) throw new Error("启动协议状态格式错误");
  return value as DesktopSnapshot;
}

export async function getDesktopSnapshot(): Promise<DesktopSnapshot> {
  if (!window.maibotDesktop) {
    if (import.meta.env?.DEV) return createPreviewSnapshot();
    throw new Error("无法连接启动器，请重新打开应用。");
  }
  return validateDesktopSnapshot(await window.maibotDesktop.getSnapshot());
}
