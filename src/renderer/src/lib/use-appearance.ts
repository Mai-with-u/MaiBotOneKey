import { useCallback, useEffect, useState } from "react";

export type AccentColor = "orange" | "green" | "blue" | "pink" | "neutral";
export type FontFamily = "system" | "rounded" | "serif";
export type InterfaceScale = "compact" | "normal" | "comfortable";

export interface AppearancePreference {
  accent: AccentColor;
  font: FontFamily;
  scale: InterfaceScale;
}

export interface AppearanceApi extends AppearancePreference {
  setAccent: (accent: AccentColor) => void;
  setFont: (font: FontFamily) => void;
  setScale: (scale: InterfaceScale) => void;
  reset: () => void;
}

const STORAGE_KEY = "maibot-appearance";
const CHANGE_EVENT = "maibot-appearance-change";

const DEFAULT_APPEARANCE: AppearancePreference = {
  accent: "orange",
  font: "system",
  scale: "normal",
};

const ACCENT_TOKENS: Record<AccentColor, { primary: string; primaryForeground: string; accent: string; accentForeground: string; ring: string }> = {
  orange: {
    primary: "oklch(0.71 0.175 52)",
    primaryForeground: "oklch(0.99 0.008 80)",
    accent: "oklch(0.962 0.02 70)",
    accentForeground: "oklch(0.32 0.06 50)",
    ring: "oklch(0.71 0.175 52 / 0.55)",
  },
  green: {
    primary: "oklch(0.62 0.145 150)",
    primaryForeground: "oklch(0.99 0.01 150)",
    accent: "oklch(0.952 0.024 150)",
    accentForeground: "oklch(0.25 0.07 150)",
    ring: "oklch(0.62 0.145 150 / 0.55)",
  },
  blue: {
    primary: "oklch(0.62 0.145 250)",
    primaryForeground: "oklch(0.99 0.01 250)",
    accent: "oklch(0.952 0.02 250)",
    accentForeground: "oklch(0.25 0.07 250)",
    ring: "oklch(0.62 0.145 250 / 0.55)",
  },
  pink: {
    primary: "oklch(0.66 0.17 18)",
    primaryForeground: "oklch(0.99 0.008 18)",
    accent: "oklch(0.956 0.025 18)",
    accentForeground: "oklch(0.3 0.07 18)",
    ring: "oklch(0.66 0.17 18 / 0.55)",
  },
  neutral: {
    primary: "oklch(0.5 0.02 70)",
    primaryForeground: "oklch(0.99 0.005 80)",
    accent: "oklch(0.95 0.004 75)",
    accentForeground: "oklch(0.24 0.018 55)",
    ring: "oklch(0.5 0.02 70 / 0.45)",
  },
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

function isAppearancePreference(value: unknown): value is AppearancePreference {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return (
    (record.accent === "orange" || record.accent === "green" || record.accent === "blue" || record.accent === "pink" || record.accent === "neutral") &&
    (record.font === "system" || record.font === "rounded" || record.font === "serif") &&
    (record.scale === "compact" || record.scale === "normal" || record.scale === "comfortable")
  );
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
    return isAppearancePreference(parsed) ? parsed : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function applyAppearance(appearance: AppearancePreference): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const accent = ACCENT_TOKENS[appearance.accent];
  root.style.setProperty("--primary", accent.primary);
  root.style.setProperty("--primary-foreground", accent.primaryForeground);
  root.style.setProperty("--accent", accent.accent);
  root.style.setProperty("--accent-foreground", accent.accentForeground);
  root.style.setProperty("--ring", accent.ring);
  root.style.setProperty("--font-sans", FONT_TOKENS[appearance.font]);
  root.style.setProperty("font-size", SCALE_TOKENS[appearance.scale]);
  root.dataset.accent = appearance.accent;
  root.dataset.font = appearance.font;
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
      if (isAppearancePreference(detail)) {
        setAppearance(detail);
      }
    };
    window.addEventListener(CHANGE_EVENT, listener);
    return () => window.removeEventListener(CHANGE_EVENT, listener);
  }, []);

  const update = useCallback((partial: Partial<AppearancePreference>) => {
    setAppearance((current) => {
      const next = { ...current, ...partial };
      saveAppearance(next);
      return next;
    });
  }, []);

  return {
    ...appearance,
    setAccent: (accent) => update({ accent }),
    setFont: (font) => update({ font }),
    setScale: (scale) => update({ scale }),
    reset: () => {
      setAppearance(DEFAULT_APPEARANCE);
      saveAppearance(DEFAULT_APPEARANCE);
    },
  };
}

export function bootstrapAppearance(): void {
  applyAppearance(readStored());
}
