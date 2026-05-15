import { AlertTriangle, Download, Loader2, Plus, Puzzle, RefreshCw, Save, Search, SlidersHorizontal, Store, Trash2, Upload, Wrench, X } from "lucide-react";
import type { ServiceDescriptor } from "@shared/contracts";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  type PluginConfigState,
  type PluginConfigValue,
  pluginAuthor,
  pluginDescription,
  pluginName,
  pluginNeedsUpdate,
  pluginRepositoryUrl,
  pluginVersion,
  savePluginConfig,
  uninstallMaiBotPlugin,
  updateMaiBotPlugin,
} from "@/lib/maibot-plugin-api";

type PluginPanelMode = "market" | "manage";
type LoadState = "idle" | "loading" | "ready" | "error";
type OperationKind = "install" | "update" | "uninstall";
type ConfigBusyState = "load" | "save" | null;

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

interface CardAction {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  variant?: React.ComponentProps<typeof Button>["variant"];
  onClick: () => void;
}

export function PluginMarketPanel({
  mode,
  onModeChange,
  maibotService,
  maibotVersion,
}: {
  mode: PluginPanelMode;
  onModeChange?: (mode: PluginPanelMode) => void;
  maibotService?: ServiceDescriptor;
  maibotVersion?: string;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [preferCompatible, setPreferCompatible] = useState(true);
  const [marketPlugins, setMarketPlugins] = useState<MarketPlugin[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<InstalledPlugin | null>(null);
  const [configState, setConfigState] = useState<PluginConfigState | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, PluginConfigValue> | null>(null);
  const [configBusy, setConfigBusy] = useState<ConfigBusyState>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const loadPlugins = useCallback(async () => {
    setLoadState("loading");
    setError(null);

    try {
      if (mode === "market") {
        const result = await fetchMarketPlugins(maibotService);
        setInstalledPlugins(result.installed);
        setMarketPlugins(result.market);
      } else {
        const installed = await fetchInstalledPlugins(maibotService);
        setInstalledPlugins(installed);
        setLoadState("ready");
        void fetchMarketPlugins(maibotService)
          .then((marketResult) => {
            setMarketPlugins(marketResult.market);
          })
          .catch(() => {
            setMarketPlugins([]);
          });
        return;
      }
      setLoadState("ready");
    } catch (nextError) {
      setLoadState("error");
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [maibotService, mode]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

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
      const state = await fetchPluginConfig(plugin.id);
      setConfigState(state);
      setConfigDraft(clonePluginConfig(state.config));
    } catch (nextError) {
      setConfigError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setConfigBusy(null);
    }
  }, []);

  const saveOpenPluginConfig = useCallback(async () => {
    if (!configPlugin || !configDraft) {
      return;
    }

    setConfigBusy("save");
    setConfigError(null);
    try {
      const result = await savePluginConfig(configPlugin.id, configDraft);
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
    } catch (nextError) {
      setConfigError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setConfigBusy(null);
    }
  }, [configDraft, configPlugin, loadPlugins]);

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
    () => sortMarketPlugins(filterPlugins(marketPlugins, query), preferCompatible, maibotVersion),
    [maibotVersion, marketPlugins, preferCompatible, query],
  );
  const filteredInstalled = useMemo(() => filterPlugins(installedViews, query), [installedViews, query]);
  const isMarket = mode === "market";
  const title = isMarket ? "插件商店" : "插件管理";
  const description = isMarket ? "浏览 MaiBot 插件市场，安装或更新插件。" : "查看已安装插件，执行更新与卸载。";

  return (
    <>
      <div className="h-full overflow-auto bg-background px-5 py-4">
        <div className="mx-auto grid max-w-6xl gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <div className="flex items-center gap-2">
              {onModeChange ? (
                <div className="flex h-8 items-center rounded-lg border border-border bg-muted/60 p-1">
                  <button
                    className={[
                      "inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                      isMarket
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                    onClick={() => onModeChange("market")}
                    type="button"
                  >
                    <Store className="size-3.5" />
                    商店
                  </button>
                  <button
                    className={[
                      "inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                      !isMarket
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                    onClick={() => onModeChange("manage")}
                    type="button"
                  >
                    <Puzzle className="size-3.5" />
                    管理
                  </button>
                </div>
              ) : null}
              <Button disabled={loadState === "loading"} onClick={() => void loadPlugins()} size="sm" variant="secondary">
                {loadState === "loading" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                刷新
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card p-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isMarket ? "搜索插件商店" : "搜索已安装插件"}
              value={query}
            />
            <Badge variant="secondary">{isMarket ? filteredMarket.length : filteredInstalled.length}</Badge>
          </div>

          {isMarket ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs">
              <label className="flex items-center gap-2 text-muted-foreground">
                <Checkbox
                  checked={preferCompatible}
                  onCheckedChange={(checked) => setPreferCompatible(checked === true)}
                />
                优先显示支持当前 MaiBot 版本的插件
              </label>
              <span className="text-muted-foreground">
                当前版本：<span className="font-mono text-foreground">{maibotVersion ?? "未知"}</span>
              </span>
            </div>
          ) : null}

          {loadState === "error" ? <ErrorPanel error={error} isMarket={isMarket} /> : null}

          {loadState === "loading" && (isMarket ? marketPlugins.length === 0 : installedPlugins.length === 0) ? (
            <div className="grid min-h-56 place-items-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                正在读取插件数据
              </span>
            </div>
          ) : isMarket ? (
            <PluginGrid maibotVersion={maibotVersion} onOperate={beginOperation} plugins={filteredMarket} />
          ) : (
            <InstalledGrid
              maibotVersion={maibotVersion}
              onConfigure={openPluginConfig}
              onOperate={beginOperation}
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
        onSave={() => void saveOpenPluginConfig()}
        plugin={configPlugin}
        state={configState}
      />
    </>
  );
}

function filterPlugins<T extends { id: string; manifest: MarketPlugin["manifest"] }>(plugins: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return plugins;
  }
  return plugins.filter((plugin) => {
    const haystack = [
      plugin.id,
      plugin.manifest.name,
      plugin.manifest.description,
      pluginAuthor(plugin.manifest),
      ...(plugin.manifest.keywords ?? []),
      ...(plugin.manifest.categories ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function sortMarketPlugins(
  plugins: MarketPlugin[],
  preferCompatible: boolean,
  maibotVersion: string | undefined,
): MarketPlugin[] {
  if (!preferCompatible || !maibotVersion) {
    return plugins;
  }

  return [...plugins].sort((left, right) => {
    const leftCompatible = isPluginCompatible(left.manifest, maibotVersion);
    const rightCompatible = isPluginCompatible(right.manifest, maibotVersion);
    if (leftCompatible !== rightCompatible) {
      return leftCompatible ? -1 : 1;
    }
    return pluginName(left).localeCompare(pluginName(right), "zh-CN");
  });
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
  onOperate,
  maibotVersion,
}: {
  plugins: MarketPlugin[];
  onOperate: (operation: PendingOperation) => void;
  maibotVersion?: string;
}): React.JSX.Element {
  if (plugins.length === 0) {
    return <EmptyState icon={<Download />} title="没有匹配的插件" />;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {plugins.map((plugin) => {
        const repositoryUrl = pluginRepositoryUrl(plugin.manifest);
        const incompatibleReason = getPluginCompatibilityReason(plugin.manifest, maibotVersion);
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
            plugin={plugin}
            status={plugin.installed ? `本地 ${plugin.installedVersion ?? "-"}` : undefined}
          />
        );
      })}
    </div>
  );
}

function InstalledGrid({
  plugins,
  onOperate,
  onConfigure,
  maibotVersion,
}: {
  plugins: InstalledPluginView[];
  onOperate: (operation: PendingOperation) => void;
  onConfigure: (plugin: InstalledPlugin) => void;
  maibotVersion?: string;
}): React.JSX.Element {
  if (plugins.length === 0) {
    return <EmptyState icon={<Puzzle />} title="没有已安装插件" />;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
                icon: <SlidersHorizontal />,
                variant: "secondary",
                onClick: () => onConfigure(plugin),
              },
              {
                label: updateLabel,
                icon: <Upload />,
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
                variant: "outline",
                onClick: () => onOperate({ kind: "uninstall", plugin, branch: "main" }),
              },
            ]}
            compatibilityReason={incompatibleReason}
            key={`${plugin.id}:${plugin.path}`}
            plugin={plugin}
            status={
              plugin.updateAvailable && updatePlugin
                ? `${pluginVersion(plugin.manifest)} -> ${pluginVersion(updatePlugin.manifest)}`
                : (plugin.load_status ?? (plugin.enabled === false ? "disabled" : "unknown"))
            }
          />
        );
      })}
    </div>
  );
}

function PluginCard({
  plugin,
  status,
  actions,
  compatibilityReason,
}: {
  plugin: { id: string; manifest: MarketPlugin["manifest"] };
  status?: string;
  actions: CardAction[];
  compatibilityReason?: string | null;
}): React.JSX.Element {
  return (
    <div className="flex min-h-44 flex-col rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" title={pluginName(plugin)}>
            {pluginName(plugin)}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            v{pluginVersion(plugin.manifest)} · {pluginAuthor(plugin.manifest)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {status ? <Badge variant="outline">{status}</Badge> : null}
          {compatibilityReason ? <Badge variant="warning">不兼容</Badge> : <Badge variant="success">兼容</Badge>}
        </div>
      </div>
      {compatibilityReason ? (
        <p className="mt-2 rounded-md bg-warning/15 px-2 py-1 text-[11px] leading-relaxed text-warning-foreground">
          {compatibilityReason}
        </p>
      ) : null}
      <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
        {pluginDescription(plugin.manifest)}
      </p>
      <div className="mt-3 flex flex-wrap gap-1">
        {(plugin.manifest.categories ?? plugin.manifest.keywords ?? []).slice(0, 3).map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
          {plugin.id}
        </code>
        <div className="flex shrink-0 items-center gap-1">
          {actions.map((action) => (
            <Button disabled={action.disabled} key={action.label} onClick={action.onClick} size="sm" variant={action.variant ?? "secondary"}>
              {action.icon}
              {action.label}
            </Button>
          ))}
        </div>
      </div>
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

  return (
    <Dialog open={plugin !== null} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader
          description={plugin ? `${plugin.id} · ${state?.configPath ?? "config.toml"}` : undefined}
          icon={<SlidersHorizontal className="size-4" />}
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
            sections.length > 0 ? (
              <div className="grid gap-3">
                {sections.map((section) => (
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
          <Button disabled={busy !== null} onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            关闭
          </Button>
          <Button disabled={busy !== null || !draft || !state} onClick={onSave} size="sm">
            {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}
            保存配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{section.title}</p>
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
  if (typeof value === "boolean") {
    return (
      <label className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/35 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{field.label}</span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">{field.name}</span>
        </span>
        <Checkbox checked={value} onCheckedChange={(checked) => onChange(field.path, checked === true)} />
      </label>
    );
  }

  if (typeof value === "number") {
    return (
      <label className="grid min-w-0 gap-1.5 text-xs font-medium">
        <span className="truncate">{field.label}</span>
        <Input
          inputMode="decimal"
          monospace
          onChange={(event) => {
            const nextValue = Number(event.target.value);
            onChange(field.path, Number.isFinite(nextValue) ? nextValue : 0);
          }}
          type="number"
          value={String(value)}
        />
      </label>
    );
  }

  if (typeof value === "string") {
    return (
      <label className="grid min-w-0 gap-1.5 text-xs font-medium">
        <span className="truncate">{field.label}</span>
        <Input
          monospace
          onChange={(event) => onChange(field.path, event.target.value)}
          value={value}
        />
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
      <span className="truncate">{field.label}</span>
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
                aria-label={`移除 ${field.label} 第 ${index + 1} 项`}
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
      <span className="font-mono text-[10px] text-muted-foreground">{field.name}</span>
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
      <span className="truncate">{field.label}</span>
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
