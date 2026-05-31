import { AlertTriangle, BarChart3, Bot, Cloud, Database, Download, ExternalLink, Gamepad2, Image as ImageIcon, Info, Link, Loader2, MessageSquare, Package, Plug, Plus, Puzzle, RefreshCw, Save, ScrollText, Search, Settings, Shield, Sparkles, Star, Store, ThumbsDown, ThumbsUp, Trash2, Upload, Wrench, X, type LucideIcon } from "lucide-react";
import type { MaiBotPluginDisplayIcon, MaiBotPluginMarketSource, MaiBotPluginType, ServiceDescriptor } from "@shared/contracts";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchInstalledPlugins,
  fetchMarketPlugins,
  getPluginCompatibilityReason,
  installMaiBotPlugin,
  type InstalledPlugin,
  isNewerPluginVersion,
  isPluginCompatible,
  type MarketPlugin,
  fetchPluginConfig,
  fetchPluginReadme,
  fetchPluginStats,
  fetchPluginUserState,
  fetchPluginUserStates,
  type PluginConfigState,
  type PluginConfigValue,
  type PluginStats,
  type PluginUserState,
  dislikePlugin,
  pluginAuthor,
  pluginDescription,
  pluginHomepageUrl,
  likePlugin,
  pluginName,
  pluginNeedsUpdate,
  pluginRepositoryUrl,
  pluginVersion,
  ratePlugin,
  recordPluginDownload,
  savePluginConfig,
  uninstallMaiBotPlugin,
  updateMaiBotPlugin,
} from "@/lib/maibot-plugin-api";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./MarkdownRenderer";

type PluginPanelMode = "market" | "manage";
type LoadState = "idle" | "loading" | "ready" | "error";
type OperationKind = "install" | "update" | "uninstall";
type ConfigBusyState = "load" | "save" | null;
type MarketSortKey = "default" | "downloads" | "likes" | "rating" | "comments";
type PluginTypeFilter = "all" | MaiBotPluginType;

type PendingOperation = {
  kind: OperationKind;
  plugin: MarketPlugin | InstalledPlugin;
  repositoryUrl?: string;
  branch: string;
  incompatibleReason?: string | null;
  latestVersion?: string;
};

type InstalledPluginView = InstalledPlugin & {
  marketPlugin?: MarketPlugin;
  updateAvailable?: boolean;
};

type DetailPlugin = MarketPlugin | InstalledPluginView;
type QuickStatsAction = "like" | "rating" | "user-state";
type QuickStatsBusy = { pluginId: string; action: QuickStatsAction } | null;

type PluginRuntimeState = "disabled" | "failed" | "loaded" | "inactive" | "loading";
type AdapterConfigPage = "connection" | "chat";
const HIDDEN_ADAPTER_CHAT_FIELDS = new Set([
  "enable_chat_list_filter",
  "show_dropped_chat_list_messages",
]);
const SURPRISE_PLUGIN_COUNT = 4;
const SURPRISE_CANDIDATE_LIMIT = 20;
const PLUGIN_MARKET_SOURCE_STORAGE_KEY = "maibot_plugin_market_source";

const MARKET_SOURCE_OPTIONS: Array<{ value: MaiBotPluginMarketSource; label: string }> = [
  { value: "configured", label: "首页更新源" },
  { value: "github", label: "GitHub" },
  { value: "gh-proxy-com", label: "gh-proxy.com" },
  { value: "v6-gh-proxy-org", label: "v6.gh-proxy.org" },
  { value: "cdn-gh-proxy-com", label: "cdn.gh-proxy.com" },
  { value: "gitproxy-mrhjx-cn", label: "gitproxy.mrhjx.cn" },
  { value: "ghproxy-net", label: "ghproxy.net" },
  { value: "ghproxy-vip", label: "ghproxy.vip" },
];
const MARKET_SOURCE_VALUES = new Set<MaiBotPluginMarketSource>(MARKET_SOURCE_OPTIONS.map((option) => option.value));

const PLUGIN_TYPE_LABELS: Record<MaiBotPluginType, string> = {
  adapter: "适配器",
  tool: "工具",
  provider: "服务提供方",
  management: "管理",
  data: "数据",
  media: "媒体",
  game: "游戏娱乐",
  integration: "外部集成",
  extension: "通用扩展",
  other: "其他",
};

const PLUGIN_TYPE_OPTIONS: Array<{ value: MaiBotPluginType; label: string }> = [
  { value: "adapter", label: PLUGIN_TYPE_LABELS.adapter },
  { value: "tool", label: PLUGIN_TYPE_LABELS.tool },
  { value: "provider", label: PLUGIN_TYPE_LABELS.provider },
  { value: "management", label: PLUGIN_TYPE_LABELS.management },
  { value: "data", label: PLUGIN_TYPE_LABELS.data },
  { value: "media", label: PLUGIN_TYPE_LABELS.media },
  { value: "game", label: PLUGIN_TYPE_LABELS.game },
  { value: "integration", label: PLUGIN_TYPE_LABELS.integration },
  { value: "extension", label: PLUGIN_TYPE_LABELS.extension },
  { value: "other", label: PLUGIN_TYPE_LABELS.other },
];
const PLUGIN_TYPE_VALUES = new Set<MaiBotPluginType>(PLUGIN_TYPE_OPTIONS.map((option) => option.value));

const LUCIDE_PLUGIN_ICONS: Record<string, LucideIcon> = {
  "bar-chart-3": BarChart3,
  bar_chart_3: BarChart3,
  bot: Bot,
  cloud: Cloud,
  database: Database,
  gamepad2: Gamepad2,
  "gamepad-2": Gamepad2,
  image: ImageIcon,
  link: Link,
  package: Package,
  plug: Plug,
  puzzle: Puzzle,
  "scroll-text": ScrollText,
  scroll_text: ScrollText,
  settings: Settings,
  shield: Shield,
  wrench: Wrench,
};

const DEFAULT_PLUGIN_TYPE_ICONS: Record<MaiBotPluginType, LucideIcon> = {
  adapter: Plug,
  tool: Wrench,
  provider: Cloud,
  management: Shield,
  data: BarChart3,
  media: ImageIcon,
  game: Gamepad2,
  integration: Link,
  extension: Puzzle,
  other: Package,
};

interface AdapterConfigView {
  kind: "napcat" | "snowluma";
  connectionSectionName: string;
  connectionTitle: string;
  chatTitle: string;
}

interface CardAction {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  iconOnly?: boolean;
  placement?: "top" | "bottom";
  variant?: React.ComponentProps<typeof Button>["variant"];
  onClick: () => void;
}

const PLUGIN_CARD_CONTROL_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  "[role='switch']",
  "[data-plugin-card-control='true']",
].join(",");

function isPluginCardControlTarget(target: EventTarget, currentTarget: HTMLElement): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const control = target.closest(PLUGIN_CARD_CONTROL_SELECTOR);
  return control !== null && control !== currentTarget && currentTarget.contains(control);
}

function readStoredMarketSource(): MaiBotPluginMarketSource {
  try {
    const value = window.localStorage.getItem(PLUGIN_MARKET_SOURCE_STORAGE_KEY);
    return MARKET_SOURCE_VALUES.has(value as MaiBotPluginMarketSource)
      ? value as MaiBotPluginMarketSource
      : "configured";
  } catch {
    return "configured";
  }
}

