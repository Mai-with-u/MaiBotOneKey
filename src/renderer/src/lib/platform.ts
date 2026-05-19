import { useEffect, useState } from "react";
import { getDesktopSnapshot } from "./desktop-api";

export type Platform = "darwin" | "win32" | "linux";

let cachedPlatform: Platform | null = null;
const subscribers = new Set<(p: Platform) => void>();

function detectPlatformSync(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const ua = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "darwin";
  if (/Win/i.test(ua)) return "win32";
  return "linux";
}

async function resolvePlatform(): Promise<Platform> {
  if (cachedPlatform) return cachedPlatform;

  try {
    const snapshot = await getDesktopSnapshot();
    cachedPlatform = (snapshot.platform as Platform) ?? detectPlatformSync();
  } catch {
    cachedPlatform = detectPlatformSync();
  }

  for (const sub of subscribers) sub(cachedPlatform);
  return cachedPlatform;
}

export function usePlatform(): Platform {
  const [platform, setPlatform] = useState<Platform>(() => cachedPlatform ?? detectPlatformSync());

  useEffect(() => {
    if (cachedPlatform) {
      setPlatform(cachedPlatform);
      return;
    }
    subscribers.add(setPlatform);
    void resolvePlatform();
    return () => {
      subscribers.delete(setPlatform);
    };
  }, []);

  return platform;
}

export interface ShortcutTokens {
  mod: string;
  shift: string;
  alt: string;
  enter: string;
  esc: string;
  backtick: string;
}

export function getShortcutTokens(platform: Platform): ShortcutTokens {
  if (platform === "darwin") {
    return { mod: "⌘", shift: "⇧", alt: "⌥", enter: "↩", esc: "⎋", backtick: "`" };
  }
  return { mod: "Ctrl", shift: "Shift", alt: "Alt", enter: "Enter", esc: "Esc", backtick: "`" };
}

/**
 * Format a logical shortcut spec into platform-aware key tokens.
 * Spec uses `Mod` for ⌘/Ctrl. Example: "Mod+Shift+S".
 */
export function formatShortcut(spec: string, platform: Platform): string[] {
  const t = getShortcutTokens(platform);
  return spec.split("+").map((raw) => {
    const key = raw.trim();
    switch (key.toLowerCase()) {
      case "mod":
      case "cmd":
      case "ctrl":
        return t.mod;
      case "shift":
        return t.shift;
      case "alt":
      case "option":
        return t.alt;
      case "enter":
      case "return":
        return t.enter;
      case "esc":
      case "escape":
        return t.esc;
      case "backtick":
        return t.backtick;
      default:
        return key.length === 1 ? key.toUpperCase() : key;
    }
  });
}
