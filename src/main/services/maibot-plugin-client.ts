import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type {
  MaiBotPluginConfigSaveResult,
  MaiBotPluginConfigSchema,
  MaiBotPluginConfigState,
  MaiBotPluginConfigValue,
  MaiBotInstalledPlugin,
  MaiBotPluginListOptions,
  MaiBotMarketPlugin,
  MaiBotPluginListResult,
  MaiBotPluginManifest,
  MaiBotPluginOperationResult,
  MaiBotPluginReadmeResult,
  MaiBotPluginStats,
} from "../../shared/contracts";

const MARKET_URL =
  "https://raw.githubusercontent.com/Mai-with-u/plugin-repo/main/plugin_details.json";
const PLUGIN_STATS_URL = process.env.MAIBOT_PLUGIN_STATS_BASE_URL
  ? `${process.env.MAIBOT_PLUGIN_STATS_BASE_URL.replace(/\/+$/u, "")}/stats/summary`
  : "http://hyybuth.xyz:10059/stats/summary";
const PLUGIN_STATS_BASE_URL = process.env.MAIBOT_PLUGIN_STATS_BASE_URL?.replace(/\/+$/u, "") ?? "http://hyybuth.xyz:10059";
const MARKET_TIMEOUT_MS = 10_000;
const MAIBOT_API_TIMEOUT_MS = 3_000;
const PLUGIN_MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
const PLUGIN_CONFIG_FILE = "config.toml";

export interface MaiBotPluginClientOptions {
  maibotRoot: string;
  gitPath: string;
}

interface GitRunResult {
  exitCode: number;
  output: string;
}

interface CacheFile<T> {
  timestamp: number;
  data: T;
}

export class MaiBotPluginClient {
  private readonly maibotRoot: string;

  private readonly pluginsRoot: string;

  private readonly gitPath: string;

  private marketCache: CacheFile<MaiBotMarketPlugin[]> | null = null;

  private marketRequest: Promise<MaiBotMarketPlugin[]> | null = null;

  private statsCache: CacheFile<Record<string, MaiBotPluginStats>> | null = null;

  private statsRequest: Promise<Record<string, MaiBotPluginStats>> | null = null;

  constructor(options: MaiBotPluginClientOptions) {
    this.maibotRoot = resolve(options.maibotRoot);
    this.pluginsRoot = resolve(this.maibotRoot, "plugins");
    this.gitPath = options.gitPath;
  }

