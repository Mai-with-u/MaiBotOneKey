export function localChatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("localChat:connect") ||
    message.includes("无法连接 MaiBot 简单聊聊") ||
    message.includes("连接 MaiBot 简单聊聊超时") ||
    message.includes("ECONNREFUSED") ||
    message.includes("WebSocket")
  ) {
    return "MaiBot Core 正在启动或 WebUI 聊天服务还在加载，请稍等片刻后重试。";
  }
  return message;
}