export function PluginMarketPanel({
  mode,
  onModeChange,
  maibotService,
  maibotVersion,
  retro = false,
  requestedConfigPluginId,
  onRequestedConfigHandled,
}: {
  mode: PluginPanelMode;
  onModeChange?: (mode: PluginPanelMode) => void;
  maibotService?: ServiceDescriptor;
  maibotVersion?: string;
  retro?: boolean;
  requestedConfigPluginId?: string | null;
  onRequestedConfigHandled?: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [preferCompatible, setPreferCompatible] = useState(true);
  const [marketSortBy, setMarketSortBy] = useState<MarketSortKey>("default");
  const [marketSource, setMarketSource] = useState<MaiBotPluginMarketSource>(() => readStoredMarketSource());
  const [pluginTypeFilter, setPluginTypeFilter] = useState<PluginTypeFilter>("all");
  const [marketPlugins, setMarketPlugins] = useState<MarketPlugin[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [pluginStats, setPluginStats] = useState<Record<string, PluginStats>>({});
  const [pluginUserStates, setPluginUserStates] = useState<Record<string, PluginUserState>>({});
  const [quickStatsBusy, setQuickStatsBusy] = useState<QuickStatsBusy>(null);
  const [quickRatingPluginId, setQuickRatingPluginId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<InstalledPlugin | null>(null);
  const [configState, setConfigState] = useState<PluginConfigState | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, PluginConfigValue> | null>(null);
  const [configBusy, setConfigBusy] = useState<ConfigBusyState>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<DetailPlugin | null>(null);
  const [detailRatingPanelOpen, setDetailRatingPanelOpen] = useState(false);
  const [toggleBusyPluginId, setToggleBusyPluginId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const loadPlugins = useCallback(async (forceRefresh = false) => {
    setLoadState("loading");
    setError(null);

    try {
      if (mode === "market") {
        const result = await fetchMarketPlugins(maibotService, { forceRefresh, marketSource });
        setInstalledPlugins(result.installed);
        setMarketPlugins(result.market);
        setPluginStats(result.stats ?? {});
      } else {
        const installed = await fetchInstalledPlugins(maibotService);
        setInstalledPlugins(installed);
        setLoadState("ready");
        void fetchMarketPlugins(maibotService, { forceRefresh, marketSource })
          .then((marketResult) => {
            setMarketPlugins(marketResult.market);
            setPluginStats(marketResult.stats ?? {});
          })
          .catch(() => {
            setMarketPlugins([]);
            setPluginStats({});
          });
        return;
      }
      setLoadState("ready");
    } catch (nextError) {
      setLoadState("error");
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [maibotService, marketSource, mode]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PLUGIN_MARKET_SOURCE_STORAGE_KEY, marketSource);
    } catch {
      // Source selection is still usable for the current session.
    }
  }, [marketSource]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "market" || loadState !== "ready" || marketPlugins.length === 0) {
      return;
    }

    const statsIds = Array.from(new Set(marketPlugins.map((plugin) => pluginStatsPrimaryId(plugin))));
    let cancelled = false;

    const applyUserStates = (userStates: Record<string, PluginUserState>): void => {
      if (cancelled || !mountedRef.current) {
        return;
      }

      setPluginUserStates((current) => {
        let changed = false;
        const next = { ...current };
        for (const statsId of statsIds) {
          const state = userStates[statsId] ?? createEmptyPluginUserState();
          if (!current[statsId] || userStates[statsId]) {
            next[statsId] = state;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    };

    void Promise.resolve()
      .then(() => fetchPluginUserStates())
      .then(applyUserStates)
      .catch((nextError) => {
        console.warn("Failed to fetch plugin user states:", nextError);
      });

    return () => {
      cancelled = true;
    };
  }, [loadState, marketPlugins, mode]);

  const beginOperation = useCallback((operation: PendingOperation) => {
    setPendingOperation(operation);
  }, []);

  const openPluginConfig = useCallback(async (plugin: InstalledPlugin) => {
    setConfigPlugin(plugin);
    setConfigState(null);
    setConfigDraft(null);
    setConfigError(null);
    setConfigBusy("load");
    try {
      const state = await fetchPluginConfig(plugin.id, maibotService);
      setConfigState(state);
      setConfigDraft(clonePluginConfig(state.config));
    } catch (nextError) {
      setConfigError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setConfigBusy(null);
    }
  }, [maibotService]);

  useEffect(() => {
    if (!requestedConfigPluginId || mode !== "manage" || loadState === "idle" || loadState === "loading") {
      return;
    }

    const plugin = installedPlugins.find(
      (item) => item.id === requestedConfigPluginId || item.manifest.id === requestedConfigPluginId,
    );
    if (plugin) {
      void openPluginConfig(plugin);
    } else if (loadState === "ready") {
      toast.error(`未找到已安装插件：${requestedConfigPluginId}`);
    }
    onRequestedConfigHandled?.();
  }, [installedPlugins, loadState, mode, onRequestedConfigHandled, openPluginConfig, requestedConfigPluginId]);

  const saveOpenPluginConfig = useCallback(async () => {
    if (!configPlugin || !configDraft) {
      return false;
    }

    setConfigBusy("save");
    setConfigError(null);
    try {
      const result = await savePluginConfig(configPlugin.id, configDraft, maibotService);
      setConfigState((state) =>
        state
          ? {
              ...state,
              exists: true,
              config: result.config,
              schema: result.schema,
              raw: result.raw,
              configPath: result.configPath,
            }
          : state,
      );
      setConfigDraft(clonePluginConfig(result.config));
      toast.success(`配置已保存：${pluginName(configPlugin)}`);
      await loadPlugins();
      return true;
    } catch (nextError) {
      setConfigError(nextError instanceof Error ? nextError.message : String(nextError));
      return false;
    } finally {
      setConfigBusy(null);
    }
  }, [configDraft, configPlugin, loadPlugins, maibotService]);

  const togglePluginEnabled = useCallback(async (plugin: InstalledPlugin, enabled: boolean) => {
    setToggleBusyPluginId(plugin.id);
    try {
      const state = await fetchPluginConfig(plugin.id, maibotService);
      const nextConfig = setPluginConfigValue(clonePluginConfig(state.config), ["plugin", "enabled"], enabled);
      await savePluginConfig(plugin.id, nextConfig, maibotService);
      toast.success(`${enabled ? "已启用" : "已禁用"}：${pluginName(plugin)}`);
      await loadPlugins();
    } catch (nextError) {
      toast.error(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setToggleBusyPluginId(null);
    }
  }, [loadPlugins, maibotService]);

  const updateConfigDraft = useCallback((path: string[], value: PluginConfigValue) => {
    setConfigDraft((draft) => (draft ? setPluginConfigValue(draft, path, value) : draft));
  }, []);

  const runPendingOperation = useCallback(async () => {
    if (!pendingOperation) {
      return;
    }

    setOperationBusy(true);
    try {
      if (pendingOperation.kind === "install") {
        if (!pendingOperation.repositoryUrl) throw new Error("插件缺少仓库地址，无法安装");
        await installMaiBotPlugin(
          maibotService,
          pendingOperation.plugin.id,
          pendingOperation.repositoryUrl,
          pendingOperation.branch,
        );
        toast.success(`插件已安装：${pluginName(pendingOperation.plugin)}`);
        const statsId = pluginStatsPrimaryId(pendingOperation.plugin);
        void recordPluginDownload(statsId)
          .then((result) => {
            if (result.success && typeof result.downloads === "number") {
              setPluginStats((current) => mergePluginStatsMap(current, statsId, { downloads: result.downloads }));
            }
          })
          .catch((error) => {
            console.warn("Failed to record plugin download:", error);
          });
      } else if (pendingOperation.kind === "update") {
        if (!pendingOperation.repositoryUrl) throw new Error("插件缺少仓库地址，无法更新");
        const installedVersion =
          "installedVersion" in pendingOperation.plugin ? pendingOperation.plugin.installedVersion : undefined;
        if (
          pendingOperation.latestVersion
          && installedVersion
          && !isNewerPluginVersion(pendingOperation.latestVersion, installedVersion)
        ) {
          throw new Error("当前已是最新版本，无需更新");
        }
        const result = await updateMaiBotPlugin(
          maibotService,
          pendingOperation.plugin.id,
          pendingOperation.repositoryUrl,
          pendingOperation.branch,
          pendingOperation.latestVersion,
        );
        toast.success(
          result.old_version && result.new_version
            ? `插件已更新：${result.old_version} -> ${result.new_version}`
            : `插件已更新：${pluginName(pendingOperation.plugin)}`,
        );
      } else {
        await uninstallMaiBotPlugin(maibotService, pendingOperation.plugin.id);
        toast.success(`插件已卸载：${pluginName(pendingOperation.plugin)}`);
      }

      setPendingOperation(null);
      await loadPlugins();
    } catch (nextError) {
      toast.error(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setOperationBusy(false);
    }
  }, [loadPlugins, maibotService, pendingOperation]);

  const updatePluginUserState = useCallback((pluginId: string, partialState: Partial<PluginUserState>) => {
    setPluginUserStates((current) => ({
      ...current,
      [pluginId]: mergePluginUserState(current[pluginId], partialState),
    }));
  }, []);

  const loadPluginUserState = useCallback(async (plugin: { id: string; manifest: MarketPlugin["manifest"] }) => {
    const statsId = pluginStatsPrimaryId(plugin);
    if (pluginUserStates[statsId]) {
      return;
    }

    setQuickStatsBusy({ pluginId: statsId, action: "user-state" });
    try {
      const userState = await fetchPluginUserState(statsId);
      if (userState) {
        updatePluginUserState(statsId, userState);
      }
    } catch {
      // User state is nice to have; the user can still rate or like from the card.
    } finally {
      setQuickStatsBusy((current) =>
        current?.pluginId === statsId && current.action === "user-state" ? null : current,
      );
    }
  }, [pluginUserStates, updatePluginUserState]);

  const handleQuickPluginLike = useCallback(async (plugin: { id: string; manifest: MarketPlugin["manifest"] }) => {
    if (quickStatsBusy) {
      return;
    }

    const statsId = pluginStatsPrimaryId(plugin);
    const stats = resolvePluginStats(plugin, pluginStats);
    setQuickStatsBusy({ pluginId: statsId, action: "like" });
    try {
      const result = await likePlugin(statsId);
      if (!result.success) {
        toast.error(result.error ?? "点赞失败");
        return;
      }

      const userStatePatch: Partial<PluginUserState> = {};
      if (typeof result.liked === "boolean") {
        userStatePatch.liked = result.liked;
      }
      if (typeof result.disliked === "boolean") {
        userStatePatch.disliked = result.disliked;
      }
      updatePluginUserState(statsId, userStatePatch);
      setPluginStats((current) => mergePluginStatsMap(current, statsId, {
        likes: result.likes ?? stats?.likes ?? pluginInlineStat(plugin, "likes") ?? 0,
        dislikes: result.dislikes ?? stats?.dislikes ?? 0,
      }));
      toast.success(result.liked === false ? "已取消点赞" : "已点赞");
    } catch (nextError) {
      toast.error(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setQuickStatsBusy((current) =>
        current?.pluginId === statsId && current.action === "like" ? null : current,
      );
    }
  }, [pluginStats, quickStatsBusy, updatePluginUserState]);

  const handleQuickRatingToggle = useCallback((plugin: { id: string; manifest: MarketPlugin["manifest"] }) => {
    const statsId = pluginStatsPrimaryId(plugin);
    setQuickRatingPluginId((current) => current === statsId ? null : statsId);
    void loadPluginUserState(plugin);
  }, [loadPluginUserState]);

  const openPluginDetail = useCallback((plugin: DetailPlugin) => {
    setQuickRatingPluginId(null);
    setDetailRatingPanelOpen(false);
    setDetailPlugin(plugin);
  }, []);

  const openPluginComment = useCallback((plugin: DetailPlugin) => {
    setQuickRatingPluginId(null);
    setDetailRatingPanelOpen(true);
    setDetailPlugin(plugin);
  }, []);

  const handleQuickPluginRate = useCallback(async (
    plugin: { id: string; manifest: MarketPlugin["manifest"] },
    rating: number,
  ) => {
    if (quickStatsBusy) {
      return;
    }

    const statsId = pluginStatsPrimaryId(plugin);
    const stats = resolvePluginStats(plugin, pluginStats);
    setQuickStatsBusy({ pluginId: statsId, action: "rating" });
    try {
      const result = await ratePlugin(statsId, rating);
      if (!result.success) {
        toast.error(result.error ?? "评分失败");
        return;
      }

      const nextUserRating = result.user_rating ?? rating;
      updatePluginUserState(statsId, { rating: nextUserRating });
      setPluginStats((current) => mergePluginStatsMap(current, statsId, {
        rating: result.rating ?? stats?.rating ?? pluginInlineStat(plugin, "rating") ?? 0,
        rating_count: result.rating_count ?? stats?.rating_count ?? 0,
        comment_count: result.comment_count ?? pluginCommentCount(stats) ?? pluginInlineStat(plugin, "comment_count") ?? 0,
      }));
      setQuickRatingPluginId(null);
      toast.success(`已评分 ${nextUserRating} 星`);
      void fetchPluginStats(statsId).then((nextStats) => {
        if (nextStats) {
          setPluginStats((current) => ({
            ...current,
            [statsId]: nextStats,
          }));
        }
      });
    } catch (nextError) {
      toast.error(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setQuickStatsBusy((current) =>
        current?.pluginId === statsId && current.action === "rating" ? null : current,
      );
    }
  }, [pluginStats, quickStatsBusy, updatePluginUserState]);

  const marketById = useMemo(() => new Map(marketPlugins.map((plugin) => [plugin.id, plugin])), [marketPlugins]);
  const installedViews = useMemo<InstalledPluginView[]>(
    () =>
      installedPlugins.map((plugin) => {
        const marketPlugin = marketById.get(plugin.id);
        return {
          ...plugin,
          marketPlugin,
          updateAvailable: marketPlugin
            ? isNewerPluginVersion(pluginVersion(marketPlugin.manifest), pluginVersion(plugin.manifest))
            : false,
        };
      }),
    [installedPlugins, marketById],
  );
  const filteredMarket = useMemo(
    () => sortMarketPlugins(filterPlugins(marketPlugins, query, pluginTypeFilter), {
      maibotVersion,
      pluginStats,
      preferCompatible,
      sortBy: marketSortBy,
    }),
    [maibotVersion, marketPlugins, marketSortBy, pluginStats, pluginTypeFilter, preferCompatible, query],
  );
  const filteredInstalled = useMemo(
    () => filterPlugins(installedViews, query, pluginTypeFilter),
    [installedViews, pluginTypeFilter, query],
  );
  const isMarket = mode === "market";
  const maibotRunning = maibotService?.status === "running";
  const title = isMarket ? "插件商店" : "插件管理";
  const description = "";

  return (
    <>
      <div className="plugin-market-surface h-full overflow-auto bg-transparent px-5 py-4">
        <div className="plugin-market-layout mx-auto grid max-w-none gap-5">
          <div className="plugin-market-heading flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{title}</h2>
              {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              {onModeChange ? (
                <Tabs
                  className="shrink-0"
                  onValueChange={(value) => onModeChange(value as PluginPanelMode)}
                  value={mode}
                >
                  <TabsList className="plugin-market-mode-tabs h-8 rounded-md bg-muted/40 p-1">
                    <TabsTrigger className="h-6 gap-1.5 px-2.5 text-[11px]" value="market">
                      <Store className="size-3.5" />
                      商店
                    </TabsTrigger>
                    <TabsTrigger className="h-6 gap-1.5 px-2.5 text-[11px]" value="manage">
                      <Puzzle className="size-3.5" />
                      管理
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}
              <Button
                aria-label="刷新"
                disabled={loadState === "loading"}
                onClick={() => void loadPlugins(true)}
                size="icon-sm"
                title="刷新"
                variant="secondary"
              >
                {loadState === "loading" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </div>
          </div>

          <div className="plugin-market-toolbar retro-plugin-search flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card p-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isMarket ? "搜索插件商店" : "搜索已安装插件"}
              value={query}
            />
            <Badge variant="secondary">{isMarket ? filteredMarket.length : filteredInstalled.length}</Badge>
            <select
              className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60"
              onChange={(event) => setPluginTypeFilter(event.target.value as PluginTypeFilter)}
              title="插件类型"
              value={pluginTypeFilter}
            >
              <option value="all">全部类型</option>
              {PLUGIN_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {isMarket ? (
              <select
                className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60"
                onChange={(event) => setMarketSource(event.target.value as MaiBotPluginMarketSource)}
                title="更新源"
                value={marketSource}
              >
                {MARKET_SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    更新源：{option.label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          {isMarket ? (
            <div className="plugin-market-toolbar flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs">
              <label className="flex items-center gap-2 text-muted-foreground">
                <Checkbox
                  checked={preferCompatible}
                  onCheckedChange={(checked) => setPreferCompatible(checked === true)}
                />
                优先显示支持当前 MaiBot 版本的插件
              </label>
              <label className="ml-auto inline-flex items-center gap-2 text-muted-foreground">
                <select
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60"
                  onChange={(event) => setMarketSortBy(event.target.value as MarketSortKey)}
                  value={marketSortBy}
                >
                  <option value="default">推荐排序</option>
                  <option value="downloads">下载最多</option>
                  <option value="likes">点赞最多</option>
                  <option value="rating">评分最高</option>
                  <option value="comments">评论最多</option>
                </select>
              </label>
            </div>
          ) : null}

          {loadState === "error" ? <ErrorPanel error={error} isMarket={isMarket} /> : null}

          {loadState === "loading" && (isMarket ? marketPlugins.length === 0 : installedPlugins.length === 0) ? (
            <div className="plugin-market-loading grid min-h-56 place-items-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                正在读取插件数据
              </span>
            </div>
          ) : isMarket ? (
            <PluginGrid
              maibotVersion={maibotVersion}
              onComment={openPluginComment}
              onDetail={openPluginDetail}
              onOperate={beginOperation}
              onQuickLike={handleQuickPluginLike}
              onQuickRate={handleQuickPluginRate}
              onQuickRatingToggle={handleQuickRatingToggle}
              pluginStats={pluginStats}
              pluginUserStates={pluginUserStates}
              plugins={filteredMarket}
              quickRatingPluginId={quickRatingPluginId}
              quickStatsBusy={quickStatsBusy}
              sortBy={marketSortBy}
            />
          ) : (
            <InstalledGrid
              maibotRunning={maibotRunning}
              maibotVersion={maibotVersion}
              onConfigure={openPluginConfig}
              onDetail={openPluginDetail}
              onOperate={beginOperation}
              onToggleEnabled={togglePluginEnabled}
              pluginStats={pluginStats}
              toggleBusyPluginId={toggleBusyPluginId}
              plugins={filteredInstalled}
            />
          )}
        </div>
      </div>

      <OperationDialog
        busy={operationBusy}
        onConfirm={() => void runPendingOperation()}
        onOpenChange={(open) => {
          if (!open && !operationBusy) setPendingOperation(null);
        }}
        operation={pendingOperation}
        setOperation={setPendingOperation}
      />
      <PluginConfigDialog
        busy={configBusy}
        draft={configDraft}
        error={configError}
        onChange={updateConfigDraft}
        onOpenChange={(open) => {
          if (!open && configBusy === null) {
            setConfigPlugin(null);
            setConfigState(null);
            setConfigDraft(null);
            setConfigError(null);
          }
        }}
        onSave={() => {
          void saveOpenPluginConfig().then((saved) => {
            if (saved) {
              setConfigPlugin(null);
              setConfigState(null);
              setConfigDraft(null);
              setConfigError(null);
            }
          });
        }}
        plugin={configPlugin}
        state={configState}
      />
      <PluginDetailDialog
        initialRatingPanelOpen={detailRatingPanelOpen}
        maibotVersion={maibotVersion}
        onOpenChange={(open) => {
          if (!open) {
            setDetailPlugin(null);
            setDetailRatingPanelOpen(false);
          }
        }}
        onStatsChange={(pluginId, partialStats) => {
          setPluginStats((current) => mergePluginStatsMap(current, pluginId, partialStats));
        }}
        plugin={detailPlugin}
        stats={detailPlugin ? resolvePluginStats(detailPlugin, pluginStats) : undefined}
      />
    </>
  );
}

function filterPlugins<T extends { id: string; manifest: MarketPlugin["manifest"] }>(
  plugins: T[],
  query: string,
  pluginTypeFilter: PluginTypeFilter,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized && pluginTypeFilter === "all") {
    return plugins;
  }
  return plugins.filter((plugin) => {
    if (pluginTypeFilter !== "all" && pluginType(plugin) !== pluginTypeFilter) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    const haystack = [
      plugin.id,
      plugin.manifest.name,
      plugin.manifest.description,
      pluginAuthor(plugin.manifest),
      pluginTypeLabel(plugin),
      ...(plugin.manifest.keywords ?? []),
      ...(plugin.manifest.categories ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function pluginType(plugin: { manifest?: { plugin_type?: MaiBotPluginType } }): MaiBotPluginType {
  const value = plugin.manifest?.plugin_type;
  return value && PLUGIN_TYPE_VALUES.has(value) ? value : "extension";
}

function pluginTypeLabel(plugin: { manifest?: { plugin_type?: MaiBotPluginType } }): string {
  return PLUGIN_TYPE_LABELS[pluginType(plugin)];
}

function resolvePluginLucideIcon(name: string | undefined): LucideIcon | undefined {
  return name ? LUCIDE_PLUGIN_ICONS[name.trim().toLowerCase()] : undefined;
}

function pluginFallbackIcon(
  manifest?: { plugin_type?: MaiBotPluginType; display?: { icon?: MaiBotPluginDisplayIcon } },
): LucideIcon {
  return resolvePluginLucideIcon(manifest?.display?.icon?.fallback) ?? DEFAULT_PLUGIN_TYPE_ICONS[pluginType({ manifest })];
}

function pluginIdentity(plugin: MarketPlugin): string {
  return plugin.manifest.id || plugin.id || plugin.marketplace_id || plugin.manifest.name || plugin.id;
}

function parsePluginTime(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function pluginFreshness(plugin: MarketPlugin): number {
  const publishedTime = parsePluginTime(plugin.published_at);
  if (publishedTime > 0) {
    return publishedTime;
  }
  const updatedTime = parsePluginTime(plugin.updated_at);
  if (updatedTime > 0) {
    return updatedTime;
  }
  return plugin.marketplace_order ?? 0;
}

function stableRandomRank(seed: string, plugin: MarketPlugin): number {
  const value = `${seed}:${pluginIdentity(plugin)}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function selectSurprisePlugins(
  plugins: MarketPlugin[],
  sortBy: MarketSortKey,
  seed: string,
): MarketPlugin[] {
  if (sortBy !== "default" || plugins.length <= SURPRISE_PLUGIN_COUNT) {
    return [];
  }

  const candidateCount = Math.min(
    SURPRISE_CANDIDATE_LIMIT,
    Math.max(SURPRISE_PLUGIN_COUNT, Math.ceil(plugins.length * 0.3)),
  );

  return [...plugins]
    .sort((left, right) => {
      const freshnessDiff = pluginFreshness(right) - pluginFreshness(left);
      if (freshnessDiff !== 0) {
        return freshnessDiff;
      }
      return (right.marketplace_order ?? 0) - (left.marketplace_order ?? 0);
    })
    .slice(0, candidateCount)
    .sort((left, right) => stableRandomRank(seed, left) - stableRandomRank(seed, right))
    .slice(0, SURPRISE_PLUGIN_COUNT);
}

function sortMarketPlugins(
  plugins: MarketPlugin[],
  options: {
    preferCompatible: boolean;
    maibotVersion: string | undefined;
    sortBy: MarketSortKey;
    pluginStats: Record<string, PluginStats>;
  },
): MarketPlugin[] {
  return [...plugins].sort((left, right) => {
    if (options.preferCompatible && options.maibotVersion) {
      const leftCompatible = isPluginCompatible(left.manifest, options.maibotVersion);
      const rightCompatible = isPluginCompatible(right.manifest, options.maibotVersion);
      if (leftCompatible !== rightCompatible) {
        return leftCompatible ? -1 : 1;
      }
    }

    const valueDiff = marketSortValue(right, options.sortBy, options.pluginStats)
      - marketSortValue(left, options.sortBy, options.pluginStats);
    if (valueDiff !== 0) {
      return valueDiff;
    }

    return pluginName(left).localeCompare(pluginName(right), "zh-CN");
  });
}

function marketSortValue(
  plugin: MarketPlugin,
  sortBy: MarketSortKey,
  pluginStats: Record<string, PluginStats>,
): number {
  const stats = resolvePluginStats(plugin, pluginStats);
  const downloads = stats?.downloads ?? pluginInlineStat(plugin, "downloads") ?? 0;
  const likes = stats?.likes ?? pluginInlineStat(plugin, "likes") ?? 0;
  const rating = stats?.rating ?? pluginInlineStat(plugin, "rating") ?? 0;
  const comments = pluginCommentCount(stats) ?? pluginInlineStat(plugin, "comment_count") ?? 0;

  if (sortBy === "downloads") {
    return downloads;
  }
  if (sortBy === "likes") {
    return likes;
  }
  if (sortBy === "rating") {
    return rating;
  }
  if (sortBy === "comments") {
    return comments;
  }

  const ratingCount = stats?.rating_count ?? 0;
  return Math.log10(downloads + 1) * 4
    + Math.log10(likes + 1) * 3
    + Math.log10(comments + 1) * 2
    + rating * Math.log10(ratingCount + 2) * 2;
}

function ErrorPanel({
  error,
  isMarket,
}: {
  error: string | null;
  isMarket: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
        <AlertTriangle className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-destructive">插件数据读取失败</p>
        <p className="mt-1 text-muted-foreground">{error ?? "未知错误"}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {isMarket ? "请检查网络是否能访问插件仓库。" : "请确认本地 MaiBot 插件目录存在且可读。"}
        </p>
      </div>
    </div>
  );
}

function PluginGrid({
  plugins,
  sortBy,
  onOperate,
  onDetail,
  onComment,
  onQuickLike,
  onQuickRate,
  onQuickRatingToggle,
  maibotVersion,
  pluginStats,
  pluginUserStates,
  quickRatingPluginId,
  quickStatsBusy,
}: {
  plugins: MarketPlugin[];
  sortBy: MarketSortKey;
  onOperate: (operation: PendingOperation) => void;
  onDetail: (plugin: MarketPlugin) => void;
  onComment: (plugin: MarketPlugin) => void;
  onQuickLike: (plugin: MarketPlugin) => void;
  onQuickRate: (plugin: MarketPlugin, rating: number) => void;
  onQuickRatingToggle: (plugin: MarketPlugin) => void;
  maibotVersion?: string;
  pluginStats: Record<string, PluginStats>;
  pluginUserStates: Record<string, PluginUserState>;
  quickRatingPluginId: string | null;
  quickStatsBusy: QuickStatsBusy;
}): React.JSX.Element {
  const surpriseSeed = useMemo(() => Math.random().toString(36).slice(2), []);
  const surprisePlugins = useMemo(
    () => selectSurprisePlugins(plugins, sortBy, surpriseSeed),
    [plugins, sortBy, surpriseSeed],
  );
  const surprisePluginIds = useMemo(
    () => new Set(surprisePlugins.map(pluginIdentity)),
    [surprisePlugins],
  );
  const mainPlugins = useMemo(
    () => plugins.filter((plugin) => !surprisePluginIds.has(pluginIdentity(plugin))),
    [plugins, surprisePluginIds],
  );

  if (plugins.length === 0) {
    return <EmptyState icon={<Download />} title="没有匹配的插件" />;
  }

  const renderPluginCard = (plugin: MarketPlugin): React.JSX.Element => {
        const repositoryUrl = pluginRepositoryUrl(plugin.manifest);
        const incompatibleReason = getPluginCompatibilityReason(plugin.manifest, maibotVersion);
        const statsId = pluginStatsPrimaryId(plugin);
        const actions: CardAction[] = plugin.installed
          ? [
              {
                label: pluginNeedsUpdate(plugin) ? "更新" : "已安装",
                icon: <Upload />,
                disabled: !pluginNeedsUpdate(plugin) || !repositoryUrl,
                onClick: () =>
                  onOperate({
                    kind: "update",
                    plugin,
                    repositoryUrl,
                    branch: "main",
                    incompatibleReason,
                    latestVersion: pluginVersion(plugin.manifest),
                  }),
              },
            ]
          : [
              {
                label: "安装",
                icon: <Download />,
                disabled: !repositoryUrl,
                onClick: () => onOperate({ kind: "install", plugin, repositoryUrl, branch: "main", incompatibleReason }),
              },
            ];

        return (
          <PluginCard
            actions={actions}
            compatibilityReason={incompatibleReason}
            key={plugin.id}
            onDetail={() => onDetail(plugin)}
            plugin={plugin}
            quickStats={{
              busy: quickStatsBusy?.pluginId === statsId ? quickStatsBusy.action : null,
              ratingOpen: quickRatingPluginId === statsId,
              userState: pluginUserStates[statsId],
              onComment: () => onComment(plugin),
              onLike: () => onQuickLike(plugin),
              onRate: (rating) => onQuickRate(plugin, rating),
              onToggleRating: () => onQuickRatingToggle(plugin),
            }}
            stats={resolvePluginStats(plugin, pluginStats)}
            status={plugin.installed ? `本地 ${plugin.installedVersion ?? "-"}` : undefined}
          />
        );
  };

  return (
    <div className="grid gap-5">
      {surprisePlugins.length > 0 ? (
        <section className="grid gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h3 className="text-base font-semibold">惊喜随意</h3>
          </div>
          <div className="plugin-card-grid grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1 xl:auto-cols-auto xl:grid-cols-4">
            {surprisePlugins.map(renderPluginCard)}
          </div>
        </section>
      ) : null}

      <div className="plugin-card-grid grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {mainPlugins.map(renderPluginCard)}
      </div>
    </div>
  );
}

function InstalledGrid({
  plugins,
  onOperate,
  onConfigure,
  onDetail,
  onToggleEnabled,
  maibotVersion,
  maibotRunning,
  pluginStats,
  toggleBusyPluginId,
}: {
  plugins: InstalledPluginView[];
  onOperate: (operation: PendingOperation) => void;
  onConfigure: (plugin: InstalledPlugin) => void;
  onDetail: (plugin: InstalledPluginView) => void;
  onToggleEnabled: (plugin: InstalledPlugin, enabled: boolean) => void;
  maibotVersion?: string;
  maibotRunning: boolean;
  pluginStats: Record<string, PluginStats>;
  toggleBusyPluginId: string | null;
}): React.JSX.Element {
  if (plugins.length === 0) {
    return <EmptyState icon={<Puzzle />} title="没有已安装插件" />;
  }

  return (
    <div className="plugin-card-grid grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {plugins.map((plugin) => {
        const updatePlugin = plugin.marketPlugin;
        const repositoryUrl = updatePlugin ? pluginRepositoryUrl(updatePlugin.manifest) : pluginRepositoryUrl(plugin.manifest);
        const incompatibleReason = updatePlugin
          ? getPluginCompatibilityReason(updatePlugin.manifest, maibotVersion)
          : getPluginCompatibilityReason(plugin.manifest, maibotVersion);
        const updateLabel = updatePlugin
          ? plugin.updateAvailable
            ? "更新"
            : "已最新"
          : "无市场信息";
        return (
          <PluginCard
            actions={[
              {
                label: "配置",
                icon: <Settings />,
                iconOnly: true,
                variant: "outline",
                onClick: () => onConfigure(plugin),
              },
              {
                label: updateLabel,
                icon: <Upload />,
                iconOnly: true,
                disabled: !plugin.updateAvailable || !repositoryUrl,
                onClick: () =>
                  onOperate({
                    kind: "update",
                    plugin: updatePlugin ?? plugin,
                    repositoryUrl,
                    branch: "main",
                    incompatibleReason,
                    latestVersion: updatePlugin ? pluginVersion(updatePlugin.manifest) : undefined,
                  }),
              },
              {
                label: "卸载",
                icon: <Trash2 />,
                iconOnly: true,
                variant: "destructive",
                onClick: () => onOperate({ kind: "uninstall", plugin, branch: "main" }),
              },
            ]}
            compatibilityReason={incompatibleReason}
            key={`${plugin.id}:${plugin.path}`}
            onDetail={() => onDetail(plugin)}
            plugin={plugin}
            runtimeState={pluginRuntimeState(plugin, maibotRunning)}
            stats={resolvePluginStats(updatePlugin ?? plugin, pluginStats)}
            status={
              plugin.updateAvailable && updatePlugin
                ? `${pluginVersion(plugin.manifest)} -> ${pluginVersion(updatePlugin.manifest)}`
                : undefined
            }
            toggleEnabled={{
              checked: plugin.enabled !== false,
              busy: toggleBusyPluginId === plugin.id,
              onChange: (next) => onToggleEnabled(plugin, next),
            }}
          />
        );
      })}
    </div>
  );
}

function PluginDisplayIcon({
  plugin,
  className,
  iconClassName,
}: {
  plugin: { id: string; manifest: MarketPlugin["manifest"] };
  className?: string;
  iconClassName?: string;
}): React.JSX.Element {
  const icon = plugin.manifest.display?.icon;
  const [imageFailed, setImageFailed] = useState(false);
  const imageSource = icon?.type === "local" && icon.value.startsWith("data:") ? icon.value : null;
  const style: React.CSSProperties | undefined = icon?.background ? { backgroundColor: icon.background } : undefined;

  useEffect(() => {
    setImageFailed(false);
  }, [imageSource]);

  const baseClassName = cn(
    "plugin-card-display-icon flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary/10 text-primary",
    className,
  );

  if (icon?.type === "emoji") {
    return (
      <div className={baseClassName} style={style}>
        <span aria-hidden="true" className={cn("text-xl leading-none", iconClassName)}>
          {icon.value}
        </span>
      </div>
    );
  }

  if (imageSource && !imageFailed) {
    return (
      <div className={baseClassName} style={style}>
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          onError={() => setImageFailed(true)}
          src={imageSource}
        />
      </div>
    );
  }

  const Icon = icon?.type === "lucide"
    ? resolvePluginLucideIcon(icon.value) ?? pluginFallbackIcon(plugin.manifest)
    : pluginFallbackIcon(plugin.manifest);

  return (
    <div className={baseClassName} style={style}>
      <Icon className={cn("size-5", iconClassName)} />
    </div>
  );
}

function PluginCard({
  plugin,
  onDetail,
  status,
  actions,
  compatibilityReason,
  runtimeState,
  stats,
  quickStats,
  toggleEnabled,
}: {
  plugin: { id: string; manifest: MarketPlugin["manifest"] };
  onDetail: () => void;
  status?: string;
  actions: CardAction[];
  compatibilityReason?: string | null;
  runtimeState?: PluginRuntimeState;
  stats?: PluginStats;
  quickStats?: {
    busy: QuickStatsAction | null;
    ratingOpen: boolean;
    userState?: PluginUserState;
    onComment: () => void;
    onLike: () => void;
    onRate: (rating: number) => void;
    onToggleRating: () => void;
  };
  toggleEnabled?: {
    checked: boolean;
    busy: boolean;
    onChange: (checked: boolean) => void;
  };
}): React.JSX.Element {
  const titleMuted = runtimeState === "disabled";
  const downloads = stats?.downloads ?? pluginInlineStat(plugin, "downloads") ?? 0;
  const rating = stats?.rating ?? pluginInlineStat(plugin, "rating") ?? 0;
  const likes = stats?.likes ?? pluginInlineStat(plugin, "likes") ?? 0;
  const comments = pluginCommentCount(stats) ?? pluginInlineStat(plugin, "comment_count") ?? 0;
  const topActions = actions.filter((action) => action.placement === "top");
  const bottomActions = actions.filter((action) => action.placement !== "top");
  const pluginTitle = pluginName(plugin);
  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (isPluginCardControlTarget(event.target, event.currentTarget)) {
      return;
    }

    onDetail();
  };
  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    onDetail();
  };
  return (
    <div
      aria-label={`查看 ${pluginTitle} 详情`}
      className="plugin-card plugin-market-card flex min-h-44 cursor-pointer flex-col rounded-lg border border-border bg-card p-4 transition-[background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-[var(--retro-rust,var(--destructive))] hover:bg-card/95 hover:shadow-md hover:shadow-black/5 focus-visible:border-[var(--retro-rust,var(--destructive))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      role="button"
      tabIndex={0}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <PluginDisplayIcon plugin={plugin} />
          <div className="min-w-0">
            <p
              className={cn("plugin-card-title truncate font-sans text-base font-semibold leading-tight", titleMuted && "text-muted-foreground")}
              title={pluginTitle}
            >
              {pluginTitle}
            </p>
            <p className="plugin-card-meta mt-1 truncate text-xs text-muted-foreground">
              v{pluginVersion(plugin.manifest)} · {pluginAuthor(plugin.manifest)}
            </p>
            <Badge className="mt-2" variant="secondary">{pluginTypeLabel(plugin)}</Badge>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {topActions.length ? (
            <div
              className="flex items-center gap-1"
              data-plugin-card-control="true"
              onClick={(event) => event.stopPropagation()}
            >
              {topActions.map((action) => (
                <Button
                  className="plugin-card-action"
                  disabled={action.disabled}
                  key={action.label}
                  onClick={(event) => {
                    event.stopPropagation();
                    action.onClick();
                  }}
                  size="sm"
                  title={action.label}
                  variant={action.variant ?? "secondary"}
                >
                  {action.icon}
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
          {status ? <Badge className="plugin-card-status-badge" variant="outline">{status}</Badge> : null}
          {runtimeState ? <PluginRuntimeLight state={runtimeState} /> : null}
          {compatibilityReason ? <Badge variant="warning">不兼容</Badge> : null}
        </div>
      </div>
      {compatibilityReason ? (
        <p className="mt-2 rounded-md bg-warning/15 px-2 py-1 text-[11px] leading-relaxed text-warning-foreground">
          {compatibilityReason}
        </p>
      ) : null}
      <p className="plugin-card-description mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
        {pluginDescription(plugin.manifest)}
      </p>
      <div className="plugin-card-stats mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Download className="size-3.5" />
          {downloads.toLocaleString()}
        </span>
        <span className="inline-flex items-center gap-1">
          <Star className="size-3.5 fill-yellow-400 text-yellow-400" />
          {rating.toFixed(1)}
        </span>
        <span className="inline-flex items-center gap-1">
          <ThumbsUp className="size-3.5" />
          {likes.toLocaleString()}
        </span>
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="size-3.5" />
          {comments.toLocaleString()}
        </span>
      </div>
      <div className="plugin-card-rule mt-3" />
      <div className="plugin-card-footer-meta mt-3 space-y-1 text-xs text-muted-foreground">
        <p className="truncate">
          v{pluginVersion(plugin.manifest)} · {pluginAuthor(plugin.manifest)}
        </p>
        <p className="truncate">
          支持: {plugin.manifest.host_application?.min_version ?? "任意"} - {plugin.manifest.host_application?.max_version ?? "最新"}
        </p>
      </div>
      <div className="plugin-card-tags mt-3 flex flex-wrap gap-1">
        {(plugin.manifest.categories ?? plugin.manifest.keywords ?? []).slice(0, 3).map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <div className="plugin-card-secondary-controls flex min-w-0 flex-wrap items-center gap-2">
          {quickStats ? (
            <PluginCardQuickStats
              busy={quickStats.busy}
              comments={comments}
              likes={likes}
              onComment={quickStats.onComment}
              onLike={quickStats.onLike}
              onRate={quickStats.onRate}
              onToggleRating={quickStats.onToggleRating}
              rating={rating}
              ratingOpen={quickStats.ratingOpen}
              userState={quickStats.userState}
            />
          ) : null}
          {toggleEnabled ? (
            <label
              className="inline-flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground"
              data-plugin-card-control="true"
              onClick={(event) => event.stopPropagation()}
              title={toggleEnabled.checked ? "禁用插件" : "启用插件"}
            >
              <button
                aria-label={toggleEnabled.checked ? "禁用插件" : "启用插件"}
                aria-checked={toggleEnabled.checked}
                className={cn(
                  "plugin-card-action relative h-5 w-9 rounded-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  toggleEnabled.checked ? "border-primary bg-primary" : "border-border bg-muted",
                  toggleEnabled.busy && "cursor-wait opacity-70",
                )}
                disabled={toggleEnabled.busy}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleEnabled.onChange(!toggleEnabled.checked);
                }}
                role="switch"
                type="button"
              >
                <span
                  className={cn(
                    "absolute top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm bg-background shadow-sm transition-transform",
                    toggleEnabled.checked ? "translate-x-4" : "translate-x-0.5",
                  )}
                >
                  {toggleEnabled.busy ? <Loader2 className="size-2.5 animate-spin" /> : null}
                </span>
              </button>
            </label>
          ) : null}
        </div>
        <div
          className="flex shrink-0 flex-wrap items-center justify-end gap-1"
          data-plugin-card-control="true"
          onClick={(event) => event.stopPropagation()}
        >
          <Button
            className="plugin-card-action plugin-card-detail-action"
            onClick={(event) => {
              event.stopPropagation();
              onDetail();
            }}
            size="sm"
            title="查看详情"
            variant="outline"
          >
            <Info />
            详情
          </Button>
          {bottomActions.map((action) => (
            <Button
              className={cn(
                "plugin-card-action",
                action.variant === "outline" ? "plugin-card-detail-action" : "plugin-card-primary-action",
                action.iconOnly && "plugin-card-icon-action",
              )}
              disabled={action.disabled}
              key={action.label}
              onClick={(event) => {
                event.stopPropagation();
                action.onClick();
              }}
              size={action.iconOnly ? "icon-sm" : "sm"}
              title={action.label}
              variant={action.variant ?? "secondary"}
            >
              {action.icon}
              {action.iconOnly ? <span className="sr-only">{action.label}</span> : action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PluginCardQuickStats({
  likes,
  rating,
  comments,
  userState,
  busy,
  ratingOpen,
  onComment,
  onLike,
  onToggleRating,
  onRate,
}: {
  likes: number;
  rating: number;
  comments: number;
  userState?: PluginUserState;
  busy: QuickStatsAction | null;
  ratingOpen: boolean;
  onComment: () => void;
  onLike: () => void;
  onToggleRating: () => void;
  onRate: (rating: number) => void;
}): React.JSX.Element {
  const liked = userState?.liked === true;
  const userRating = userState?.rating ?? 0;
  const ratingBusy = busy === "rating" || busy === "user-state";

  return (
    <div
      className="plugin-card-quick-stats flex min-w-0 flex-wrap items-center gap-1.5"
      data-plugin-card-control="true"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Button
        className="plugin-card-action h-8 px-2 text-xs"
        disabled={busy !== null}
        onClick={(event) => {
          event.stopPropagation();
          onLike();
        }}
        size="sm"
        title={liked ? "取消点赞" : "点赞插件"}
        variant={liked ? "default" : "outline"}
      >
        {busy === "like" ? <Loader2 className="animate-spin" /> : <ThumbsUp />}
        <span className={cn("font-mono text-[11px]", liked ? "text-primary-foreground/85" : "text-muted-foreground")}>
          {likes.toLocaleString()}
        </span>
      </Button>

      <div className="relative">
        <Button
          className="plugin-card-action h-8 px-2 text-xs"
          disabled={busy !== null && !ratingOpen}
          onClick={(event) => {
            event.stopPropagation();
            onToggleRating();
          }}
          size="sm"
          title={userRating > 0 ? `我的评分 ${userRating} 星` : "评分插件"}
          variant={userRating > 0 || ratingOpen ? "secondary" : "outline"}
        >
          {ratingBusy ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Star className={cn("size-3.5", (userRating > 0 || ratingOpen) && "fill-yellow-400 text-yellow-400")} />
          )}
          <span className="font-mono text-[11px] text-muted-foreground">{rating.toFixed(1)}</span>
        </Button>

        {ratingOpen ? (
          <div className="absolute bottom-full left-0 z-20 mb-2 flex items-center gap-0.5 rounded-md border border-border bg-card p-1 shadow-lg">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                aria-label={`${star} 星评分`}
                className="plugin-card-action grid size-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-yellow-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-wait disabled:opacity-60"
                disabled={busy !== null}
                key={star}
                onClick={(event) => {
                  event.stopPropagation();
                  onRate(star);
                }}
                title={`${star} 星`}
                type="button"
              >
                <Star
                  className={cn(
                    "size-4",
                    star <= userRating && "fill-yellow-400 text-yellow-400",
                  )}
                />
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <Button
        className="plugin-card-action h-8 px-2 text-xs"
        disabled={busy !== null}
        onClick={(event) => {
          event.stopPropagation();
          onComment();
        }}
        size="sm"
        title="评论插件"
        variant="outline"
      >
        <MessageSquare />
        <span className="font-mono text-[11px] text-muted-foreground">{comments.toLocaleString()}</span>
      </Button>
    </div>
  );
}

function resolvePluginStats(
  plugin: { id: string; manifest: MarketPlugin["manifest"] },
  stats: Record<string, PluginStats>,
): PluginStats | undefined {
  const statsIds = [plugin.manifest.id, plugin.id].filter((id): id is string => Boolean(id));
  return statsIds.map((id) => stats[id]).find(Boolean);
}

function pluginStatsPrimaryId(plugin: { id: string; manifest: MarketPlugin["manifest"] }): string {
  return plugin.manifest.id?.trim() || plugin.id;
}

function createEmptyPluginStats(pluginId: string): PluginStats {
  return {
    plugin_id: pluginId,
    likes: 0,
    dislikes: 0,
    downloads: 0,
    rating: 0,
    rating_count: 0,
    comment_count: 0,
  };
}

function createEmptyPluginUserState(): PluginUserState {
  return {
    liked: false,
    disliked: false,
    rating: null,
    comment: "",
  };
}

function mergePluginUserState(
  state: PluginUserState | undefined,
  partialState: Partial<PluginUserState>,
): PluginUserState {
  return {
    ...(state ?? createEmptyPluginUserState()),
    ...partialState,
  };
}

function mergePluginStats(pluginId: string, stats: PluginStats | undefined, partialStats: Partial<PluginStats>): PluginStats {
  const definedPartialStats = Object.fromEntries(
    Object.entries(partialStats).filter(([, value]) => value !== undefined),
  ) as Partial<PluginStats>;
  return {
    ...(stats ?? createEmptyPluginStats(pluginId)),
    ...definedPartialStats,
    plugin_id: stats?.plugin_id ?? pluginId,
  };
}

function mergePluginStatsMap(
  current: Record<string, PluginStats>,
  pluginId: string,
  partialStats: Partial<PluginStats>,
): Record<string, PluginStats> {
  return {
    ...current,
    [pluginId]: mergePluginStats(pluginId, current[pluginId], partialStats),
  };
}

function pluginCommentCount(stats: PluginStats | undefined): number | undefined {
  if (!stats) {
    return undefined;
  }
  return stats.comment_count
    ?? stats.recent_ratings?.filter((rating) => rating.comment?.trim()).length
    ?? 0;
}

function pluginInlineStat(
  plugin: { id: string; manifest: MarketPlugin["manifest"] },
  key: "downloads" | "rating" | "likes" | "comment_count",
): number | undefined {
  const value = (plugin as Partial<Record<typeof key, unknown>>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pluginRuntimeState(plugin: InstalledPluginView, maibotRunning: boolean): PluginRuntimeState {
  if (plugin.enabled === false) {
    return "disabled";
  }
  if (!maibotRunning) {
    return "inactive";
  }
  const loadStatus = plugin.load_status?.toLowerCase();
  if (plugin.loaded === true) {
    return "loaded";
  }
  if (loadStatus === "success") {
    return "loaded";
  }
  if (loadStatus === "failed") {
    return "failed";
  }
  if (loadStatus === "inactive") {
    return "inactive";
  }
  if (!loadStatus || loadStatus === "unknown" || loadStatus === "loading") {
    return "loading";
  }
  return "inactive";
}

function PluginRuntimeLight({ state }: { state: PluginRuntimeState }): React.JSX.Element {
  const meta = {
    disabled: { label: "未启用", className: "bg-muted-foreground/55" },
    inactive: { label: "未加载", className: "bg-muted-foreground/55" },
    loading: { label: "加载中", className: "bg-sky-500" },
    failed: { label: "加载失败", className: "bg-destructive" },
    loaded: { label: "加载成功", className: "bg-emerald-500" },
  }[state];

  return (
    <span className="plugin-runtime-light inline-flex h-6 items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
      <span className={["size-2 rounded-full", meta.className].join(" ")} />
      {meta.label}
    </span>
  );
}

function PluginDetailDialog({
  plugin,
  stats,
  initialRatingPanelOpen,
  maibotVersion,
  onStatsChange,
  onOpenChange,
}: {
  plugin: DetailPlugin | null;
  stats?: PluginStats;
  initialRatingPanelOpen?: boolean;
  maibotVersion?: string;
  onStatsChange?: (pluginId: string, stats: Partial<PluginStats>) => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const repositoryUrl = plugin ? pluginRepositoryUrl(plugin.manifest) : undefined;
  const homepageUrl = plugin ? pluginHomepageUrl(plugin.manifest) : undefined;
  const compatibilityReason = plugin ? getPluginCompatibilityReason(plugin.manifest, maibotVersion) : null;
  const downloads = stats?.downloads ?? (plugin ? pluginInlineStat(plugin, "downloads") : undefined) ?? 0;
  const rating = stats?.rating ?? (plugin ? pluginInlineStat(plugin, "rating") : undefined) ?? 0;
  const likes = stats?.likes ?? (plugin ? pluginInlineStat(plugin, "likes") : undefined) ?? 0;
  const commentTotal = pluginCommentCount(stats) ?? (plugin ? pluginInlineStat(plugin, "comment_count") : undefined) ?? 0;
  const [readme, setReadme] = useState("");
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [detailStats, setDetailStats] = useState<PluginStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [userLiked, setUserLiked] = useState(false);
  const [userDisliked, setUserDisliked] = useState(false);
  const [userRating, setUserRating] = useState(0);
  const [userRatingDirty, setUserRatingDirty] = useState(false);
  const [userComment, setUserComment] = useState("");
  const [userCommentDirty, setUserCommentDirty] = useState(false);
  const [statsAction, setStatsAction] = useState<"like" | "dislike" | "rating" | null>(null);
  const [ratingPanelOpen, setRatingPanelOpen] = useState(false);
  const resolvedStats = detailStats ?? stats;
  const resolvedDownloads = resolvedStats?.downloads ?? downloads;
  const resolvedRating = resolvedStats?.rating ?? rating;
  const resolvedLikes = resolvedStats?.likes ?? likes;
  const resolvedDislikes = resolvedStats?.dislikes ?? 0;
  const resolvedComments = pluginCommentCount(resolvedStats) ?? commentTotal;
  const comments = resolvedStats?.recent_ratings?.filter((item) => item.comment?.trim()) ?? [];
  const keywords = plugin?.manifest.keywords ?? [];
  const categories = plugin?.manifest.categories ?? [];

  useEffect(() => {
    if (!plugin) {
      setReadme("");
      setDetailStats(null);
      setUserLiked(false);
      setUserDisliked(false);
      setUserRating(0);
      setUserRatingDirty(false);
      setUserComment("");
      setUserCommentDirty(false);
      setRatingPanelOpen(false);
      return;
    }

    let cancelled = false;
    setReadmeLoading(true);
    setStatsLoading(true);
    setReadme("");
    setDetailStats(null);
    setUserLiked(false);
    setUserDisliked(false);
    setUserRating(0);
    setUserRatingDirty(false);
    setUserComment("");
    setUserCommentDirty(false);
    setRatingPanelOpen(initialRatingPanelOpen === true);
    const statsId = pluginStatsPrimaryId(plugin);

    void fetchPluginReadme(plugin.id, pluginRepositoryUrl(plugin.manifest))
      .then((result) => {
        if (!cancelled) {
          setReadme(result.success && result.content ? result.content : result.error ?? "该插件暂无 README 文档");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setReadme(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReadmeLoading(false);
        }
      });

    void fetchPluginStats(statsId)
      .then((nextStats) => {
        if (!cancelled) {
          setDetailStats(nextStats);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStatsLoading(false);
        }
      });

    void fetchPluginUserState(statsId)
      .then((userState) => {
        if (!cancelled && userState) {
          setUserLiked(userState.liked);
          setUserDisliked(userState.disliked);
          setUserRating(userState.rating ?? 0);
          setUserRatingDirty(false);
          setUserComment(userState.comment);
          setUserCommentDirty(false);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [initialRatingPanelOpen, plugin]);

  const applyStatsPartial = (pluginId: string, partialStats: Partial<PluginStats>) => {
    setDetailStats((current) => mergePluginStats(pluginId, current ?? resolvedStats, partialStats));
    onStatsChange?.(pluginId, partialStats);
  };

  const handlePluginLike = async () => {
    if (!plugin || statsAction) {
      return;
    }
    const statsId = pluginStatsPrimaryId(plugin);
    setStatsAction("like");
    try {
      const result = await likePlugin(statsId);
      if (!result.success) {
        toast.error(result.error ?? "点赞失败");
        return;
      }
      setUserLiked(result.liked === true);
      setUserDisliked(result.disliked === true);
      applyStatsPartial(statsId, {
        likes: result.likes ?? resolvedLikes,
        dislikes: result.dislikes ?? resolvedDislikes,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setStatsAction(null);
    }
  };

  const handlePluginDislike = async () => {
    if (!plugin || statsAction) {
      return;
    }
    const statsId = pluginStatsPrimaryId(plugin);
    setStatsAction("dislike");
    try {
      const result = await dislikePlugin(statsId);
      if (!result.success) {
        toast.error(result.error ?? "点踩失败");
        return;
      }
      setUserLiked(result.liked === true);
      setUserDisliked(result.disliked === true);
      applyStatsPartial(statsId, {
        likes: result.likes ?? resolvedLikes,
        dislikes: result.dislikes ?? resolvedDislikes,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setStatsAction(null);
    }
  };

  const handlePluginRating = async () => {
    if (!plugin || statsAction) {
      return;
    }
    if (!userRatingDirty && !userCommentDirty) {
      toast.error("请先填写评论或选择 1-5 星评分");
      return;
    }
    if (userRatingDirty && (userRating < 1 || userRating > 5)) {
      toast.error("评分必须在 1-5 星之间");
      return;
    }

    const statsId = pluginStatsPrimaryId(plugin);
    const ratingPayload = userRatingDirty ? userRating : undefined;
    const commentPayload = userCommentDirty ? userComment.trim() : undefined;
    setStatsAction("rating");
    try {
      const result = await ratePlugin(statsId, ratingPayload, commentPayload);
      if (!result.success) {
        toast.error(result.error ?? "提交失败");
        return;
      }
      if (result.user_rating !== undefined) {
        setUserRating(result.user_rating ?? 0);
      } else if (ratingPayload !== undefined) {
        setUserRating(ratingPayload);
      }
      if (commentPayload !== undefined) {
        setUserComment(commentPayload);
      }
      setUserRatingDirty(false);
      setUserCommentDirty(false);
      setRatingPanelOpen(false);
      applyStatsPartial(statsId, {
        rating: result.rating ?? resolvedRating,
        rating_count: result.rating_count ?? resolvedStats?.rating_count ?? 0,
        comment_count: result.comment_count ?? resolvedComments,
      });
      void fetchPluginStats(statsId).then((nextStats) => {
        if (nextStats) {
          setDetailStats(nextStats);
          onStatsChange?.(statsId, nextStats);
        }
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setStatsAction(null);
    }
  };

  const canSubmitRatingPanel = userRatingDirty || userCommentDirty;

  return (
    <Dialog open={plugin !== null} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader
          description={plugin ? plugin.id : undefined}
          icon={<Info className="size-4" />}
          title={plugin ? pluginName(plugin) : "插件详情"}
          tone="primary"
        />
        <DialogBody className="space-y-4">
          {plugin ? (
            <>
              <div className="grid gap-3 md:grid-cols-[1.25fr_0.75fr]">
                <div className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <PluginDisplayIcon className="size-12" iconClassName="size-6" plugin={plugin} />
                      <div className="min-w-0">
                        <h3 className="truncate text-base font-semibold">{pluginName(plugin)}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          v{pluginVersion(plugin.manifest)} · {pluginAuthor(plugin.manifest)}
                        </p>
                        <Badge className="mt-2" variant="secondary">{pluginTypeLabel(plugin)}</Badge>
                      </div>
                    </div>
                    {compatibilityReason ? <Badge variant="warning">不兼容</Badge> : null}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {pluginDescription(plugin.manifest)}
                  </p>
                  {compatibilityReason ? (
                    <p className="mt-3 rounded-md bg-warning/15 px-3 py-2 text-xs leading-relaxed text-warning-foreground">
                      {compatibilityReason}
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-2 rounded-lg border border-border bg-card p-4 text-sm">
                  <PluginDetailStat icon={<Download className="size-4" />} label="下载" value={resolvedDownloads.toLocaleString()} />
                  <PluginDetailStat icon={<Star className="size-4 fill-yellow-400 text-yellow-400" />} label="评分" value={resolvedRating.toFixed(1)} />
                  <PluginDetailStat icon={<ThumbsUp className="size-4" />} label="点赞" value={resolvedLikes.toLocaleString()} />
                  <PluginDetailStat icon={<MessageSquare className="size-4" />} label="评论" value={resolvedComments.toLocaleString()} />
                  <div className="mt-2 flex flex-wrap gap-2 border-t border-border pt-3">
                    <Button
                      disabled={statsAction !== null}
                      onClick={handlePluginLike}
                      size="sm"
                      variant={userLiked ? "default" : "secondary"}
                    >
                      {statsAction === "like" ? <Loader2 className="animate-spin" /> : <ThumbsUp />}
                      {userLiked ? "已点赞" : "点赞"}
                    </Button>
                    <Button
                      disabled={statsAction !== null}
                      onClick={handlePluginDislike}
                      size="sm"
                      variant={userDisliked ? "destructive" : "secondary"}
                    >
                      {statsAction === "dislike" ? <Loader2 className="animate-spin" /> : <ThumbsDown />}
                      {userDisliked ? "已点踩" : "点踩"}
                    </Button>
                    <Button
                      disabled={statsAction !== null}
                      onClick={() => setRatingPanelOpen((open) => !open)}
                      size="sm"
                      variant="outline"
                    >
                      <Star />
                      {userRating > 0 ? "改评分" : "评分"}
                    </Button>
                    <Button
                      disabled={statsAction !== null}
                      onClick={() => setRatingPanelOpen(true)}
                      size="sm"
                      variant="outline"
                    >
                      <MessageSquare />
                      评论
                    </Button>
                  </div>
                  {ratingPanelOpen ? (
                    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
                      <div className="flex items-center justify-center gap-1">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <button
                            className="rounded-md p-1 text-muted-foreground transition-colors hover:text-yellow-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                            key={star}
                            onClick={() => {
                              setUserRating(star);
                              setUserRatingDirty(true);
                            }}
                            type="button"
                          >
                            <Star
                              className={cn(
                                "size-6",
                                star <= userRating && "fill-yellow-400 text-yellow-400",
                              )}
                            />
                          </button>
                        ))}
                      </div>
                      <textarea
                        className="min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-xs outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60"
                        maxLength={500}
                        onChange={(event) => {
                          setUserComment(event.target.value);
                          setUserCommentDirty(true);
                        }}
                        placeholder="写下你的使用体验"
                        value={userComment}
                      />
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">{userComment.length} / 500</span>
                        <Button disabled={statsAction !== null || !canSubmitRatingPanel} onClick={handlePluginRating} size="sm">
                          {statsAction === "rating" ? <Loader2 className="animate-spin" /> : <Save />}
                          提交
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <PluginDetailRow label="插件 ID" value={plugin.id} code />
                <PluginDetailRow label="许可证" value={plugin.manifest.license ?? "未知"} />
                <PluginDetailRow
                  label="支持版本"
                  value={
                    plugin.manifest.host_application
                      ? `${plugin.manifest.host_application.min_version ?? "任意"} - ${plugin.manifest.host_application.max_version ?? "最新"}`
                      : "未声明"
                  }
                />
                <PluginDetailRow label="Manifest" value={`v${plugin.manifest.manifest_version ?? 1}`} />
              </div>

              {[...categories, ...keywords].length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {categories.map((item) => <Badge key={`category:${item}`} variant="secondary">{item}</Badge>)}
                  {keywords.map((item) => <Badge key={`keyword:${item}`} variant="outline">{item}</Badge>)}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {homepageUrl ? (
                  <Button onClick={() => void window.maibotDesktop?.openExternal(homepageUrl)} size="sm" variant="secondary">
                    <ExternalLink />
                    打开主页
                  </Button>
                ) : null}
                {repositoryUrl ? (
                  <Button onClick={() => void window.maibotDesktop?.openExternal(repositoryUrl)} size="sm" variant="secondary">
                    <ExternalLink />
                    打开仓库
                  </Button>
                ) : null}
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
                <section className="min-w-0 rounded-lg border border-border bg-card">
                  <div className="border-b border-border px-4 py-3 text-sm font-semibold">README</div>
                  <div className="max-h-96 overflow-y-auto p-4">
                    {readmeLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        正在加载 README
                      </div>
                    ) : (
                      <MarkdownRenderer content={readme || "该插件暂无 README 文档"} />
                    )}
                  </div>
                </section>

                <section className="min-w-0 rounded-lg border border-border bg-card">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-semibold">
                    评论
                    {statsLoading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
                  </div>
                  <div className="max-h-96 space-y-3 overflow-y-auto p-4">
                    {comments.length ? (
                      comments.slice(0, 8).map((comment, index) => (
                        <div className="rounded-md bg-muted/35 p-3 text-xs" key={`${comment.user_id}-${comment.created_at}-${index}`}>
                          <div className="mb-1 flex items-center justify-between gap-2 text-muted-foreground">
                            <span className="truncate">{comment.user_id}</span>
                            <span className="inline-flex items-center gap-1">
                              <Star className="size-3 fill-yellow-400 text-yellow-400" />
                              {typeof comment.rating === "number" ? comment.rating.toFixed(1) : "未评分"}
                            </span>
                            {typeof comment.likes === "number" ? (
                              <span className="inline-flex items-center gap-1">
                                <ThumbsUp className="size-3" />
                                {comment.likes.toLocaleString()}
                              </span>
                            ) : null}
                          </div>
                          <p className="whitespace-pre-wrap break-words leading-relaxed">{comment.comment}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">{statsLoading ? "正在拉取评论" : "暂无评论"}</p>
                    )}
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PluginDetailStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function PluginDetailRow({
  label,
  value,
  code,
}: {
  label: string;
  value: string;
  code?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {code ? (
        <code className="mt-1 block truncate text-xs">{value}</code>
      ) : (
        <p className="mt-1 truncate text-sm font-medium">{value}</p>
      )}
    </div>
  );
}

function PluginConfigDialog({
  plugin,
  state,
  draft,
  busy,
  error,
  onChange,
  onSave,
  onOpenChange,
}: {
  plugin: InstalledPlugin | null;
  state: PluginConfigState | null;
  draft: Record<string, PluginConfigValue> | null;
  busy: ConfigBusyState;
  error: string | null;
  onChange: (path: string[], value: PluginConfigValue) => void;
  onSave: () => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const sections = state?.schema.sections ?? [];
  const adapterView = plugin ? getAdapterConfigView(plugin.id) : null;
  const [adapterPage, setAdapterPage] = useState<AdapterConfigPage>("chat");

  useEffect(() => {
    setAdapterPage("chat");
  }, [plugin?.id]);

  const visibleSections = adapterView
    ? sections.filter((section) =>
        adapterPage === "connection"
          ? section.name === adapterView.connectionSectionName
          : section.name === "chat",
      )
      .map((section) =>
        adapterPage === "chat"
          ? {
              ...section,
              fields: section.fields.filter((field) => !isHiddenAdapterChatField(field)),
            }
          : section,
      )
      .filter((section) => section.fields.length > 0)
    : sections;

  return (
    <Dialog open={plugin !== null} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader
          description={plugin && !adapterView ? `${plugin.id} · ${state?.configPath ?? "config.toml"}` : undefined}
          icon={<Settings className="size-4" />}
          title={plugin ? `${pluginName(plugin)} 配置` : "插件配置"}
          tone="primary"
        />
        <DialogBody className="space-y-4">
          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {error}
            </div>
          ) : null}

          {busy === "load" ? (
            <div className="grid min-h-48 place-items-center rounded-lg border border-border bg-muted/40 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                正在读取插件配置
              </span>
            </div>
          ) : state && draft ? (
            visibleSections.length > 0 ? (
              <div className="grid gap-3">
                {adapterView ? (
                  <AdapterConfigPageHeader
                    adapterPage={adapterPage}
                    adapterView={adapterView}
                    onPageChange={setAdapterPage}
                  />
                ) : null}
                {visibleSections.map((section) => (
                  <PluginConfigSection
                    draft={draft}
                    key={section.name}
                    onChange={onChange}
                    section={section}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-8 text-center text-sm text-muted-foreground">
                这个插件还没有可渲染的 config.toml
              </div>
            )
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button className="hidden" disabled={busy !== null} onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            关闭
          </Button>
          <Button className="[&>span]:hidden" disabled={busy !== null || !draft || !state} onClick={onSave} size="sm">
            {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}
            <span className="text-sm">保存并关闭</span>
            保存配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdapterConfigPageHeader({
  adapterView,
  adapterPage,
  onPageChange,
}: {
  adapterView: AdapterConfigView;
  adapterPage: AdapterConfigPage;
  onPageChange: (page: AdapterConfigPage) => void;
}): React.JSX.Element {
  const pageTitle = adapterPage === "connection" ? adapterView.connectionTitle : adapterView.chatTitle;
  const pageDescription = adapterPage === "connection"
    ? "填写与 QQ 后端 WebSocket 服务连接相关的地址、端口、token 和超时参数。"
    : "设置允许响应的群聊、私聊与用户名单。这里会影响哪些聊天能进入 MaiBot。";
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{pageTitle}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{pageDescription}</p>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-background p-1">
          <Button
            onClick={() => onPageChange("chat")}
            size="sm"
            type="button"
            variant={adapterPage === "chat" ? "secondary" : "ghost"}
          >
            聊天过滤
          </Button>
          <Button
            onClick={() => onPageChange("connection")}
            size="sm"
            type="button"
            variant={adapterPage === "connection" ? "secondary" : "ghost"}
          >
            连接配置
          </Button>
        </div>
      </div>
    </div>
  );
}

function isHiddenAdapterChatField(
  field: PluginConfigState["schema"]["sections"][number]["fields"][number],
): boolean {
  const fallbackName = field.path[field.path.length - 1];
  return HIDDEN_ADAPTER_CHAT_FIELDS.has(field.name || fallbackName || "");
}

function getAdapterConfigView(pluginId: string): AdapterConfigView | null {
  if (pluginId === "maibot-team.napcat-adapter") {
    return {
      kind: "napcat",
      connectionSectionName: "napcat_server",
      connectionTitle: "NapCat 连接配置",
      chatTitle: "聊天过滤配置",
    };
  }
  if (pluginId === "maibot-team.snowluma-adapter") {
    return {
      kind: "snowluma",
      connectionSectionName: "luma_client",
      connectionTitle: "SnowLuma 连接配置",
      chatTitle: "聊天过滤配置",
    };
  }
  return null;
}

function PluginConfigSection({
  section,
  draft,
  onChange,
}: {
  section: NonNullable<PluginConfigState["schema"]["sections"]>[number];
  draft: Record<string, PluginConfigValue>;
  onChange: (path: string[], value: PluginConfigValue) => void;
}): React.JSX.Element {
  const title = resolveLocalizedText(section.title, section.name);
  const description = resolveLocalizedText(section.description, "");
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{title}</p>
          {description ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{section.name}</p>
        </div>
        <Badge variant="secondary">{section.fields.length}</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {section.fields.map((field) => (
          <PluginConfigField
            field={field}
            key={field.path.join(".")}
            onChange={onChange}
            value={getPluginConfigValue(draft, field.path) ?? field.value}
          />
        ))}
      </div>
    </div>
  );
}

function PluginConfigField({
  field,
  value,
  onChange,
}: {
  field: PluginConfigState["schema"]["sections"][number]["fields"][number];
  value: PluginConfigValue;
  onChange: (path: string[], value: PluginConfigValue) => void;
}): React.JSX.Element {
  const label = fieldLabel(field);
  const description = fieldDescription(field);
  const disabled = field.disabled === true;
  const widget = (field.uiType ?? field.inputType ?? "").toLowerCase();
  const choices = field.choices;

  if (choices?.length) {
    return (
      <label className="grid min-w-0 gap-1.5 text-xs font-medium">
        <span className="truncate">{label}</span>
        <select
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
          onChange={(event) => onChange(field.path, parseChoiceValue(event.target.value, choices))}
          value={choiceValueKey(value)}
        >
          {choices.map((choice) => {
            const choiceValue = isChoiceObject(choice) ? choice.value : choice;
            const choiceLabel = isChoiceObject(choice)
              ? resolveLocalizedText(choice.label, String(choiceValue))
              : String(choice);
            return (
              <option key={choiceValueKey(choiceValue)} value={choiceValueKey(choiceValue)}>
                {choiceLabel}
              </option>
            );
          })}
        </select>
        <ConfigFieldHelp description={description} field={field} />
      </label>
    );
  }

  if (typeof value === "boolean") {
    return (
      <label className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/35 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{label}</span>
          {description ? <span className="block truncate text-[11px] text-muted-foreground">{description}</span> : null}
          <span className="block truncate font-mono text-[10px] text-muted-foreground">{field.name}</span>
        </span>
        <Checkbox checked={value} disabled={disabled} onCheckedChange={(checked) => onChange(field.path, checked === true)} />
      </label>
    );
  }

  if (typeof value === "number") {
    const isSlider = widget === "slider" || widget === "range";
    return (
      <label className="grid min-w-0 gap-1.5 text-xs font-medium">
        <span className="truncate">{label}</span>
        <Input
          disabled={disabled}
          inputMode="decimal"
          max={field.max}
          min={field.min}
          monospace
          onChange={(event) => {
            const nextValue = Number(event.target.value);
            onChange(field.path, Number.isFinite(nextValue) ? nextValue : 0);
          }}
          step={field.step}
          type={isSlider ? "range" : "number"}
          value={String(value)}
        />
        <ConfigFieldHelp description={description} field={field} />
      </label>
    );
  }

  if (typeof value === "string") {
    const placeholder = resolveLocalizedText(field.placeholder, "");
    if (widget === "textarea" || field.rows) {
      return (
        <label className="grid min-w-0 gap-1.5 text-xs font-medium md:col-span-2">
          <span className="truncate">{label}</span>
          <textarea
            className="min-h-24 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled}
            onChange={(event) => onChange(field.path, event.target.value)}
            placeholder={placeholder}
            rows={field.rows}
            value={value}
          />
          <ConfigFieldHelp description={description} field={field} />
        </label>
      );
    }
    return (
      <label className="grid min-w-0 gap-1.5 text-xs font-medium">
        <span className="truncate">{label}</span>
        <Input
          disabled={disabled}
          monospace
          onChange={(event) => onChange(field.path, event.target.value)}
          placeholder={placeholder}
          type={widget === "password" ? "password" : "text"}
          value={value}
        />
        <ConfigFieldHelp description={description} field={field} />
      </label>
    );
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return (
      <StringArrayConfigField
        field={field}
        onChange={(nextValue) => onChange(field.path, nextValue)}
        value={value}
      />
    );
  }

  return (
    <JsonConfigField
      field={field}
      onChange={(nextValue) => onChange(field.path, nextValue)}
      value={value}
    />
  );
}

function StringArrayConfigField({
  field,
  value,
  onChange,
}: {
  field: PluginConfigState["schema"]["sections"][number]["fields"][number];
  value: string[];
  onChange: (value: PluginConfigValue) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const label = fieldLabel(field);
  const description = fieldDescription(field);

  const addItem = useCallback(() => {
    const nextItem = draft.trim();
    if (!nextItem) {
      return;
    }
    onChange([...value, nextItem]);
    setDraft("");
  }, [draft, onChange, value]);

  const updateItem = useCallback((index: number, nextValue: string) => {
    onChange(value.map((item, itemIndex) => (itemIndex === index ? nextValue : item)));
  }, [onChange, value]);

  const removeItem = useCallback((index: number) => {
    onChange(value.filter((_item, itemIndex) => itemIndex !== index));
  }, [onChange, value]);

  return (
    <div className="grid min-w-0 gap-2 text-xs font-medium md:col-span-2">
      <span className="truncate">{label}</span>
      <div className="grid gap-2 rounded-md border border-border bg-muted/25 p-2">
        {value.length > 0 ? (
          value.map((item, index) => (
            <div className="grid grid-cols-[1fr_auto] gap-2" key={`${field.path.join(".")}-${index}`}>
              <Input
                monospace
                onChange={(event) => updateItem(index, event.target.value)}
                value={item}
              />
              <Button
                aria-label={`移除 ${label} 第 ${index + 1} 项`}
                onClick={() => removeItem(index)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            </div>
          ))
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
            暂无条目
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Input
            monospace
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addItem();
              }
            }}
            placeholder="输入后回车添加"
            value={draft}
          />
          <Button disabled={!draft.trim()} onClick={addItem} size="icon-sm" type="button" variant="secondary">
            <Plus className="size-4" />
          </Button>
        </div>
      </div>
      <ConfigFieldHelp description={description} field={field} />
    </div>
  );
}

function JsonConfigField({
  field,
  value,
  onChange,
}: {
  field: PluginConfigState["schema"]["sections"][number]["fields"][number];
  value: PluginConfigValue;
  onChange: (value: PluginConfigValue) => void;
}): React.JSX.Element {
  const label = fieldLabel(field);
  const serialized = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(serialized);
    setError(null);
  }, [serialized]);

  const commit = useCallback((nextText: string) => {
    try {
      const parsed = JSON.parse(nextText) as unknown;
      onChange(normalizeJsonPluginConfigValue(parsed));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [onChange]);

  return (
    <label className="grid min-w-0 gap-1.5 text-xs font-medium md:col-span-2">
      <span className="truncate">{label}</span>
      <textarea
        className="min-h-24 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60"
        onBlur={() => commit(text)}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        value={text}
      />
      {error ? <span className="text-[11px] text-destructive">JSON 格式错误：{error}</span> : null}
    </label>
  );
}

function ConfigFieldHelp({
  field,
  description,
}: {
  field: PluginConfigState["schema"]["sections"][number]["fields"][number];
  description: string;
}): React.JSX.Element {
  const hint = resolveLocalizedText(field.hint, "");
  return (
    <span className="font-mono text-[10px] text-muted-foreground">
      {description ? <span className="mr-2 font-sans">{description}</span> : null}
      {hint ? <span className="mr-2 font-sans">{hint}</span> : null}
      {field.name}
    </span>
  );
}

function fieldLabel(field: PluginConfigState["schema"]["sections"][number]["fields"][number]): string {
  return resolveLocalizedText(field.label, field.name);
}

function fieldDescription(field: PluginConfigState["schema"]["sections"][number]["fields"][number]): string {
  return resolveLocalizedText(field.description, "");
}

function resolveLocalizedText(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value || fallback;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const language = navigator.language.toLowerCase();
  const candidates = [
    language,
    language.split("-")[0],
    language.startsWith("zh") ? "zh-CN" : "",
    language.startsWith("zh") ? "zh" : "",
    "zh-CN",
    "zh",
    "en-US",
    "en",
  ].filter(Boolean);
  for (const key of candidates) {
    const text = record[key];
    if (typeof text === "string" && text.trim()) {
      return text;
    }
  }
  const first = Object.values(record).find((item): item is string => typeof item === "string" && item.trim().length > 0);
  return first ?? fallback;
}

function isChoiceObject(
  choice: NonNullable<PluginConfigState["schema"]["sections"][number]["fields"][number]["choices"]>[number],
): choice is { label?: string | Record<string, string>; value: PluginConfigValue } {
  return choice !== null && typeof choice === "object" && !Array.isArray(choice) && "value" in choice;
}

function choiceValueKey(value: PluginConfigValue): string {
  return JSON.stringify(value);
}

function parseChoiceValue(
  key: string,
  choices: NonNullable<PluginConfigState["schema"]["sections"][number]["fields"][number]["choices"]>,
): PluginConfigValue {
  for (const choice of choices) {
    const value = isChoiceObject(choice) ? choice.value : choice;
    if (choiceValueKey(value) === key) {
      return value;
    }
  }
  return key;
}

function clonePluginConfig(config: Record<string, PluginConfigValue>): Record<string, PluginConfigValue> {
  return JSON.parse(JSON.stringify(config)) as Record<string, PluginConfigValue>;
}

function setPluginConfigValue(
  config: Record<string, PluginConfigValue>,
  path: string[],
  value: PluginConfigValue,
): Record<string, PluginConfigValue> {
  const next = clonePluginConfig(config);
  let cursor: Record<string, PluginConfigValue> = next;
  for (const segment of path.slice(0, -1)) {
    const current = cursor[segment];
    if (!isPluginConfigRecord(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, PluginConfigValue>;
  }
  const last = path.at(-1);
  if (last) {
    cursor[last] = value;
  }
  return next;
}

function getPluginConfigValue(
  config: Record<string, PluginConfigValue>,
  path: string[],
): PluginConfigValue | undefined {
  let cursor: PluginConfigValue | Record<string, PluginConfigValue> = config;
  for (const segment of path) {
    if (!isPluginConfigRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor as PluginConfigValue | undefined;
}

function normalizeJsonPluginConfigValue(value: unknown): PluginConfigValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonPluginConfigValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeJsonPluginConfigValue(item)]),
    );
  }
  return String(value);
}

function isPluginConfigRecord(value: unknown): value is Record<string, PluginConfigValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function OperationDialog({
  operation,
  setOperation,
  busy,
  onConfirm,
  onOpenChange,
}: {
  operation: PendingOperation | null;
  setOperation: (operation: PendingOperation | null) => void;
  busy: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const isDestructive = operation?.kind === "uninstall";
  const title =
    operation?.kind === "install"
      ? "安装插件"
      : operation?.kind === "update"
        ? "更新插件"
        : "卸载插件";
  const description =
    operation?.kind === "install"
      ? "将插件仓库克隆到 MaiBot 插件目录。"
      : operation?.kind === "update"
        ? "会先删除本地旧插件目录，再重新克隆目标分支。"
        : "会删除本地插件目录，此操作不可撤销。";

  return (
    <Dialog open={operation !== null} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader
          description={description}
          icon={isDestructive ? <Trash2 className="size-4" /> : <Wrench className="size-4" />}
          title={title}
          tone={isDestructive ? "danger" : "primary"}
        />
        <DialogBody className="space-y-4">
          {operation ? (
            <>
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">插件</span>
                  <span className="min-w-0 truncate font-semibold">{pluginName(operation.plugin)}</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">ID</span>
                  <code className="min-w-0 truncate">{operation.plugin.id}</code>
                </div>
                {operation.repositoryUrl ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">仓库</span>
                    <code className="min-w-0 truncate">{operation.repositoryUrl}</code>
                  </div>
                ) : null}
                {operation.latestVersion ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">目标版本</span>
                    <code className="min-w-0 truncate">{operation.latestVersion}</code>
                  </div>
                ) : null}
              </div>

              {operation.incompatibleReason ? (
                <div className="rounded-lg border border-warning/40 bg-warning/15 p-3 text-xs leading-relaxed text-warning-foreground">
                  <p className="font-semibold">当前插件声明不支持这个 MaiBot 版本</p>
                  <p className="mt-1">{operation.incompatibleReason}</p>
                  <p className="mt-2">继续操作可能导致插件无法加载或运行异常。</p>
                </div>
              ) : null}

              {operation.kind !== "uninstall" ? (
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium" htmlFor="plugin-branch">
                    分支
                  </label>
                  <Input
                    disabled={busy}
                    id="plugin-branch"
                    onChange={(event) => setOperation({ ...operation, branch: event.target.value })}
                    placeholder="main"
                    value={operation.branch}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={() => setOperation(null)} size="sm" variant="ghost">
            取消
          </Button>
          <Button disabled={busy} onClick={onConfirm} size="sm" variant={isDestructive ? "destructive" : "default"}>
            {busy ? <Loader2 className="animate-spin" /> : isDestructive ? <Trash2 /> : <Wrench />}
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ icon, title }: { icon: React.ReactNode; title: string }): React.JSX.Element {
  return (
    <div className="grid min-h-56 place-items-center rounded-lg border border-border bg-card p-6 text-center">
      <div>
        <span className="mx-auto grid size-12 place-items-center rounded-md bg-secondary text-secondary-foreground">
          {icon}
        </span>
        <p className="mt-3 text-sm font-semibold">{title}</p>
      </div>
    </div>
  );
}
