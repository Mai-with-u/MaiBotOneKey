function isTrustedWebuiSource(sourceUrl: string | undefined, coreUrl: string): boolean {
  if (!sourceUrl) return false;
  try {
    const source = new URL(sourceUrl);
    const core = new URL(coreUrl);
    return core.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(core.hostname)
      && source.origin === core.origin;
  } catch { return false; }
}

export function isMessagePlatformRequest(channel: string, sourceUrl: string | undefined, coreUrl: string): boolean {
  return channel === "maibot:open-message-platform" && isTrustedWebuiSource(sourceUrl, coreUrl);
}

/** WebUI 侧栏的实际宽度；sidebarWidth 为 0 表示当前页面没有侧栏。 */
export interface WebuiLayout {
  sidebarWidth: number;
  collapsed: boolean;
  /** A tutorial or first-run trial is running; the title bar must not jump to the home page. */
  homeLocked: boolean;
}

const MAX_SIDEBAR_WIDTH = 640;

export function parseWebuiLayoutMessage(
  channel: string,
  args: unknown[] | undefined,
  sourceUrl: string | undefined,
  coreUrl: string,
): WebuiLayout | null {
  if (channel !== "maibot:layout" || !isTrustedWebuiSource(sourceUrl, coreUrl)) return null;
  const payload = args?.[0] as { sidebarWidth?: unknown; collapsed?: unknown; homeLocked?: unknown } | undefined;
  const width = payload?.sidebarWidth;
  if (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > MAX_SIDEBAR_WIDTH) return null;
  return { sidebarWidth: Math.round(width), collapsed: payload?.collapsed === true, homeLocked: payload?.homeLocked === true };
}
