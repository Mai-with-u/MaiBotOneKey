import type { DesktopSnapshot } from "@shared/contracts";

const fallbackSnapshot: DesktopSnapshot = {
  appVersion: "0.1.0",
  platform:
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? "darwin"
      : typeof navigator !== "undefined" && /Win/i.test(navigator.platform)
        ? "win32"
        : "linux",
  windowState: { isMaximized: false, isFullScreen: false, isFocused: true },
  paths: {
    installRoot: "开发预览",
    userDataRoot: "开发预览",
    modulesRoot: "开发预览/modules",
    runtimeRoot: "开发预览/runtime",
    logsRoot: "开发预览/logs",
  },
  services: [
    {
      id: "maibot",
      name: "MaiBot Core",
      port: 8001,
      ports: [8001],
      url: "http://127.0.0.1:8001",
      status: "stopped",
      health: "unknown",
      managed: false,
      desired: false,
      detail: "等待接入 Electron 启动流程",
    },
    {
      id: "napcat",
      name: "NapCat",
      port: 6099,
      ports: [6099],
      url: "http://127.0.0.1:6099/webui",
      status: "stopped",
      health: "unknown",
      managed: false,
      desired: false,
      detail: "等待接入 Electron 启动流程",
    },
  ],
  serviceCommands: [
    {
      serviceId: "maibot",
      serviceName: "MaiBot Core",
      cwd: "开发预览/modules/MaiBot",
      commandLine: "python bot.py",
      defaultCwd: "开发预览/modules/MaiBot",
      defaultCommandLine: "python bot.py",
      customized: false,
    },
    {
      serviceId: "napcat",
      serviceName: "NapCat",
      cwd: "开发预览/modules/napcat",
      commandLine: "NapCatWinBootMain.exe <QQ>",
      defaultCwd: "开发预览/modules/napcat",
      defaultCommandLine: "NapCatWinBootMain.exe <QQ>",
      customized: false,
    },
  ],
  initState: {
    isReady: false,
    checks: [
      {
        id: "preview",
        label: "Electron bridge",
        status: "warning",
        detail: "当前处于浏览器预览模式",
      },
    ],
  },
  recentLogs: [],
};

export async function getDesktopSnapshot(): Promise<DesktopSnapshot> {
  if (!window.maibotDesktop) {
    return fallbackSnapshot;
  }

  try {
    return await window.maibotDesktop.getSnapshot();
  } catch (error) {
    console.error("[desktop] failed to read snapshot", error);
    return {
      ...fallbackSnapshot,
      services: fallbackSnapshot.services.map((service) => ({
        ...service,
        status: "error",
        health: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      })),
      initState: {
        isReady: false,
        checks: [
          {
            id: "desktop-snapshot",
            label: "桌面状态",
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      },
    };
  }
}
