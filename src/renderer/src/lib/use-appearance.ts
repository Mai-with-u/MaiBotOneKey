import { useCallback, useEffect, useState } from "react";

export type AccentColor = "orange" | "green" | "blue" | "pink" | "neutral";
export type AppearanceMode = "future-retro" | "modern" | "future";
export type FontFamily = "system" | "rounded" | "serif";
export type InterfaceScale = "compact" | "normal" | "comfortable";

export interface AppearancePreference {
  accent: AccentColor;
  font: FontFamily;
  liquidGlass: boolean;
  liquidGlassTransparency: number;
  mode: AppearanceMode;
  retroPaperTexture: boolean;
  scale: InterfaceScale;
  windowCornerRadius: number;
}

export interface AppearanceApi extends AppearancePreference {
  setAccent: (accent: AccentColor) => void;
  setFont: (font: FontFamily) => void;
  setLiquidGlass: (enabled: boolean) => void;
  setLiquidGlassTransparency: (transparency: number) => void;
  setMode: (mode: AppearanceMode) => void;
  setRetroPaperTexture: (enabled: boolean) => void;
  setScale: (scale: InterfaceScale) => void;
  setWindowCornerRadius: (radius: number) => void;
  reset: () => void;
}

const STORAGE_KEY = "maibot-appearance";
const CHANGE_EVENT = "maibot-appearance-change";
export const LIQUID_GLASS_TRANSPARENCY_MIN = 20;
export const LIQUID_GLASS_TRANSPARENCY_MAX = 98;
export const WINDOW_CORNER_RADIUS_MIN = 12;
export const WINDOW_CORNER_RADIUS_MAX = 32;

const DEFAULT_APPEARANCE: AppearancePreference = {
  accent: "orange",
  font: "system",
  liquidGlass: false,
  liquidGlassTransparency: 62,
  mode: "future-retro",
  retroPaperTexture: true,
  scale: "normal",
  windowCornerRadius: 16,
};

const FONT_TOKENS: Record<FontFamily, string> = {
  system: '"Inter Variable", "Inter", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
  rounded: '"Nunito", "Inter Variable", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
  serif: '"Noto Serif SC", "Songti SC", "SimSun", Georgia, serif',
};

const SCALE_TOKENS: Record<InterfaceScale, string> = {
  compact: "14px",
  normal: "15px",
  comfortable: "16px",
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
  return value === "future-retro" || value === "modern" || value === "future";
}

function isInterfaceScale(value: unknown): value is InterfaceScale {
  return value === "compact" || value === "normal" || value === "comfortable";
}

function clampLiquidGlassTransparency(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_APPEARANCE.liquidGlassTransparency;
  }
  return Math.min(
    LIQUID_GLASS_TRANSPARENCY_MAX,
    Math.max(LIQUID_GLASS_TRANSPARENCY_MIN, Math.round(numeric)),
  );
}

function clampWindowCornerRadius(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_APPEARANCE.windowCornerRadius;
  }
  return Math.min(WINDOW_CORNER_RADIUS_MAX, Math.max(WINDOW_CORNER_RADIUS_MIN, Math.round(numeric)));
}

