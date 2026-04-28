import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import { join } from "node:path";
import { registerAppIpc } from "./ipc/app";
import { registerPtyIpc } from "./ipc/pty";
import { PtySessionManager } from "./pty/pty-session-manager";
import { InitManager } from "./services/init-manager";
import { acquireInstallInstanceLock } from "./services/instance-lock";
import { LogStore } from "./services/log-store";
import { configureRuntimePaths } from "./services/paths";
import { ServiceManager } from "./services/service-manager";

const runtimePaths = configureRuntimePaths();
const instanceLock = acquireInstallInstanceLock(runtimePaths);
const logStore = new LogStore(runtimePaths);
const initManager = new InitManager(runtimePaths);
const serviceManager = new ServiceManager(runtimePaths, initManager, logStore);
const ptySessionManager = new PtySessionManager();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let allowQuit = false;
let quitRequested = false;

function broadcastWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  window.webContents.send("desktop:window-state", {
    isMaximized: window.isMaximized(),
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
    show: false,
    backgroundColor: "#f5f7f2",
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: -100, y: -100 } : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
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
  const icon = nativeImage.createFromDataURL(
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
  const nextTray = new Tray(icon);

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
      { label: "显示 MaiBot OneKey", click: showMainWindow },
      { type: "separator" },
      { label: "启动全部服务", click: withLog(() => serviceManager.startAll()) },
      { label: "停止全部服务", click: withLog(() => serviceManager.stopAll()) },
      { label: "打开日志目录", click: withLog(() => shell.openPath(runtimePaths.logsRoot)) },
      { type: "separator" },
      { label: "全部退出", click: requestQuit },
    ]),
  );
  nextTray.on("double-click", showMainWindow);
  return nextTray;
}

if (!instanceLock.acquired) {
  serviceManager.dispose();
  ptySessionManager.dispose();
  app.quit();
} else {
  app.whenReady().then(() => {
    mainWindow = createMainWindow();
    tray = createTray();

    registerAppIpc({
      paths: runtimePaths,
      initManager,
      serviceManager,
      logStore,
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
    serviceManager.dispose();
    ptySessionManager.dispose();
  });

  app.on("will-quit", () => {
    instanceLock.release();
  });
}
