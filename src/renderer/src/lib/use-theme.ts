import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "maibot-theme";
const CHANGE_EVENT = "maibot-theme-change";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readStored(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    // ignore
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

function applyClass(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

function persistPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
    window.dispatchEvent(new CustomEvent<ThemePreference>(CHANGE_EVENT, { detail: preference }));
  } catch {
    // ignore
  }
}

export interface ThemeApi {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  cycle: () => void;
  toggle: () => void;
}

export function useTheme(): ThemeApi {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStored());
  const [systemValue, setSystemValue] = useState<ResolvedTheme>(() => systemTheme());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(MEDIA_QUERY);
    const handler = (event: MediaQueryListEvent): void => {
      setSystemValue(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? systemValue : preference;

  useEffect(() => {
    applyClass(resolved);
  }, [resolved]);

  useEffect(() => {
    const listener = (event: Event): void => {
      const next = (event as CustomEvent<ThemePreference>).detail;
      if (next === "light" || next === "dark" || next === "system") {
        setPreferenceState(next);
      }
    };
    window.addEventListener(CHANGE_EVENT, listener);
    return () => window.removeEventListener(CHANGE_EVENT, listener);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    persistPreference(next);
  }, []);

  const cycle = useCallback(() => {
    setPreferenceState((current) => {
      const next: ThemePreference =
        current === "light" ? "dark" : current === "dark" ? "system" : "light";
      persistPreference(next);
      return next;
    });
  }, []);

  const toggle = useCallback(() => {
    setPreferenceState((current) => {
      const currentResolved = resolve(current);
      const next: ThemePreference = currentResolved === "dark" ? "light" : "dark";
      persistPreference(next);
      return next;
    });
  }, []);

  return { preference, resolved, setPreference, cycle, toggle };
}

/** Apply persisted theme synchronously before React paints. Call once at module init. */
export function bootstrapTheme(): void {
  applyClass(resolve(readStored()));
}