function normalizeAppearance(value: unknown): AppearancePreference {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mode = isAppearanceMode(record.mode)
    ? record.mode
    : record.liquidGlass === true
      ? "future"
      : DEFAULT_APPEARANCE.mode;
  return {
    accent: isAccentColor(record.accent) ? record.accent : DEFAULT_APPEARANCE.accent,
    font: isFontFamily(record.font) ? record.font : DEFAULT_APPEARANCE.font,
    liquidGlass: mode === "future",
    liquidGlassTransparency: clampLiquidGlassTransparency(record.liquidGlassTransparency),
    mode,
    retroPaperTexture: typeof record.retroPaperTexture === "boolean"
      ? record.retroPaperTexture
      : DEFAULT_APPEARANCE.retroPaperTexture,
    scale: isInterfaceScale(record.scale) ? record.scale : DEFAULT_APPEARANCE.scale,
    windowCornerRadius: clampWindowCornerRadius(record.windowCornerRadius),
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
  const liquidGlass = mode === "future";
  const liquidGlassTransparency = clampLiquidGlassTransparency(appearance.liquidGlassTransparency);
  const windowCornerRadius = clampWindowCornerRadius(appearance.windowCornerRadius);
  const transparency = liquidGlassTransparency / 100;
  const surfaceCover = 1 - transparency;
  const glassCover = Math.min(1, surfaceCover + 0.34);
  const frostBlur = Math.round(10 + transparency * 8);
  LEGACY_INLINE_COLOR_TOKENS.forEach((token) => root.style.removeProperty(token));
  root.style.setProperty("--font-sans", FONT_TOKENS[appearance.font]);
  root.style.setProperty("font-size", SCALE_TOKENS[appearance.scale]);
  root.style.setProperty("--app-window-radius", `${windowCornerRadius}px`);
  root.style.setProperty("--liquid-glass-transparency", transparency.toFixed(2));
  root.style.setProperty("--liquid-glass-bg-alpha", (0.2 + glassCover * 0.38).toFixed(3));
  root.style.setProperty("--liquid-glass-card-alpha", (0.11 + glassCover * 0.28).toFixed(3));
  root.style.setProperty("--liquid-glass-popover-alpha", (0.13 + glassCover * 0.32).toFixed(3));
  root.style.setProperty("--liquid-glass-secondary-alpha", (0.09 + glassCover * 0.23).toFixed(3));
  root.style.setProperty("--liquid-glass-muted-alpha", (0.08 + glassCover * 0.19).toFixed(3));
  root.style.setProperty("--liquid-glass-dark-bg-alpha", (0.18 + glassCover * 0.4).toFixed(3));
  root.style.setProperty("--liquid-glass-dark-card-alpha", (0.09 + glassCover * 0.24).toFixed(3));
  root.style.setProperty("--liquid-glass-dark-popover-alpha", (0.12 + glassCover * 0.28).toFixed(3));
  root.style.setProperty("--liquid-glass-dark-secondary-alpha", (0.08 + glassCover * 0.2).toFixed(3));
  root.style.setProperty("--liquid-glass-dark-muted-alpha", (0.07 + glassCover * 0.16).toFixed(3));
  root.style.setProperty("--liquid-glass-chrome-alpha", (0.15 + glassCover * 0.24).toFixed(3));
  root.style.setProperty("--liquid-glass-dark-chrome-alpha", (0.12 + glassCover * 0.2).toFixed(3));
  root.style.setProperty("--liquid-glass-edge-alpha", (0.11 + glassCover * 0.22).toFixed(3));
  root.style.setProperty("--liquid-glass-dark-edge-alpha", (0.09 + glassCover * 0.17).toFixed(3));
  root.style.setProperty("--liquid-glass-blur", `${Math.round(18 + glassCover * 30)}px`);
  root.style.setProperty("--liquid-glass-window-frost", `${frostBlur}px`);
  root.style.setProperty("--liquid-glass-saturate", (1.22 + glassCover * 0.55).toFixed(2));
  root.style.setProperty("--liquid-glass-frost-alpha", (0.2 + surfaceCover * 0.18).toFixed(3));
  root.style.setProperty("--liquid-glass-dark-frost-alpha", (0.16 + surfaceCover * 0.16).toFixed(3));
  root.style.setProperty("--liquid-glass-layer-alpha", (0.24 + glassCover * 0.18).toFixed(3));
  root.style.setProperty("--liquid-glass-compositor-opacity", Math.min(1, 0.84 + glassCover * 0.16).toFixed(3));
  root.classList.toggle("liquid-glass", liquidGlass);
  root.dataset.appearanceMode = mode;
  root.dataset.accent = appearance.accent;
  root.dataset.font = appearance.font;
  root.dataset.liquidGlass = liquidGlass ? "true" : "false";
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

  const update = useCallback((partial: Partial<AppearancePreference>) => {
    setAppearance((current) => {
      const next = normalizeAppearance({ ...current, ...partial });
      saveAppearance(next);
      return next;
    });
  }, []);

  return {
    ...appearance,
    setAccent: (accent) => update({ accent }),
    setFont: (font) => update({ font }),
    setLiquidGlass: (liquidGlass) => update({ mode: liquidGlass ? "future" : "modern" }),
    setLiquidGlassTransparency: (liquidGlassTransparency) =>
      update({ liquidGlassTransparency: clampLiquidGlassTransparency(liquidGlassTransparency) }),
    setMode: (mode) => update({ mode }),
    setRetroPaperTexture: (retroPaperTexture) => update({ retroPaperTexture }),
    setScale: (scale) => update({ scale }),
    setWindowCornerRadius: (windowCornerRadius) =>
      update({ windowCornerRadius: clampWindowCornerRadius(windowCornerRadius) }),
    reset: () => {
      setAppearance(DEFAULT_APPEARANCE);
      saveAppearance(DEFAULT_APPEARANCE);
    },
  };
}

export function bootstrapAppearance(): void {
  applyAppearance(readStored());
}