  async listInstalled(serviceUrl?: string): Promise<MaiBotInstalledPlugin[]> {
    const runtimePlugins = await this.listRuntimeInstalled(serviceUrl);
    if (runtimePlugins) {
      return runtimePlugins;
    }

    await mkdir(this.pluginsRoot, { recursive: true });
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(this.pluginsRoot, { withFileTypes: true }),
    );
    const plugins: MaiBotInstalledPlugin[] = [];
    const seenIds = new Set<string>();

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("__")) {
        continue;
      }

      const pluginPath = this.safePluginPath(entry.name, false);
      const manifest = await this.readManifest(pluginPath);
      if (!manifest?.name || !manifest.version) {
        continue;
      }

      const id = inferPluginId(entry.name, manifest);
      if (seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      const config = await this.readPluginConfig(pluginPath).catch(() => ({}));
      const enabled = readPluginEnabled(config);

      plugins.push({
        id,
        manifest: { ...manifest, id },
        path: pluginPath,
        enabled,
        loaded: undefined,
        load_status: enabled ? "inactive" : "disabled",
      });
    }

    return plugins.sort((left, right) => pluginName(left).localeCompare(pluginName(right), "zh-CN"));
  }

  async listMarket(serviceUrl?: string, options: MaiBotPluginListOptions = {}): Promise<MaiBotPluginListResult> {
    const installed = await this.listInstalled(serviceUrl);
    const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
    const [sourceList, stats] = await Promise.all([
      this.getMarketPlugins(options),
      this.getPluginStatsSummary(options).catch(() => ({})),
    ]);
    const market = sourceList
      .map((plugin) => {
        const installedPlugin = installedById.get(plugin.id);
        const statsItem = resolvePluginStats(plugin, stats);
        return {
          ...plugin,
          installed: Boolean(installedPlugin),
          installedVersion: installedPlugin ? pluginVersion(installedPlugin.manifest) : undefined,
          downloads: statsItem?.downloads ?? plugin.downloads,
          rating: statsItem?.rating ?? plugin.rating,
          likes: statsItem?.likes ?? plugin.likes,
        };
      });

    return { installed, market, stats };
  }

  async install(pluginId: string, repositoryUrl: string, branch = "main"): Promise<MaiBotPluginOperationResult> {
    const targetPath = this.installTargetPath(pluginId);
    if (await pathExists(targetPath)) {
      throw new Error("插件已安装，请先卸载");
    }

    await this.cloneRepository(repositoryUrl, targetPath, branch);
    const manifest = await this.validateInstalledManifest(targetPath, pluginId);
    return {
      success: true,
      message: "插件安装成功",
      plugin_id: pluginId,
      plugin_name: pluginName({ id: pluginId, manifest }),
      new_version: pluginVersion(manifest),
    };
  }

  async update(
    pluginId: string,
    repositoryUrl: string,
    branch = "main",
    latestVersion?: string,
  ): Promise<MaiBotPluginOperationResult> {
    const pluginPath = await this.resolveInstalledPluginPath(pluginId);
    if (!pluginPath) {
      throw new Error("插件未安装，请先安装");
    }

    const oldManifest = await this.readManifest(pluginPath);
    const oldVersion = oldManifest ? pluginVersion(oldManifest) : "unknown";
    if (latestVersion && !isNewerVersion(latestVersion, oldVersion)) {
      throw new Error("当前已是最新版本，无需更新");
    }
    await this.removePluginPath(pluginPath);
    await this.cloneRepository(repositoryUrl, pluginPath, branch);
    const newManifest = await this.validateInstalledManifest(pluginPath, pluginId);

    return {
      success: true,
      message: "插件更新成功",
      plugin_id: pluginId,
      plugin_name: pluginName({ id: pluginId, manifest: newManifest }),
      old_version: oldVersion,
      new_version: pluginVersion(newManifest),
    };
  }

  async uninstall(pluginId: string): Promise<MaiBotPluginOperationResult> {
    const pluginPath = await this.resolveInstalledPluginPath(pluginId);
    if (!pluginPath) {
      throw new Error("插件未安装");
    }

    const manifest = await this.readManifest(pluginPath);
    await this.removePluginPath(pluginPath);
    return {
      success: true,
      message: "插件卸载成功",
      plugin_id: pluginId,
      plugin_name: manifest ? pluginName({ id: pluginId, manifest }) : pluginId,
    };
  }

  async getConfig(pluginId: string): Promise<MaiBotPluginConfigState> {
    const pluginPath = await this.requireInstalledPluginPath(pluginId);
    const configPath = resolve(pluginPath, PLUGIN_CONFIG_FILE);
    if (!isPathInside(pluginPath, configPath)) {
      throw new Error("插件配置路径超出允许范围");
    }

    const exists = await pathExists(configPath);
    const raw = exists ? await readFile(configPath, "utf8") : "";
    const config = exists ? parsePluginConfig(raw, configPath) : {};

    return {
      pluginId,
      pluginPath,
      configPath,
      exists,
      config,
      schema: buildPluginConfigSchema(config),
      raw,
    };
  }

  async saveConfig(
    pluginId: string,
    config: Record<string, MaiBotPluginConfigValue>,
  ): Promise<MaiBotPluginConfigSaveResult> {
    const pluginPath = await this.requireInstalledPluginPath(pluginId);
    const configPath = resolve(pluginPath, PLUGIN_CONFIG_FILE);
    if (!isPathInside(pluginPath, configPath)) {
      throw new Error("插件配置路径超出允许范围");
    }

    const normalizedConfig = normalizePluginConfigRootForToml(config);
    let backupPath: string | undefined;
    if (await pathExists(configPath)) {
      backupPath = `${configPath}.${new Date().toISOString().replace(/[:.]/gu, "-")}.bak`;
      await copyFile(configPath, backupPath);
    }

    const raw = `${stringifyToml(normalizedConfig)}\n`;
    await mkdir(pluginPath, { recursive: true });
    await writeFile(configPath, raw, "utf8");

    return {
      pluginId,
      configPath,
      config: normalizedConfig,
      schema: buildPluginConfigSchema(normalizedConfig),
      raw,
      backupPath,
      savedAt: Date.now(),
    };
  }

  async getReadme(pluginId: string, repositoryUrl?: string): Promise<MaiBotPluginReadmeResult> {
    const pluginPath = await this.resolveInstalledPluginPath(pluginId);
    if (pluginPath) {
      for (const readmeName of ["README.md", "readme.md", "Readme.md", "README.MD"]) {
        const readmePath = resolve(pluginPath, readmeName);
        if (!isPathInside(pluginPath, readmePath) || !(await pathExists(readmePath))) {
          continue;
        }
        try {
          return { success: true, content: await readFile(readmePath, "utf8") };
        } catch {
          // Try the next known README casing.
        }
      }
    }

    const remoteUrl = repositoryUrl ? githubRawReadmeUrl(repositoryUrl) : undefined;
    if (!remoteUrl) {
      return { success: false, error: "未找到插件 README" };
    }

    for (const branch of ["main", "master"]) {
      const response = await fetchWithTimeout(remoteUrl(branch)).catch(() => null);
      if (response?.ok) {
        return { success: true, content: await response.text() };
      }
    }
    return { success: false, error: "未找到插件 README" };
  }

  async getStats(pluginId: string): Promise<MaiBotPluginStats | null> {
    const response = await fetchWithTimeout(`${PLUGIN_STATS_BASE_URL}/stats/${encodeURIComponent(pluginId)}`).catch(() => null);
    if (!response?.ok) {
      return null;
    }
    const data = (await response.json()) as unknown;
    return normalizePluginStatsDetail(pluginId, data);
  }

  private installTargetPath(pluginId: string): string {
    return this.safePluginPath(validatePluginId(pluginId).replace(/\./gu, "_"), false);
  }

  private async resolveInstalledPluginPath(pluginId: string): Promise<string | null> {
    const normalizedId = validatePluginId(pluginId);
    const directCandidates = [
      this.safePluginPath(normalizedId.replace(/\./gu, "_"), false),
      this.safePluginPath(normalizedId, false),
    ];

    for (const candidate of directCandidates) {
      if (await isDirectory(candidate)) {
        return candidate;
      }
    }

    const installed = await this.listInstalled();
    return installed.find((plugin) => plugin.id === normalizedId)?.path ?? null;
  }

  private async requireInstalledPluginPath(pluginId: string): Promise<string> {
    const pluginPath = await this.resolveInstalledPluginPath(pluginId);
    if (!pluginPath) {
      throw new Error("插件未安装");
    }
    return pluginPath;
  }

  private async readPluginConfig(pluginPath: string): Promise<Record<string, MaiBotPluginConfigValue>> {
    const configPath = resolve(pluginPath, PLUGIN_CONFIG_FILE);
    if (!isPathInside(pluginPath, configPath) || !(await pathExists(configPath))) {
      return {};
    }
    return parsePluginConfig(await readFile(configPath, "utf8"), configPath);
  }

  private async getMarketPlugins(options: MaiBotPluginListOptions): Promise<MaiBotMarketPlugin[]> {
    const cached = await this.readCache(
      "onekey-plugin-market-list-cache.json",
      this.marketCache,
      isMarketPluginList,
    );
    if (!options.forceRefresh && cached && Date.now() - cached.timestamp < PLUGIN_MARKET_CACHE_TTL_MS) {
      this.marketCache = cached;
      return cached.data;
    }

    if (!this.marketRequest || options.forceRefresh) {
      this.marketRequest = fetchMarketPluginsUncached()
        .then(async (plugins) => {
          const nextCache = { timestamp: Date.now(), data: plugins };
          this.marketCache = nextCache;
          await this.writeCache("onekey-plugin-market-list-cache.json", nextCache);
          return plugins;
        })
        .catch((error) => {
          if (cached) {
            return cached.data;
          }
          throw error;
        })
        .finally(() => {
          this.marketRequest = null;
        });
    }

    return this.marketRequest;
  }

  private async getPluginStatsSummary(options: MaiBotPluginListOptions): Promise<Record<string, MaiBotPluginStats>> {
    const cached = await this.readCache(
      "onekey-plugin-market-stats-cache.json",
      this.statsCache,
      isPluginStatsMap,
    );
    if (!options.forceRefresh && cached && Date.now() - cached.timestamp < PLUGIN_MARKET_CACHE_TTL_MS) {
      this.statsCache = cached;
      return cached.data;
    }

    if (!this.statsRequest || options.forceRefresh) {
      this.statsRequest = fetchPluginStatsSummary()
        .then(async (stats) => {
          const nextCache = { timestamp: Date.now(), data: stats };
          this.statsCache = nextCache;
          await this.writeCache("onekey-plugin-market-stats-cache.json", nextCache);
          return stats;
        })
        .catch((error) => {
          if (cached) {
            return cached.data;
          }
          throw error;
        })
        .finally(() => {
          this.statsRequest = null;
        });
    }

    return this.statsRequest;
  }

  private async readCache<T>(
    fileName: string,
    memoryCache: CacheFile<T> | null,
    validate: (value: unknown) => value is T,
  ): Promise<CacheFile<T> | null> {
    if (memoryCache) {
      return memoryCache;
    }

    const cachePath = this.cachePath(fileName);
    try {
      const raw = JSON.parse(await readFile(cachePath, "utf8")) as Partial<CacheFile<unknown>>;
      if (typeof raw.timestamp !== "number" || !validate(raw.data)) {
        return null;
      }
      return { timestamp: raw.timestamp, data: raw.data };
    } catch {
      return null;
    }
  }

  private async writeCache<T>(fileName: string, cache: CacheFile<T>): Promise<void> {
    const cachePath = this.cachePath(fileName);
    await mkdir(resolve(this.maibotRoot, "data"), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8").catch(() => undefined);
  }

  private cachePath(fileName: string): string {
    const cachePath = resolve(this.maibotRoot, "data", fileName);
    if (!isPathInside(this.maibotRoot, cachePath)) {
      throw new Error("插件市场缓存路径超出允许范围");
    }
    return cachePath;
  }

  private async cloneRepository(repositoryUrl: string, targetPath: string, branch: string): Promise<void> {
    await mkdir(this.pluginsRoot, { recursive: true });
    const args = ["clone", "--depth", "1", "--branch", branch || "main", repositoryUrl, targetPath];
    const result = await runGit(this.gitPath, args, this.maibotRoot);
    if (result.exitCode !== 0) {
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(result.output || "克隆仓库失败");
    }
  }

  private async validateInstalledManifest(pluginPath: string, pluginId: string): Promise<MaiBotPluginManifest> {
    const manifest = await this.readManifest(pluginPath);
    if (!manifest) {
      await rm(pluginPath, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("无效的插件：缺少 _manifest.json");
    }

    for (const field of ["name", "version", "author"]) {
      if (!(field in manifest)) {
        await rm(pluginPath, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(`无效的 _manifest.json：缺少必需字段 ${field}`);
      }
    }

    return { ...manifest, id: manifest.id?.trim() || pluginId };
  }

  private async readManifest(pluginPath: string): Promise<MaiBotPluginManifest | null> {
    const manifestPath = resolve(pluginPath, "_manifest.json");
    if (!isPathInside(pluginPath, manifestPath)) {
      return null;
    }

    try {
      return JSON.parse(await readFile(manifestPath, "utf8")) as MaiBotPluginManifest;
    } catch {
      return null;
    }
  }

  private async listRuntimeInstalled(serviceUrl?: string): Promise<MaiBotInstalledPlugin[] | null> {
    const apiUrl = maibotApiUrl(serviceUrl, "/api/webui/plugins/installed");
    if (!apiUrl) {
      return null;
    }

    try {
      const response = await fetchWithTimeout(apiUrl, MAIBOT_API_TIMEOUT_MS, {
        headers: await this.maibotRuntimeAuthHeaders(serviceUrl),
      });
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as unknown;
      if (!isUnknownRecord(data) || data.success !== true || !Array.isArray(data.plugins)) {
        return null;
      }

      const plugins = data.plugins
        .map(normalizeInstalledPlugin)
        .filter((plugin): plugin is MaiBotInstalledPlugin => plugin !== null);
      return plugins.sort((left, right) => pluginName(left).localeCompare(pluginName(right), "zh-CN"));
    } catch {
      return null;
    }
  }

  private async maibotRuntimeAuthHeaders(serviceUrl?: string): Promise<HeadersInit> {
    const token = tokenFromServiceUrl(serviceUrl) ?? (await this.readMaiBotWebUiToken());
    return token ? { Cookie: `maibot_session=${encodeURIComponent(token)}` } : {};
  }

  private async readMaiBotWebUiToken(): Promise<string | null> {
    const configPath = resolve(this.maibotRoot, "data", "webui.json");
    if (!isPathInside(this.maibotRoot, configPath)) {
      return null;
    }

    try {
      const raw = JSON.parse(await readFile(configPath, "utf8")) as { access_token?: unknown };
      return typeof raw.access_token === "string" && raw.access_token.length > 0 ? raw.access_token : null;
    } catch {
      return null;
    }
  }

  private async removePluginPath(pluginPath: string): Promise<void> {
    const safePath = this.safePluginPath(basename(pluginPath), true);
    await rm(safePath, { recursive: true, force: true });
  }

  private safePluginPath(folderName: string, mustExist: boolean): string {
    if (!folderName || folderName.includes("..") || /[\\/\0\r\n\t]/u.test(folderName)) {
      throw new Error("插件 ID 包含非法字符");
    }

    const targetPath = resolve(this.pluginsRoot, folderName);
    if (!isPathInside(this.pluginsRoot, targetPath)) {
      throw new Error("插件路径超出允许范围");
    }
    if (mustExist && targetPath === this.pluginsRoot) {
      throw new Error("拒绝操作插件根目录");
    }
    return targetPath;
  }
}

function normalizeMarketPlugin(raw: unknown): MaiBotMarketPlugin | null {
  if (!raw || typeof raw !== "object" || !("manifest" in raw)) {
    return null;
  }

  const item = raw as {
    id?: string;
    manifest?: MaiBotPluginManifest;
    source?: string;
    downloads?: unknown;
    rating?: unknown;
    likes?: unknown;
  };
  const manifest = item.manifest;
  const id = manifest?.id?.trim() || item.id?.trim();
  if (!manifest || !id || !manifest.name || !manifest.version) {
    return null;
  }

  return {
    id,
    manifest: { ...manifest, id },
    source: item.source,
    downloads: normalizeStatsNumber(item.downloads),
    rating: normalizeStatsNumber(item.rating),
    likes: normalizeStatsNumber(item.likes),
  };
}

function normalizeInstalledPlugin(raw: unknown): MaiBotInstalledPlugin | null {
  if (!isUnknownRecord(raw) || !isUnknownRecord(raw.manifest)) {
    return null;
  }

  const manifest = raw.manifest as MaiBotPluginManifest;
  const id = String(raw.id ?? manifest.id ?? "").trim();
  if (!id || !manifest.name || !manifest.version) {
    return null;
  }

  return {
    id,
    manifest: { ...manifest, id: manifest.id?.trim() || id },
    path: typeof raw.path === "string" ? raw.path : "",
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : typeof raw.disabled === "boolean" ? !raw.disabled : true,
    loaded: typeof raw.loaded === "boolean" ? raw.loaded : undefined,
    load_status: typeof raw.load_status === "string" ? raw.load_status : undefined,
  };
}

async function fetchMarketPluginsUncached(): Promise<MaiBotMarketPlugin[]> {
  const response = await fetchWithTimeout(MARKET_URL);
  if (!response.ok) {
    throw new Error(`Plugin market list failed: HTTP ${response.status}`);
  }

  const rawList = (await response.json()) as unknown;
  const sourceList = Array.isArray(rawList) ? rawList : [];
  return sourceList
    .map(normalizeMarketPlugin)
    .filter((plugin): plugin is MaiBotMarketPlugin => plugin !== null);
}

async function fetchPluginStatsSummary(): Promise<Record<string, MaiBotPluginStats>> {
  const response = await fetchWithTimeout(PLUGIN_STATS_URL);
  if (!response.ok) {
    return {};
  }

  const data = (await response.json()) as unknown;
  if (!isUnknownRecord(data) || data.success !== true || !isUnknownRecord(data.stats)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(data.stats)
      .map(([pluginId, rawStats]) => normalizePluginStats(pluginId, rawStats))
      .filter((entry): entry is [string, MaiBotPluginStats] => entry !== null),
  );
}

function isMarketPluginList(value: unknown): value is MaiBotMarketPlugin[] {
  return Array.isArray(value) && value.every((item) => normalizeMarketPlugin(item) !== null);
}

function isPluginStatsMap(value: unknown): value is Record<string, MaiBotPluginStats> {
  if (!isUnknownRecord(value)) {
    return false;
  }
  return Object.entries(value).every(([pluginId, stats]) => normalizePluginStats(pluginId, stats) !== null);
}

function normalizePluginStats(pluginId: string, rawStats: unknown): [string, MaiBotPluginStats] | null {
  if (!isUnknownRecord(rawStats)) {
    return null;
  }

  const normalizedId = String(rawStats.plugin_id ?? pluginId);
  return [
    pluginId,
    {
      plugin_id: normalizedId,
      likes: normalizeStatsNumber(rawStats.likes) ?? 0,
      dislikes: normalizeStatsNumber(rawStats.dislikes) ?? 0,
      downloads: normalizeStatsNumber(rawStats.downloads) ?? 0,
      rating: normalizeStatsNumber(rawStats.rating) ?? 0,
      rating_count: normalizeStatsNumber(rawStats.rating_count) ?? 0,
      recent_ratings: normalizePluginRatings(rawStats.recent_ratings),
    },
  ];
}

function normalizePluginStatsDetail(pluginId: string, rawData: unknown): MaiBotPluginStats | null {
  if (!isUnknownRecord(rawData)) {
    return null;
  }
  const rawStats = isUnknownRecord(rawData.stats) ? rawData.stats : rawData;
  const normalized = normalizePluginStats(pluginId, rawStats);
  return normalized?.[1] ?? null;
}

function normalizePluginRatings(rawRatings: unknown): MaiBotPluginStats["recent_ratings"] {
  if (!Array.isArray(rawRatings)) {
    return undefined;
  }
  return rawRatings
    .filter(isUnknownRecord)
    .map((rating) => ({
      user_id: String(rating.user_id ?? "匿名用户"),
      rating: normalizeStatsNumber(rating.rating) ?? 0,
      comment: typeof rating.comment === "string" ? rating.comment : undefined,
      created_at: String(rating.created_at ?? ""),
    }))
    .filter((rating) => rating.rating > 0 || rating.comment);
}

function githubRawReadmeUrl(repositoryUrl: string): ((branch: string) => string) | undefined {
  const match = repositoryUrl.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#]|$)/iu);
  if (!match) {
    return undefined;
  }
  const [, owner, repo] = match;
  return (branch: string) => `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`;
}

function resolvePluginStats(
  plugin: { id: string; manifest: MaiBotPluginManifest },
  stats: Record<string, MaiBotPluginStats>,
): MaiBotPluginStats | undefined {
  const statsIds = [plugin.manifest.id, plugin.id].filter((id): id is string => Boolean(id));
  return statsIds.map((id) => stats[id]).find(Boolean);
}

function normalizeStatsNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function inferPluginId(folderName: string, manifest: MaiBotPluginManifest): string {
  if (manifest.id?.trim()) {
    return manifest.id.trim();
  }

  const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
  const repository = manifest.repository_url?.trim() || manifest.urls?.repository?.trim();
  const repoName = repository ? basename(repository.replace(/\.git$/iu, "")) : undefined;
  if (author && repoName) {
    return `${author}.${repoName}`;
  }
  if (author) {
    return `${author}.${folderName}`;
  }
  return folderName.includes("_") && !folderName.includes(".") ? folderName.replace("_", ".") : folderName;
}

function validatePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!normalized || normalized.startsWith(".") || normalized.endsWith(".")) {
    throw new Error("插件 ID 不能为空，且不能以点开头或结尾");
  }
  if ([".", ".."].includes(normalized) || /[\\/\0\r\n\t]/u.test(normalized) || normalized.includes("..")) {
    throw new Error("插件 ID 包含非法字符");
  }
  return normalized;
}

