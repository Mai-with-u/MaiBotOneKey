import { RuntimeOperationLock } from "./services/runtime-operation-lock";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  Tray,
} from "electron";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppIconId } from "../shared/contracts";
import { registerAppIpc } from "./ipc/app";
import { registerPtyIpc } from "./ipc/pty";
import { PtySessionManager } from "./pty/pty-session-manager";
import { InitManager } from "./services/init-manager";
import { acquireInstallInstanceLock } from "./services/instance-lock";
import { AppIconManager } from "./services/app-icon-manager";
import {
  CODEX_PET_ASSET_SCHEME,
  CodexPetManager,
} from "./services/codex-pet-manager";
import {
  cleanupLauncherUpdateDownloads,
  type LauncherUpdateCleanupResult,
} from "./services/launcher-update-cleanup";
import { cleanupMaiBotPrivacyLeakOnce } from "./services/maibot-privacy-cleanup";
import { MaiBotDeploymentManager } from "./services/maibot-deployment-manager";
import { LogStore } from "./services/log-store";
import { LauncherUiSettingsManager } from "./services/launcher-ui-settings-manager";
import { ModuleUpdater } from "./services/module-updater";
import { NetworkProxyManager } from "./services/network-proxy-manager";
import { configureRuntimePaths } from "./services/paths";
import { PythonDependencyManager } from "./services/python-dependency-manager";
import { ResourceLocationManager } from "./services/resource-location-manager";
import { ServiceManager } from "./services/service-manager";
import { SourceSettingsManager } from "./services/source-settings-manager";
import { isWindowVisuallyMaximized } from "./window-state";

let startupLogRoot: string | undefined;
let fatalErrorReported = false;

function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof Error ? error.stack ?? message : message;
  let logResult: string;
  try {
    const root = startupLogRoot ?? join(app.getPath("appData"), "MaiBotOneKeyDesktop", "logs");
    mkdirSync(root, { recursive: true });
    const logPath = join(root, "desktop.log");
    appendFileSync(logPath, `[${new Date().toISOString()}] [system] 启动失败: ${details}\n`);
    logResult = `日志：${logPath}`;
  } catch (logError) {
    logResult = `日志写入失败：${String(logError)}`;
  }
  console.error("MaiBot OneKey 启动失败", details);
  dialog.showErrorBox("MaiBot OneKey 启动失败", `${message}\n\n${logResult}`);
}

// Install before constructing managers so early synchronous failures are visible too.
function handleFatalError(error: unknown): void {
  if (fatalErrorReported) return;
  fatalErrorReported = true;
  try { reportStartupFailure(error); }
  finally { app.exit(1); }
}
process.on("uncaughtException", handleFatalError);
process.on("unhandledRejection", handleFatalError);

const runtimePaths = (() => {
  try {
    return configureRuntimePaths();
  } catch (error) {
    handleFatalError(error);
    throw error;
  }
})();
startupLogRoot = runtimePaths.logsRoot;
// Electron's OS-managed lock is released on crashes and can notify the running window.
if (!app.requestSingleInstanceLock()) {
  reportStartupFailure("MaiBot OneKey 已在运行，已向已有进程发送显示窗口请求。若窗口未出现，请检查系统托盘或任务管理器中的启动器进程。");
  app.exit(0);
}
app.on("second-instance", () => {
  if (app.isReady() && mainWindow) showMainWindow();
});

