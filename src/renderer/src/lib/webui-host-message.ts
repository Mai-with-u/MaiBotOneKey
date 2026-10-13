export function isMessagePlatformRequest(channel: string, sourceUrl: string | undefined, coreUrl: string): boolean {
  if (channel !== "maibot:open-message-platform" || !sourceUrl) return false;
  try {
    const source = new URL(sourceUrl);
    const core = new URL(coreUrl);
    return core.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(core.hostname)
      && source.origin === core.origin;
  } catch { return false; }
}