function pluginName(plugin: { id: string; manifest: MaiBotPluginManifest }): string {
  return plugin.manifest.name?.trim() || plugin.id;
}

function pluginVersion(manifest: MaiBotPluginManifest): string {
  return manifest.version?.trim() || "unknown";
}

function parsePluginConfig(raw: string, configPath: string): Record<string, MaiBotPluginConfigValue> {
  try {
    return normalizePluginConfigRoot(parseToml(raw));
  } catch (error) {
    throw new Error(`TOML 配置解析失败: ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readPluginEnabled(config: Record<string, MaiBotPluginConfigValue>): boolean {
  const pluginSection = config.plugin;
  if (!isConfigRecord(pluginSection)) {
    return true;
  }
  const enabled = pluginSection.enabled;
  if (typeof enabled === "string") {
    const normalized = enabled.trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
  }
  return typeof enabled === "boolean" ? enabled : true;
}

function normalizePluginConfigRoot(value: unknown): Record<string, MaiBotPluginConfigValue> {
  if (!isUnknownRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizePluginConfigValue(item)]),
  );
}

function normalizePluginConfigValue(value: unknown): MaiBotPluginConfigValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizePluginConfigValue);
  }
  if (isUnknownRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizePluginConfigValue(item)]),
    );
  }
  return String(value);
}

function normalizePluginConfigRootForToml(
  value: Record<string, MaiBotPluginConfigValue>,
): Record<string, MaiBotPluginConfigValue> {
  if (!isUnknownRecord(value)) {
    throw new Error("插件配置必须是对象");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizePluginConfigValueForToml(item, key)]),
  );
}

function normalizePluginConfigValueForToml(value: MaiBotPluginConfigValue, path: string): MaiBotPluginConfigValue {
  if (value === null) {
    throw new Error(`TOML 不支持 null: ${path}`);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`数字配置无效: ${path}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizePluginConfigValueForToml(item, `${path}.${index}`));
  }
  if (isConfigRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizePluginConfigValueForToml(item, `${path}.${key}`),
      ]),
    );
  }
  throw new Error(`插件配置值不受支持: ${path}`);
}

