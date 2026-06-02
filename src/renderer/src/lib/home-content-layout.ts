export type HomeContentCardType =
  | "maibot-overview"
  | "local-chat"
  | "message-platform"
  | "launcher-update"
  | "official-docs"
  | "stats"
  | "quick-actions"
  | "system-performance"
  | "plugin-surprise"
  | "environment-health"
  | "recent-logs"
  | "path-overview"
  | "daily-fortune"
  | "service-heartbeat";

export type HomeContentArea = "main" | "side";
export type HomeContentWidth = "full" | "half";
export type SystemPerformanceMetricKey = "rings" | "cpu" | "cores" | "memory" | "memory-percent" | "uptime" | "load" | "memory-bar";

export interface SystemPerformanceCardSettings {
  visibleMetrics?: SystemPerformanceMetricKey[];
}

export interface PluginSurpriseCardSettings {
  count?: number;
}

export interface HomeContentCardSettingsMap {
  "system-performance": SystemPerformanceCardSettings;
  "plugin-surprise": PluginSurpriseCardSettings;
}

export type HomeContentCardSettings = SystemPerformanceCardSettings | PluginSurpriseCardSettings;

export interface HomeContentEntry {
  id: string;
  type: HomeContentCardType;
  area: HomeContentArea;
  width?: HomeContentWidth;
  settings?: HomeContentCardSettings;
}

export interface HomeContentCardOption {
  type: HomeContentCardType;
  label: string;
  description: string;
}

const STORAGE_KEY = "maibot.homeContentLayout";
export const HOME_CONTENT_LAYOUT_CHANGE_EVENT = "maibot-home-content-layout-change";

export const HOME_CONTENT_CARD_OPTIONS: HomeContentCardOption[] = [
  { type: "maibot-overview", label: "MaiBot Core", description: "显示核心服务状态和 MaiBot 更新入口。" },
  { type: "local-chat", label: "聊聊", description: "首页快速试聊入口。" },
  { type: "message-platform", label: "消息平台", description: "显示 QQ 协议端连接、WebUI 和配置入口。" },
  { type: "launcher-update", label: "一键包信息", description: "显示启动器版本和更新入口。" },
  { type: "official-docs", label: "官方文档", description: "打开 MaiBot 官方文档入口。" },
  { type: "stats", label: "统计信息", description: "显示服务与 MaiBot 统计概览。" },
  { type: "quick-actions", label: "快捷操作", description: "路径、数据库和配置导入等快捷入口。" },
  { type: "system-performance", label: "系统性能", description: "显示 CPU、内存、运行时间等系统状态。" },
  { type: "plugin-surprise", label: "插件惊喜随心推荐", description: "从插件商店随机展示几个推荐插件。" },
  { type: "environment-health", label: "环境检查", description: "汇总基础目录、Python、Git 等检查结果。" },
  { type: "recent-logs", label: "最近日志", description: "显示桌面和服务最近输出，便于快速排查。" },
  { type: "path-overview", label: "路径概览", description: "展示常用运行目录，并可快速打开。" },
  { type: "daily-fortune", label: "今日小签", description: "给今天的启动器抽一条轻量提示。" },
  { type: "service-heartbeat", label: "服务心跳", description: "用小灯阵展示各服务当前状态。" },
];

export const DEFAULT_HOME_CONTENT_LAYOUT: HomeContentEntry[] = [
  { id: "maibot-overview", type: "maibot-overview", area: "main", width: "full" },
  { id: "local-chat", type: "local-chat", area: "main", width: "full" },
  { id: "message-platform", type: "message-platform", area: "main", width: "full" },
  { id: "launcher-update", type: "launcher-update", area: "main", width: "full" },
  { id: "official-docs", type: "official-docs", area: "side", width: "full" },
  { id: "stats", type: "stats", area: "side", width: "full" },
  { id: "quick-actions", type: "quick-actions", area: "side", width: "full" },
];

const KNOWN_TYPES = new Set<HomeContentCardType>(HOME_CONTENT_CARD_OPTIONS.map((option) => option.type));

export function homeContentCardLabel(type: HomeContentCardType): string {
  return HOME_CONTENT_CARD_OPTIONS.find((option) => option.type === type)?.label ?? type;
}

export function createHomeContentEntry(type: HomeContentCardType, area: HomeContentArea = defaultAreaForType(type)): HomeContentEntry {
  return {
    id: `${type}-${Date.now().toString(36)}`,
    type,
    area,
    width: "full",
    settings: defaultSettingsForType(type),
  };
}

export function cloneHomeContentLayout(layout: HomeContentEntry[]): HomeContentEntry[] {
  return layout.map((entry) => ({ ...entry, settings: cloneSettings(entry.settings) }));
}

export function readHomeContentLayout(): HomeContentEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return cloneHomeContentLayout(DEFAULT_HOME_CONTENT_LAYOUT);
    }
    return normalizeHomeContentLayout(JSON.parse(raw));
  } catch {
    return cloneHomeContentLayout(DEFAULT_HOME_CONTENT_LAYOUT);
  }
}

export function saveHomeContentLayout(layout: HomeContentEntry[]): HomeContentEntry[] {
  const next = normalizeHomeContentLayout(layout);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent<HomeContentEntry[]>(HOME_CONTENT_LAYOUT_CHANGE_EVENT, { detail: next }));
  } catch {
    // Ignore storage failures in restricted previews.
  }
  return cloneHomeContentLayout(next);
}

