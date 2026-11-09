import { expect, test } from "bun:test";
import { isMessagePlatformRequest, parseWebuiLayoutMessage } from "../../../src/renderer/src/lib/webui-host-message";

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

test("layout reports are accepted only from the local MaiBot origin with a sane width", () => {
  const core = "http://127.0.0.1:8001/";
  const source = "http://127.0.0.1:8001/logs";
  expect(parseWebuiLayoutMessage("maibot:layout", [{ sidebarWidth: 311.6, collapsed: false }], source, core))
    .toEqual({ sidebarWidth: 312, collapsed: false, homeLocked: false });
  expect(parseWebuiLayoutMessage("maibot:layout", [{ sidebarWidth: 0, collapsed: true, homeLocked: true }], source, core))
    .toEqual({ sidebarWidth: 0, collapsed: true, homeLocked: true });
  expect(parseWebuiLayoutMessage("maibot:layout", [{ sidebarWidth: 300 }], "https://example.com/", core)).toBeNull();
  expect(parseWebuiLayoutMessage("maibot:other", [{ sidebarWidth: 300 }], source, core)).toBeNull();
  for (const payload of [undefined, {}, { sidebarWidth: "300" }, { sidebarWidth: -1 }, { sidebarWidth: 5000 }, { sidebarWidth: Number.NaN }]) {
    expect(parseWebuiLayoutMessage("maibot:layout", [payload], source, core)).toBeNull();
  }
});