function buildPluginConfigSchema(config: Record<string, MaiBotPluginConfigValue>): MaiBotPluginConfigSchema {
  const generalFields = Object.entries(config)
    .filter(([, value]) => !isConfigRecord(value) || Array.isArray(value))
    .map(([key, value]) => buildPluginConfigField([key], key, value));

  const sections = Object.entries(config)
    .filter(([, value]) => isConfigRecord(value) && !Array.isArray(value))
    .map(([sectionName, sectionValue]) => ({
      name: sectionName,
      title: labelFromKey(sectionName),
      fields: Object.entries(sectionValue as Record<string, MaiBotPluginConfigValue>).map(([fieldName, fieldValue]) =>
        buildPluginConfigField([sectionName, fieldName], fieldName, fieldValue),
      ),
    }));

  if (generalFields.length > 0) {
    sections.unshift({
      name: "general",
      title: "常规",
      fields: generalFields,
    });
  }

  return { sections };
}

function buildPluginConfigField(path: string[], name: string, value: MaiBotPluginConfigValue): MaiBotPluginConfigSchema["sections"][number]["fields"][number] {
  return {
    name,
    label: labelFromKey(name),
    path,
    type: pluginConfigValueType(value),
    value,
  };
}

function pluginConfigValueType(value: MaiBotPluginConfigValue): MaiBotPluginConfigSchema["sections"][number]["fields"][number]["type"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isConfigRecord(value)) return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function labelFromKey(value: string): string {
  return value
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    || value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isConfigRecord(value: unknown): value is Record<string, MaiBotPluginConfigValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = normalizeVersion(candidate);
  const currentParts = normalizeVersion(current);
  const width = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < width; index++) {
    const diff = (candidateParts[index] ?? 0) - (currentParts[index] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return false;
}

function normalizeVersion(version: string): number[] {
  return version
    .trim()
    .toLowerCase()
    .replace(/^v/u, "")
    .split(/[+-]/u, 1)[0]
    .split(/[._-]/u)
    .map((part) => {
      const value = part.match(/^\d+/u)?.[0];
      return value ? Number(value) : 0;
    });
}

function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const pathDiff = relative(resolvedRoot, resolvedTarget);
  return !pathDiff || (pathDiff !== ".." && !pathDiff.startsWith(`..${sep}`) && !isAbsolute(pathDiff));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function maibotApiUrl(serviceUrl: string | undefined, path: string): string | null {
  try {
    const base = new URL(serviceUrl ?? "http://127.0.0.1:8001");
    return new URL(path, base.origin).toString();
  } catch {
    return null;
  }
}

function tokenFromServiceUrl(serviceUrl: string | undefined): string | null {
  if (!serviceUrl) {
    return null;
  }
  try {
    return new URL(serviceUrl).searchParams.get("token");
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs = MARKET_TIMEOUT_MS, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function runGit(gitPath: string, args: string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolveResult) => {
    execFile(
      gitPath,
      args,
      {
        cwd,
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 8,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        resolveResult({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          output,
        });
      },
    );
  });
}
