import { useCallback, useEffect, useState } from "react";
import { MAIBOT_THEME_EVENT, readMaiBotTheme, type MaiBotTheme } from "./maibot-theme";

export type AccentColor = "orange" | "green" | "blue" | "pink" | "neutral";
export type AppearanceMode = "future-retro" | "millennium" | "modern";
export type FontFamily = "system" | "rounded" | "serif";
export type InterfaceScale = "normal" | "comfortable";
export type WindowCornerRadii = Record<AppearanceMode, number>;

export interface AppearancePreference {
  followMaiBot: boolean;
  accent: AccentColor;
  font: FontFamily;
  mode: AppearanceMode;
  retroPaperTexture: boolean;
  scale: InterfaceScale;
  windowCornerRadius: number;
  windowCornerRadii: WindowCornerRadii;
}

export interface AppearanceApi extends AppearancePreference {
  setFollowMaiBot: (enabled: boolean) => void;
  setAccent: (accent: AccentColor) => void;
  setFont: (font: FontFamily) => void;
  setMode: (mode: AppearanceMode) => void;
  setRetroPaperTexture: (enabled: boolean) => void;
  setScale: (scale: InterfaceScale) => void;
  setWindowCornerRadius: (radius: number) => void;
  reset: () => void;
}

const STORAGE_KEY = "maibot-appearance";
const CHANGE_EVENT = "maibot-appearance-change";
export const RETRO_WINDOW_CORNER_RADIUS_MIN = 0;
export const WINDOW_CORNER_RADIUS_MIN = 12;
export const WINDOW_CORNER_RADIUS_MAX = 32;

const DEFAULT_APPEARANCE_MODE: AppearanceMode = "millennium";
const DEFAULT_WINDOW_CORNER_RADII: WindowCornerRadii = {
  "future-retro": 16,
  millennium: 0,
  modern: 16,
};

const DEFAULT_APPEARANCE: AppearancePreference = {
  followMaiBot: true,
  accent: "orange",
  font: "system",
  mode: DEFAULT_APPEARANCE_MODE,
  retroPaperTexture: true,
  scale: "comfortable",
  windowCornerRadius: DEFAULT_WINDOW_CORNER_RADII[DEFAULT_APPEARANCE_MODE],
  windowCornerRadii: DEFAULT_WINDOW_CORNER_RADII,
};

const FONT_TOKENS: Record<FontFamily, string> = {
  system: '"Inter Variable", "Inter", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
  rounded: '"Nunito", "Inter Variable", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
  serif: '"Noto Serif SC", "Songti SC", "SimSun", Georgia, serif',
};

const SCALE_TOKENS: Record<AppearanceMode, Record<InterfaceScale, string>> = {
  "future-retro": {
    normal: "15px",
    comfortable: "17px",
  },
  millennium: {
    normal: "15px",
    comfortable: "16px",
  },
  modern: {
    normal: "15px",
    comfortable: "16px",
  },
};

const LEGACY_INLINE_COLOR_TOKENS = [
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--ring",
] as const;

function isAccentColor(value: unknown): value is AccentColor {
  return value === "orange" || value === "green" || value === "blue" || value === "pink" || value === "neutral";
}

function isFontFamily(value: unknown): value is FontFamily {
  return value === "system" || value === "rounded" || value === "serif";
}

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "future-retro" || value === "millennium" || value === "modern";
}

// 千禧风格沿用未来复古的 DOM 结构，只换一套视觉。
export function usesRetroStructure(mode: AppearanceMode): boolean {
  return mode !== "modern";
}

function isInterfaceScale(value: unknown): value is InterfaceScale {
  return value === "normal" || value === "comfortable";
}

function windowCornerRadiusMin(mode: AppearanceMode): number {
  return usesRetroStructure(mode) ? RETRO_WINDOW_CORNER_RADIUS_MIN : WINDOW_CORNER_RADIUS_MIN;
}

function clampWindowCornerRadius(value: unknown, mode: AppearanceMode): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_WINDOW_CORNER_RADII[mode];
  }
  return Math.min(WINDOW_CORNER_RADIUS_MAX, Math.max(windowCornerRadiusMin(mode), Math.round(numeric)));
}

function normalizeWindowCornerRadii(record: Record<string, unknown>): WindowCornerRadii {
  const storedRadii = record.windowCornerRadii && typeof record.windowCornerRadii === "object"
    ? record.windowCornerRadii as Record<string, unknown>
    : {};
  const radiusFor = (mode: AppearanceMode): number =>
    clampWindowCornerRadius(storedRadii[mode] ?? record.windowCornerRadius, mode);

  return {
    "future-retro": radiusFor("future-retro"),
    millennium: radiusFor("millennium"),
    modern: radiusFor("modern"),
  };
}

