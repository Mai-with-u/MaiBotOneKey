import type { DesktopSnapshot } from "@shared/contracts";

const fallbackSnapshot: DesktopSnapshot = {
  appVersion: "0.1.0",
  moduleVersions: {},
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
    defaultResourceRoot: "开发预览",
    resourceRoot: "开发预览",
    modulesRoot: "开发预览/modules",
    defaultMaibotRoot: "开发预览/modules/MaiBot",
    maibotRoot: "开发预览/modules/MaiBot",
    defaultNapcatRoot: "开发预览/modules/napcat",
    napcatRoot: "开发预览/modules/napcat",
    bundledModulesRoot: "开发预览/modules",
    runtimeRoot: "开发预览/runtime",
    defaultPythonOverridesRoot: "开发预览/python-overrides",
    pythonOverridesRoot: "开发预览/python-overrides",
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
  runtimePathConfigs: [
    {
      key: "python",
      label: "Python",
      kind: "file",
      value: "开发预览/runtime/python/python.exe",
      defaultValue: "开发预览/runtime/python/python.exe",
      customized: false,
    },
    {
      key: "git",
      label: "Git",
      kind: "file",
      value: "开发预览/runtime/git/bin/git.exe",
      defaultValue: "开发预览/runtime/git/bin/git.exe",
      customized: false,
    },
  ],
  runtimeResourcePathConfigs: [
    {
      key: "maibot",
      label: "MaiBot路径",
      value: "开发预览/modules/MaiBot",
      defaultValue: "开发预览/modules/MaiBot",
      customized: false,
    },
    {
      key: "napcat",
      label: "NapCat路径",
      value: "开发预览/modules/napcat",
      defaultValue: "开发预览/modules/napcat",
      customized: false,
    },
    {
      key: "pythonOverrides",
      label: "python可写环境",
      value: "开发预览/python-overrides",
      defaultValue: "开发预览/python-overrides",
      customized: false,
    },
  ],
  terminalSettings: {
    useEmbeddedTerminal: true,
  },
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
  startupAgreement: {
    isConfirmed: true,
    documents: [],
  },
  recentLogs: [],
};

export function normalizeDesktopSnapshot(snapshot: Partial<DesktopSnapshot>): DesktopSnapshot {
  return {
    ...fallbackSnapshot,
    ...snapshot,
    paths: {
      ...fallbackSnapshot.paths,
      ...snapshot.paths,
    },
    windowState: {
      ...fallbackSnapshot.windowState,
      ...snapshot.windowState,
    },
    initState: {
      ...fallbackSnapshot.initState,
      ...snapshot.initState,
      checks: snapshot.initState?.checks ?? fallbackSnapshot.initState.checks,
    },
    startupAgreement: snapshot.startupAgreement ?? fallbackSnapshot.startupAgreement,
    services: snapshot.services ?? fallbackSnapshot.services,
    serviceCommands: snapshot.serviceCommands ?? fallbackSnapshot.serviceCommands,
    runtimePathConfigs: snapshot.runtimePathConfigs ?? fallbackSnapshot.runtimePathConfigs,
    runtimeResourcePathConfigs: snapshot.runtimeResourcePathConfigs ?? fallbackSnapshot.runtimeResourcePathConfigs,
    terminalSettings: snapshot.terminalSettings ?? fallbackSnapshot.terminalSettings,
    moduleVersions: {
      ...fallbackSnapshot.moduleVersions,
      ...snapshot.moduleVersions,
    },
    recentLogs: snapshot.recentLogs ?? fallbackSnapshot.recentLogs,
  };
}

export async function getDesktopSnapshot(): Promise<DesktopSnapshot> {
  if (!window.maibotDesktop) {
    return fallbackSnapshot;
  }

  try {
    return normalizeDesktopSnapshot(await window.maibotDesktop.getSnapshot());
  } catch (error) {
    console.error("[desktop] failed to read snapshot", error);
    return normalizeDesktopSnapshot({
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
    });
  }
}
