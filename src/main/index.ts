import { app, BrowserWindow, Menu, nativeImage, net, protocol, session, shell, Tray } from "electron";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppIconId, RuntimePaths } from "../shared/contracts";
import { registerAppIpc } from "./ipc/app";
import { registerPtyIpc } from "./ipc/pty";
import { PtySessionManager } from "./pty/pty-session-manager";
import { InitManager } from "./services/init-manager";
import { acquireInstallInstanceLock } from "./services/instance-lock";
import { AppIconManager } from "./services/app-icon-manager";
import { cleanupLauncherUpdateDownloads, type LauncherUpdateCleanupResult } from "./services/launcher-update-cleanup";
import { LogStore } from "./services/log-store";
import { ModuleUpdater } from "./services/module-updater";
import { NetworkProxyManager } from "./services/network-proxy-manager";
import { OpenCodeSettingsManager } from "./services/opencode-settings-manager";
import { configureRuntimePaths } from "./services/paths";
import { PythonDependencyManager } from "./services/python-dependency-manager";
import { ResourceLocationManager } from "./services/resource-location-manager";
import { ServiceManager } from "./services/service-manager";
import { isWindowVisuallyMaximized } from "./window-state";

const runtimePaths = configureRuntimePaths();
const instanceLock = acquireInstallInstanceLock(runtimePaths);
const resourceLocationManager = new ResourceLocationManager(runtimePaths, app.isPackaged);
const resourceLock = instanceLock.acquired
  ? resourceLocationManager.acquireInitialLock()
  : { acquired: true };
const logStore = new LogStore(runtimePaths);
const initManager = new InitManager(runtimePaths);
const networkProxyManager = new NetworkProxyManager(runtimePaths);
const openCodeSettingsManager = new OpenCodeSettingsManager(runtimePaths);
const moduleUpdater = new ModuleUpdater(runtimePaths, initManager);
const pythonDependencyManager = new PythonDependencyManager(runtimePaths, initManager);
const ptySessionManager = new PtySessionManager();
const serviceManager = new ServiceManager(runtimePaths, initManager, logStore, ptySessionManager, pythonDependencyManager);
const appIconManager = new AppIconManager(runtimePaths, app.isPackaged);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appIpcDisposables: ReturnType<typeof registerAppIpc> | null = null;
let allowQuit = false;
let quitRequested = false;

const LIVE2D_ASSET_SCHEME = "maibot-live2d";
const LIVE2D_WEBVIEW_PARTITION = "maibot-live2d";
const APP_ICON_ASSET_SCHEME = "maibot-app-icon";

