import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "maibot-sidebar-collapsed";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export interface SidebarApi {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggle: () => void;
}

export function useSidebar(): SidebarApi {
  const [collapsed, setCollapsedState] = useState<boolean>(() => read());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [collapsed]);

  const setCollapsed = useCallback((next: boolean) => setCollapsedState(next), []);
  const toggle = useCallback(() => setCollapsedState((current) => !current), []);

  return { collapsed, setCollapsed, toggle };
}