const instanceLock = (() => {
  try { return acquireInstallInstanceLock(runtimePaths); }
  catch (error) { reportStartupFailure(error); app.exit(1); throw error; }
})();
const runtimeOperationLock = new RuntimeOperationLock();
const resourceLocationManager = new ResourceLocationManager(
  runtimePaths,
  app.isPackaged,
  runtimeOperationLock,
  () => {
    const active = serviceManager.snapshot().filter((service) => service.managed || ["starting", "running", "stopping"].includes(service.status));
    if (active.length) throw new Error(`请先停止所有服务，再操作组件目录：${active.map((service) => service.name).join("、")}`);
  },
);
const resourceLock = (() => {
  try {
    return instanceLock.acquired ? resourceLocationManager.acquireInitialLock() : { acquired: true };
  } catch (error) {
    resourceLocationManager.release();
    instanceLock.release();
    reportStartupFailure(error);
    app.exit(1);
    throw error;
  }
})();
const logStore = new LogStore(runtimePaths);
const initManager = new InitManager(runtimePaths);
const networkProxyManager = new NetworkProxyManager(runtimePaths);
const launcherUiSettingsManager = new LauncherUiSettingsManager(runtimePaths);
const sourceSettingsManager = new SourceSettingsManager(runtimePaths);
const moduleUpdater = new ModuleUpdater(runtimePaths);
const pythonDependencyManager = new PythonDependencyManager(
  runtimePaths,
  sourceSettingsManager,
);
const maiBotDeploymentManager = new MaiBotDeploymentManager(runtimePaths, sourceSettingsManager);
initManager.setDeploymentManager(maiBotDeploymentManager);
moduleUpdater.setDeploymentManager(maiBotDeploymentManager);
const ptySessionManager = new PtySessionManager();
const QQ_COMPONENT_UPGRADE_STATE_FILE = "qq-component-upgrade-state.json";
const serviceManager = new ServiceManager(
  runtimePaths,
  initManager,
  logStore,
  ptySessionManager,
  pythonDependencyManager,
  runtimeOperationLock,
);
const appIconManager = new AppIconManager(runtimePaths, app.isPackaged);
const codexPetManager = new CodexPetManager();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appIpcDisposables: ReturnType<typeof registerAppIpc> | null = null;
let allowQuit = false;
let quitRequested = false;

const APP_ICON_ASSET_SCHEME = "maibot-app-icon";

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_ICON_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: CODEX_PET_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppIconAssetPath(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.protocol !== `${APP_ICON_ASSET_SCHEME}:`) {
    return null;
  }
  return appIconManager.getIconPath(parsed.hostname as AppIconId);
}

function registerAppIconResourceProtocol(): void {
  protocol.handle(
    APP_ICON_ASSET_SCHEME,
    async (request: Request): Promise<Response> => {
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
    },
  );
}

