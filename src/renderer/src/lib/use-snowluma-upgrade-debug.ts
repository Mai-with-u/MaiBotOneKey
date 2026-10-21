import { useSyncExternalStore } from "react";

const key = "maibot-debug-force-snowluma-upgrade";
const changeEvent = "maibot-debug-settings-change";
function subscribe(listener: () => void): () => void {
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", listener);
  };
}
function read(): boolean {
  return window.localStorage.getItem(key) === "true";
}
function set(enabled: boolean): void {
  if (enabled) window.localStorage.setItem(key, "true");
  else window.localStorage.removeItem(key);
  window.dispatchEvent(new Event(changeEvent));
}
export function useSnowLumaUpgradeDebug(): readonly [boolean, (enabled: boolean) => void] {
  return [useSyncExternalStore(subscribe, read, () => false), set];
}