protocol.registerSchemesAsPrivileged([
  {
    scheme: LIVE2D_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: APP_ICON_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolveLive2dAssetPath(paths: RuntimePaths, url: string): string | null {
  const parsed = new URL(url);
  if (parsed.protocol !== `${LIVE2D_ASSET_SCHEME}:` || parsed.hostname !== "assets") {
    return null;
  }

  const relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/u, "");
  const target = resolve(paths.live2dRoot, relativePath);
  return isPathInside(paths.live2dRoot, target) ? target : null;
}

function registerLive2dResourceProtocol(paths: RuntimePaths): void {
  const handler = async (request: Request): Promise<Response> => {
    const target = resolveLive2dAssetPath(paths, request.url);
    if (!target) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const fileStat = await stat(target);
      if (!fileStat.isFile()) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };

  protocol.handle(LIVE2D_ASSET_SCHEME, handler);
  session.fromPartition(LIVE2D_WEBVIEW_PARTITION).protocol.handle(LIVE2D_ASSET_SCHEME, handler);
}

function resolveAppIconAssetPath(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.protocol !== `${APP_ICON_ASSET_SCHEME}:`) {
    return null;
  }
  return appIconManager.getIconPath(parsed.hostname as AppIconId);
}

function registerAppIconResourceProtocol(): void {
  protocol.handle(APP_ICON_ASSET_SCHEME, async (request: Request): Promise<Response> => {
    const target = resolveAppIconAssetPath(request.url);
    if (!target) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const fileStat = await stat(target);
      if (!fileStat.isFile()) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function createFallbackIcon(): Electron.NativeImage {
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;utf8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="7" fill="#245B3A"/>
          <path d="M9 20.5V11l7 6 7-6v9.5" fill="none" stroke="#F4FFF6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="11" cy="22" r="1.6" fill="#B7F0C4"/>
          <circle cx="21" cy="22" r="1.6" fill="#B7F0C4"/>
        </svg>`,
      ),
  );
}

function createAppIcon(): Electron.NativeImage {
  const icon = appIconManager.createIcon();
  return icon.isEmpty() ? createFallbackIcon() : icon;
}

function applyAppIcon(): void {
  const icon = createAppIcon();
  mainWindow?.setIcon(icon);
  tray?.setImage(icon.resize({ width: 32, height: 32, quality: "best" }));
}

function cleanupLauncherUpdateDownloadsOnStartup(): void {
  void cleanupLauncherUpdateDownloads(runtimePaths)
    .then((result) => {
      if (result.removed.length > 0) {
        logStore.append("desktop", "system", `已清理启动器更新安装包缓存: ${result.removed.length} 项`);
      }
      if (result.failed.length > 0) {
        logStore.append(
          "desktop",
          "system",
          `启动器更新安装包缓存有 ${result.failed.length} 项暂时无法清理: ${formatCleanupFailures(result.failed)}`,
        );
      }
    })
    .catch((error: unknown) => {
      logStore.append("desktop", "system", `启动器更新安装包缓存清理失败: ${String(error)}`);
    });
}

function formatCleanupFailures(failed: LauncherUpdateCleanupResult["failed"]): string {
  const preview = failed
    .slice(0, 3)
    .map((item) => `${item.name} (${item.message})`)
    .join("; ");
  return failed.length > 3 ? `${preview}; ...` : preview;
}

function broadcastWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  window.webContents.send("desktop:window-state", {
    isMaximized: isWindowVisuallyMaximized(window),
    isFullScreen: window.isFullScreen(),
    isFocused: window.isFocused(),
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "MaiBot OneKey",
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    resizable: false,
    show: false,
    backgroundColor: "#00000000",
    transparent: true,
    frame: false,
    icon: createAppIcon(),
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: -100, y: -100 } : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
    broadcastWindowState(window);
  });

  window.on("close", (event) => {
    if (allowQuit) {
      return;
    }

    event.preventDefault();
    window.webContents.send("desktop:close-request");
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.on("maximize", () => broadcastWindowState(window));
  window.on("unmaximize", () => broadcastWindowState(window));
  window.on("enter-full-screen", () => broadcastWindowState(window));
  window.on("leave-full-screen", () => broadcastWindowState(window));
  window.on("focus", () => broadcastWindowState(window));
  window.on("blur", () => broadcastWindowState(window));
  window.on("restore", () => broadcastWindowState(window));

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => undefined);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html")).catch(() => undefined);
  }

  return window;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function requestQuit(): void {
  if (quitRequested) {
    return;
  }

  quitRequested = true;
  allowQuit = true;
  logStore.append("desktop", "system", "quit requested, shutting down managed services");
  void serviceManager
    .shutdownAll()
    .catch((error: unknown) => {
      logStore.append("desktop", "system", `service shutdown failed: ${String(error)}`);
    })
    .finally(() => {
      app.quit();
    });
}

function createTray(): Tray {
  const nextTray = new Tray(createAppIcon().resize({ width: 32, height: 32 }));

  const withLog =
    (action: () => Promise<unknown>) =>
    (): void => {
      void action().catch((error: unknown) => {
        logStore.append("desktop", "system", String(error));
      });
    };

  nextTray.setToolTip("MaiBot OneKey");
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "\u663e\u793a MaiBot OneKey", click: showMainWindow },
      { type: "separator" },
      { label: "\u542f\u52a8\u5168\u90e8\u670d\u52a1", click: withLog(() => serviceManager.startAll()) },
      { label: "\u505c\u6b62\u5168\u90e8\u670d\u52a1", click: withLog(() => serviceManager.stopAll()) },
      { label: "\u6253\u5f00\u65e5\u5fd7\u76ee\u5f55", click: withLog(() => shell.openPath(runtimePaths.logsRoot)) },
      { type: "separator" },
      { label: "\u5173\u95ed\u5e94\u7528", click: requestQuit },
    ]),
  );
  nextTray.on("double-click", showMainWindow);
  return nextTray;
}

if (!instanceLock.acquired || !resourceLock.acquired) {
  if (!resourceLock.acquired) {
    logStore.append(
      "desktop",
      "system",
      `runtime resource path is locked by pid ${resourceLock.existing?.pid ?? "unknown"}`,
    );
  }
  resourceLocationManager.release();
  serviceManager.dispose();
  ptySessionManager.dispose();
  app.quit();
} else {
  app.whenReady().then(async () => {
    cleanupLauncherUpdateDownloadsOnStartup();
    registerLive2dResourceProtocol(runtimePaths);
    registerAppIconResourceProtocol();
    await networkProxyManager.applyStoredSettings().catch((error: unknown) => {
      logStore.append("desktop", "system", `network proxy apply failed: ${String(error)}`);
    });
    mainWindow = createMainWindow();
    tray = createTray();

    appIpcDisposables = registerAppIpc({
      paths: runtimePaths,
      initManager,
      moduleUpdater,
      networkProxyManager,
      openCodeSettingsManager,
      pythonDependencyManager,
      resourceLocationManager,
      serviceManager,
      logStore,
      appIconManager,
      applyAppIcon,
      getMainWindow: () => mainWindow,
      requestQuit,
      showMainWindow,
    });
    registerPtyIpc({
      manager: ptySessionManager,
      getMainWindow: () => mainWindow,
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      } else {
        showMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    requestQuit();
  });

  app.on("before-quit", (event) => {
    if (!quitRequested) {
      event.preventDefault();
      requestQuit();
      return;
    }

    allowQuit = true;
    tray?.destroy();
    appIpcDisposables?.dispose();
    serviceManager.dispose();
    ptySessionManager.dispose();
  });

  app.on("will-quit", () => {
    resourceLocationManager.release();
    instanceLock.release();
  });
}