function registerCodexPetResourceProtocol(): void {
  protocol.handle(
    CODEX_PET_ASSET_SCHEME,
    async (request: Request): Promise<Response> => {
      const target = await codexPetManager.resolveSpritesheetAsset(request.url);
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
    },
  );
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

function createTrayIcon(): Electron.NativeImage {
  const trayIconPath = app.isPackaged
    ? join(process.resourcesPath, "tray-icon.png")
    : join(runtimePaths.installRoot, "resources", "tray-icon.png");
  const icon = nativeImage.createFromPath(trayIconPath);
  const resized = (icon.isEmpty() ? createAppIcon() : icon).resize({
    width: process.platform === "darwin" ? 18 : 32,
    height: process.platform === "darwin" ? 18 : 32,
    quality: "best",
  });
  if (process.platform === "darwin") {
    resized.setTemplateImage(true);
  }
  return resized;
}

function applyAppIcon(): void {
  const icon = createAppIcon();
  mainWindow?.setIcon(icon);
  tray?.setImage(createTrayIcon());
}

function cleanupLauncherUpdateDownloadsOnStartup(): void {
  void cleanupLauncherUpdateDownloads(runtimePaths)
    .then((result) => {
      if (result.removed.length > 0) {
        logStore.append(
          "desktop",
          "system",
          `已清理启动器更新安装包缓存: ${result.removed.length} 项`,
        );
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
      logStore.append(
        "desktop",
        "system",
        `启动器更新安装包缓存清理失败: ${String(error)}`,
      );
    });
}

async function cleanupMaiBotPrivacyLeakOnStartup(): Promise<void> {
  try {
    const result = await cleanupMaiBotPrivacyLeakOnce(runtimePaths);
    if (result.skipped) {
      return;
    }
    const removedCount =
      result.removedPromptDirs.length +
      result.removedLlmRequestEntries.length +
      result.removedAppLogFiles.length +
      result.removedExtraLogDirs.length;
    logStore.append(
      "desktop",
      "system",
      `已执行冗余日志清理: ${removedCount} 项`,
    );
  } catch (error: unknown) {
    logStore.append("desktop", "system", `清理失败: ${String(error)}`);
  }
}

async function upgradeQqComponentsAfterLauncherUpdate(): Promise<void> {
  const statePath = join(
    runtimePaths.userDataRoot,
    QQ_COMPONENT_UPGRADE_STATE_FILE,
  );
  const currentVersion = app.getVersion();
  const rawState = await readFile(statePath, "utf8").catch(() => undefined);
  let previousVersion: unknown;
  if (rawState) {
    try {
      previousVersion = (JSON.parse(rawState) as { launcherVersion?: unknown })
        .launcherVersion;
    } catch {
      previousVersion = undefined;
    }
  }
  if (previousVersion === currentVersion) {
    return;
  }

  const result = await initManager.upgradeQqComponents();
  await mkdir(runtimePaths.userDataRoot, { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        launcherVersion: currentVersion,
        upgradedAt: Date.now(),
        components: result.components.map((component) => ({
          id: component.id,
          copied: component.copied,
          skipped: component.skipped,
          preservedEntries: component.preservedEntries.length,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const summary = result.components
    .map(
      (component) =>
        `${component.name}${component.skipped ? " skipped" : ` preserved ${component.preservedEntries.length}`}`,
    )
    .join(", ");
  logStore.append(
    "desktop",
    "system",
    `QQ backend components auto-upgraded for ${currentVersion}: ${summary}`,
  );
}

function formatCleanupFailures(
  failed: LauncherUpdateCleanupResult["failed"],
): string {
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
    height: 800,
    minWidth: 1000,
    minHeight: 680,
    resizable: false,
    show: false,
    backgroundColor: "#00000000",
    transparent: true,
    frame: false,
    icon: createAppIcon(),
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition:
      process.platform === "darwin" ? { x: -100, y: -100 } : undefined,
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

  window.webContents.on("did-attach-webview", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // WebUI documentation and other new-tab links use the default browser.
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url).catch((error) => {
          console.error("Failed to open WebUI link in the default browser", error);
        });
      }
      return { action: "deny" };
    });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    if (quitRequested) return;
    reportStartupFailure(`启动器界面进程已退出：${details.reason}（退出码 ${details.exitCode}）。请重新启动启动器。`);
    process.exitCode = 1;
    requestQuit();
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    reportStartupFailure(new Error(`无法加载窗口预加载脚本 ${preloadPath}：${error.message}`));
    process.exitCode = 1;
    requestQuit();
  });

  const onLoadFailure = (error: unknown): void => {
    if (quitRequested) return;
    reportStartupFailure(error);
    process.exitCode = 1;
    requestQuit();
  };
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL).catch(onLoadFailure);
  } else {
    window
      .loadFile(join(__dirname, "../renderer/index.html"))
      .catch(onLoadFailure);
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
  logStore.append(
    "desktop",
    "system",
    "quit requested, shutting down managed services",
  );
  void (async () => {
    try {
      maiBotDeploymentManager.cancel();
      await resourceLocationManager.finishBeforeQuit();
      await serviceManager.shutdownAll();
    } catch (error: unknown) {
      logStore.append(
        "desktop",
        "system",
        `service shutdown failed: ${String(error)}`,
      );
    } finally {
      try {
        const result = await initManager.cleanupMacNapCatQqIntegration();
        if (result.restoredPackage) {
          logStore.append("napcat", "system", "restored QQ package.json during app quit");
        }
        if (result.cleanedRuntime) {
          logStore.append("napcat", "system", "cleaned QQ NapCat runtime files during app quit");
        }
      } catch (error: unknown) {
        logStore.append("napcat", "system", `failed to restore QQ package.json during app quit: ${String(error)}`);
      }
      app.quit();
    }
  })();
}

serviceManager.on("qq-account-setup-required", (backend) => {
  showMainWindow();
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const send = (): void => { if (!window.isDestroyed()) window.webContents.send("desktop:qq-account-setup-required", backend); };
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();
});

function createTray(): Tray {
  const nextTray = new Tray(createTrayIcon());

  const withLog = (action: () => Promise<unknown>) => (): void => {
    void action().catch((error: unknown) => {
      logStore.append("desktop", "system", String(error));
    });
  };

  nextTray.setToolTip("MaiBot OneKey");
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "\u663e\u793a MaiBot OneKey", click: showMainWindow },
      { type: "separator" },
      {
        label: "\u542f\u52a8\u5168\u90e8\u670d\u52a1",
        click: withLog(() => serviceManager.startAll()),
      },
      {
        label: "\u505c\u6b62\u5168\u90e8\u670d\u52a1",
        click: withLog(() => serviceManager.stopAll()),
      },
      {
        label: "\u6253\u5f00\u65e5\u5fd7\u76ee\u5f55",
        click: withLog(() => shell.openPath(runtimePaths.logsRoot)),
      },
      { type: "separator" },
      { label: "\u5173\u95ed\u5e94\u7528", click: requestQuit },
    ]),
  );
  nextTray.on("double-click", showMainWindow);
  return nextTray;
}

