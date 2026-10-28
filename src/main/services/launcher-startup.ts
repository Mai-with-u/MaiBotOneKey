import type { DesktopSnapshot } from "../../shared/contracts";

interface LoginItemApp {
  isPackaged: boolean;
  getLoginItemSettings(options: { path: string }): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean };
  setLoginItemSettings(options: { openAtLogin: boolean; path: string }): void;
}

export function readOpenAtLogin(app: LoginItemApp, platform = process.platform): boolean | undefined {
  if (!app.isPackaged || !["win32", "darwin"].includes(platform)) return undefined;
  const state = app.getLoginItemSettings({ path: process.execPath });
  return state.openAtLogin && state.executableWillLaunchAtLogin !== false;
}

export function saveOpenAtLogin(app: LoginItemApp, enabled: boolean, platform = process.platform): void {
  if (readOpenAtLogin(app, platform) === undefined) {
    if (enabled) throw new Error("登录后自动启动仅支持 Windows 和 macOS 正式安装版");
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  if (readOpenAtLogin(app, platform) !== enabled) throw new Error("系统未应用登录启动设置，请检查系统启动项是否被禁用");
}

type StartupSnapshot = Pick<DesktopSnapshot, "initState" | "startupAgreement" | "services" | "runtimeOperation" | "serviceStartupSettings">;

/** One attempt per launcher session. A manual service operation takes precedence. */
export class LauncherAutoStart {
  private pending: boolean;

  constructor(enabledAtLaunch: boolean, private readonly start: () => Promise<unknown>, private readonly onError: (error: unknown) => void) {
    this.pending = enabledAtLaunch;
  }

  cancel(): void { this.pending = false; }

  consider(snapshot: StartupSnapshot): void {
    if (!this.pending) return;
    if (!snapshot.serviceStartupSettings.autoStartServices || snapshot.services.some((service) =>
      service.managed || ["starting", "running", "stopping"].includes(service.status))) {
      this.cancel();
      return;
    }
    const init = snapshot.initState;
    const configured = init.qqProtocol === "official" ? init.qqOfficialConfigured : init.messagePlatformConfigured;
    if (snapshot.runtimeOperation || !init.isReady || !configured || !snapshot.startupAgreement.isConfirmed) return;
    this.cancel();
    void Promise.resolve().then(this.start).catch(this.onError);
  }
}
