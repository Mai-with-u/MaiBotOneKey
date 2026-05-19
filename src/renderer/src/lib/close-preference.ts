export type ClosePreference = "ask" | "minimize" | "quit";

const CLOSE_PREFERENCE_KEY = "maibot.closePreference";
export const CLOSE_PREFERENCE_CHANGE_EVENT = "maibot-close-preference-change";

export function isClosePreference(value: unknown): value is ClosePreference {
  return value === "ask" || value === "minimize" || value === "quit";
}

export function getClosePreference(): ClosePreference {
  try {
    const value = window.localStorage.getItem(CLOSE_PREFERENCE_KEY);
    return isClosePreference(value) ? value : "ask";
  } catch {
    return "ask";
  }
}

export function setClosePreference(preference: ClosePreference): void {
  try {
    window.localStorage.setItem(CLOSE_PREFERENCE_KEY, preference);
    window.dispatchEvent(new CustomEvent(CLOSE_PREFERENCE_CHANGE_EVENT, { detail: preference }));
  } catch {
    // Ignore storage failures; the current close action can still continue.
  }
}