if (!instanceLock.acquired || !resourceLock.acquired) {
  const owner = !instanceLock.acquired ? instanceLock.existing : resourceLock.existing;
  const location = !instanceLock.acquired ? instanceLock.lockPath : resourceLock.existing?.path;
  reportStartupFailure(`启动目录被占用或无法清理残留锁文件。\n进程 PID：${owner?.pid ?? "未知"}\n路径：${location ?? runtimePaths.userDataRoot}\n请检查已有启动器进程及目录写入权限。`);
  resourceLocationManager.release();
  instanceLock.release();
  serviceManager.dispose();
  ptySessionManager.dispose();
  app.quit();
} else {
  app.whenReady().then(async () => {
    logStore.append("desktop", "system", `启动 MaiBot OneKey，PID ${process.pid}`);
    cleanupLauncherUpdateDownloadsOnStartup();
    await cleanupMaiBotPrivacyLeakOnStartup();
    await initManager
      .cleanupMacNapCatQqIntegration()
      .then((result) => {
        if (result.restoredPackage) {
          logStore.append("napcat", "system", "restored stale QQ package.json patch on startup");
        }
        if (result.cleanedRuntime) {
          logStore.append("napcat", "system", "cleaned stale QQ NapCat runtime files on startup");
        }
      })
      .catch((error: unknown) => {
        logStore.append("napcat", "system", `failed to restore stale QQ package.json patch on startup: ${String(error)}`);
      });
    registerAppIconResourceProtocol();
    registerCodexPetResourceProtocol();
    await networkProxyManager.applyStoredSettings().catch((error: unknown) => {
      logStore.append(
        "desktop",
        "system",
        `network proxy apply failed: ${String(error)}`,
      );
    });
    await upgradeQqComponentsAfterLauncherUpdate().catch((error: unknown) => {
      logStore.append(
        "desktop",
        "system",
        `QQ backend components auto-upgrade failed: ${String(error)}`,
      );
    });
    mainWindow = createMainWindow();
    tray = createTray();

    appIpcDisposables = registerAppIpc({
      paths: runtimePaths,
      initManager,
      moduleUpdater,
      networkProxyManager,
      launcherUiSettingsManager,
      pythonDependencyManager,
      sourceSettingsManager,
      resourceLocationManager,
      serviceManager,
      logStore,
      appIconManager,
      codexPetManager,
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
  }).catch((error: unknown) => {
    reportStartupFailure(error);
    process.exitCode = 1;
    requestQuit();
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
