export type Platform = "darwin" | "win32" | "linux";

export function getPlatform(): Platform {
  const platform = window.maibotDesktop?.platform;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  const ua = navigator.platform + " " + navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "darwin";
  if (/Win/i.test(ua)) return "win32";
  return "linux";
}

export function usePlatform(): Platform {
  return getPlatform();
}