export function resetHomeContentLayout(): HomeContentEntry[] {
  return saveHomeContentLayout(DEFAULT_HOME_CONTENT_LAYOUT);
}

function normalizeHomeContentLayout(value: unknown): HomeContentEntry[] {
  if (!Array.isArray(value)) {
    return cloneHomeContentLayout(DEFAULT_HOME_CONTENT_LAYOUT);
  }

  const entries: HomeContentEntry[] = [];
  const seenTypes = new Set<HomeContentCardType>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const type = (item as { type?: unknown }).type;
    if (typeof type !== "string" || !KNOWN_TYPES.has(type as HomeContentCardType)) {
      continue;
    }
    const cardType = type as HomeContentCardType;
    if (seenTypes.has(cardType)) {
      continue;
    }
    seenTypes.add(cardType);
    const id = (item as { id?: unknown }).id;
    const area = (item as { area?: unknown }).area;
    const width = (item as { width?: unknown }).width;
    const settings = (item as { settings?: unknown }).settings;
    entries.push({
      id: typeof id === "string" && id.trim() ? id.trim() : cardType,
      type: cardType,
      area: area === "side" || area === "main" ? area : defaultAreaForType(cardType),
      width: width === "half" ? "half" : "full",
      settings: normalizeSettingsForType(cardType, settings),
    });
  }

  if (entries.length === 0) {
    return cloneHomeContentLayout(DEFAULT_HOME_CONTENT_LAYOUT);
  }

  if (seenTypes.has("stats")) {
    for (const type of ["official-docs", "quick-actions"] as const) {
      if (!seenTypes.has(type)) {
        entries.push({ id: type, type, area: "side", width: "full" });
      }
    }
  }

  return orderDefaultSideCards(entries);
}

export const DEFAULT_SYSTEM_PERFORMANCE_METRICS: SystemPerformanceMetricKey[] = [
  "rings",
  "cpu",
  "cores",
  "memory",
  "memory-percent",
  "uptime",
  "load",
  "memory-bar",
];

export const DEFAULT_PLUGIN_SURPRISE_COUNT = 3;

function defaultSettingsForType(type: HomeContentCardType): HomeContentEntry["settings"] {
  switch (type) {
    case "system-performance":
      return { visibleMetrics: [...DEFAULT_SYSTEM_PERFORMANCE_METRICS] };
    case "plugin-surprise":
      return { count: DEFAULT_PLUGIN_SURPRISE_COUNT };
    default:
      return undefined;
  }
}

function normalizeSettingsForType(type: HomeContentCardType, value: unknown): HomeContentEntry["settings"] {
  if (!value || typeof value !== "object") {
    return defaultSettingsForType(type);
  }
  switch (type) {
    case "system-performance": {
      const rawMetrics = (value as SystemPerformanceCardSettings).visibleMetrics;
      const visibleMetrics = Array.isArray(rawMetrics)
        ? rawMetrics.filter((metric): metric is SystemPerformanceMetricKey =>
            DEFAULT_SYSTEM_PERFORMANCE_METRICS.includes(metric as SystemPerformanceMetricKey),
          )
        : DEFAULT_SYSTEM_PERFORMANCE_METRICS;
      return {
        visibleMetrics: visibleMetrics.length > 0 ? [...new Set(visibleMetrics)] : [...DEFAULT_SYSTEM_PERFORMANCE_METRICS],
      };
    }
    case "plugin-surprise": {
      const rawCount = Number((value as PluginSurpriseCardSettings).count);
      return {
        count: Number.isFinite(rawCount) ? Math.max(1, Math.min(6, Math.round(rawCount))) : DEFAULT_PLUGIN_SURPRISE_COUNT,
      };
    }
    default:
      return undefined;
  }
}

function cloneSettings(settings: HomeContentEntry["settings"]): HomeContentEntry["settings"] {
  if (!settings) {
    return undefined;
  }
  if ("visibleMetrics" in settings) {
    return { visibleMetrics: settings.visibleMetrics ? [...settings.visibleMetrics] : undefined };
  }
  if ("count" in settings) {
    return { count: settings.count };
  }
  return { ...settings };
}

function defaultAreaForType(type: HomeContentCardType): HomeContentArea {
  return type === "official-docs" || type === "stats" || type === "quick-actions" ? "side" : "main";
}

function orderDefaultSideCards(entries: HomeContentEntry[]): HomeContentEntry[] {
  const defaultOrder = new Map<HomeContentCardType, number>([
    ["official-docs", 0],
    ["stats", 1],
    ["quick-actions", 2],
  ]);
  const sideDefaults = entries
    .filter((entry) => entry.area === "side" && defaultOrder.has(entry.type))
    .sort((left, right) => (defaultOrder.get(left.type) ?? 0) - (defaultOrder.get(right.type) ?? 0));
  if (sideDefaults.length === 0) {
    return entries;
  }

  const withoutSideDefaults = entries.filter((entry) => !(entry.area === "side" && defaultOrder.has(entry.type)));
  const firstSideIndex = withoutSideDefaults.findIndex((entry) => entry.area === "side");
  const insertIndex = firstSideIndex < 0 ? withoutSideDefaults.length : firstSideIndex;
  return [
    ...withoutSideDefaults.slice(0, insertIndex),
    ...sideDefaults,
    ...withoutSideDefaults.slice(insertIndex),
  ];
}
