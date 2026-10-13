import { expect, test } from "bun:test";
import { isMessagePlatformRequest } from "../../src/renderer/src/lib/webui-host-message";

test("only the active local MaiBot origin can request message platform navigation", () => {
  const channel = "maibot:open-message-platform";
  const core = "http://127.0.0.1:8001/auth?token=unused";
  expect(isMessagePlatformRequest(channel, "http://127.0.0.1:8001/chat?setupTrial=true", core)).toBe(true);
  for (const source of [undefined, "invalid", "http://127.0.0.1:6099/", "http://localhost:8001/chat", "https://example.com/chat"]) {
    expect(isMessagePlatformRequest(channel, source, core)).toBe(false);
  }
  expect(isMessagePlatformRequest("protocols:stop", "http://127.0.0.1:8001/chat", core)).toBe(false);
  expect(isMessagePlatformRequest(channel, "https://example.com/chat", "https://example.com")).toBe(false);
});