function normalizeAppearance(value: unknown): AppearancePreference {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mode = isAppearanceMode(record.mode)
    ? record.mode
    : record.mode === "future" || record.liquidGlass === true
      ? "modern"
      : DEFAULT_APPEARANCE.mode;
  const windowCornerRadii = normalizeWindowCornerRadii(record);
  return {
    followMaiBot: typeof record.followMaiBot === "boolean" ? record.followMaiBot : true,
    accent: isAccentColor(record.accent) ? record.accent : DEFAULT_APPEARANCE.accent,
    font: isFontFamily(record.font) ? record.font : DEFAULT_APPEARANCE.font,
    mode,
    retroPaperTexture: typeof record.retroPaperTexture === "boolean"
      ? record.retroPaperTexture
      : DEFAULT_APPEARANCE.retroPaperTexture,
    scale: record.scale === "compact"
      ? "normal"
      : isInterfaceScale(record.scale) ? record.scale : DEFAULT_APPEARANCE.scale,
    windowCornerRadius: windowCornerRadii[mode],
    windowCornerRadii,
  };
}

function readStored(): AppearancePreference {
  if (typeof window === "undefined") {
    return DEFAULT_APPEARANCE;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_APPEARANCE;
    }
    const parsed = JSON.parse(raw);
    return normalizeAppearance(parsed);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function applyAppearance(appearance: AppearancePreference): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const mode = isAppearanceMode(appearance.mode) ? appearance.mode : DEFAULT_APPEARANCE.mode;
  const windowCornerRadius = clampWindowCornerRadius(appearance.windowCornerRadius, mode);
  LEGACY_INLINE_COLOR_TOKENS.forEach((token) => root.style.removeProperty(token));
  root.style.setProperty("--font-sans", FONT_TOKENS[appearance.font]);
  root.style.setProperty("font-size", SCALE_TOKENS[mode][appearance.scale]);
  root.style.setProperty("--app-window-radius", `${windowCornerRadius}px`);
  root.dataset.appearanceMode = mode;
  root.dataset.accent = appearance.accent;
  root.dataset.font = appearance.font;
  root.dataset.retroPaperTexture = appearance.retroPaperTexture ? "true" : "false";
  root.dataset.scale = appearance.scale;
}

function saveAppearance(appearance: AppearancePreference): void {
  applyAppearance(appearance);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    window.dispatchEvent(new CustomEvent<AppearancePreference>(CHANGE_EVENT, { detail: appearance }));
  } catch {
    // ignore
  }
}

export function useAppearance(): AppearanceApi {
  const [appearance, setAppearance] = useState<AppearancePreference>(() => readStored());

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<AppearancePreference>).detail;
      if (detail && typeof detail === "object") {
        setAppearance(normalizeAppearance(detail));
      }
    };
    window.addEventListener(CHANGE_EVENT, listener);
    return () => window.removeEventListener(CHANGE_EVENT, listener);
  }, []);

  useEffect(() => {
    if (!appearance.followMaiBot) return;
    const sync = (theme: MaiBotTheme | undefined): void => {
      if (!theme) return;
      const current = readStored();
      if (current.followMaiBot && current.mode !== theme.mode) {
        saveAppearance(normalizeAppearance({ ...current, mode: theme.mode }));
      }
    };
    sync(readMaiBotTheme());
    const listener = (event: Event): void => sync((event as CustomEvent<MaiBotTheme>).detail);
    window.addEventListener(MAIBOT_THEME_EVENT, listener);
    return () => window.removeEventListener(MAIBOT_THEME_EVENT, listener);
  }, [appearance.followMaiBot, appearance.mode]);

  const update = useCallback((nextValue: Partial<AppearancePreference> | ((current: AppearancePreference) => Partial<AppearancePreference>)) => {
    setAppearance((current) => {
      const partial = typeof nextValue === "function" ? nextValue(current) : nextValue;
      const next = normalizeAppearance({ ...current, ...partial });
      saveAppearance(next);
      return next;
    });
  }, []);

  return {
    ...appearance,
    setAccent: (accent) => update({ accent }),
    setFont: (font) => update({ font }),
    setMode: (mode) => update({ mode, followMaiBot: false }),
    setFollowMaiBot: (followMaiBot) => update({ followMaiBot, ...(followMaiBot && readMaiBotTheme() ? { mode: readMaiBotTheme()!.mode } : {}) }),
    setRetroPaperTexture: (retroPaperTexture) => update({ retroPaperTexture }),
    setScale: (scale) => update({ scale }),
    setWindowCornerRadius: (windowCornerRadius) =>
      update((current) => ({
        windowCornerRadii: {
          ...current.windowCornerRadii,
          [current.mode]: clampWindowCornerRadius(windowCornerRadius, current.mode),
        },
      })),
    reset: () => {
      setAppearance(DEFAULT_APPEARANCE);
      saveAppearance(DEFAULT_APPEARANCE);
    },
  };
}

export function bootstrapAppearance(): void {
  applyAppearance(readStored());
}
