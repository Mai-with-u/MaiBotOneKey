export const RESOURCE_PATH_CANCELLED_MESSAGE = "路径操作已取消，原目录和路径设置保持不变。";

export function isResourcePathCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.endsWith(RESOURCE_PATH_CANCELLED_MESSAGE);
}
