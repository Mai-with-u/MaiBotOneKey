import type { QqBackend } from "@shared/contracts";

export const MESSAGE_PLATFORM_GUIDE_REQUEST_KEY = "maibot.messagePlatformGuide.requested";
export const MESSAGE_PLATFORM_GUIDE_EVENT = "maibot:open-message-platform-guide";

export function requestMessagePlatformGuide(backend?: QqBackend): void {
  try {
    localStorage.setItem(MESSAGE_PLATFORM_GUIDE_REQUEST_KEY, backend ?? "1");
  } catch {
    // The live event still opens the guide when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(MESSAGE_PLATFORM_GUIDE_EVENT, { detail: backend }));
}
