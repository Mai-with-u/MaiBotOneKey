import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  buildMaiBotPluginBlueprintFiles,
  defaultMaiBotPluginFolderName,
  sanitizeMaiBotPluginFolderName,
  validateMaiBotPluginBlueprint,
} from "../../shared/plugin-blueprint";
import type {
  MaiBotPluginBlueprint,
  MaiBotPluginBlueprintCreateResult,
  MaiBotPluginBlueprintParseResult,
  MaiBotPluginBlueprintComponent,
  MaiBotPluginBlueprintConfigField,
  MaiBotPluginBlueprintParameter,
  MaiBotPluginBlueprintScalarType,
  MaiBotPluginConfigSaveResult,
  MaiBotPluginConfigField,
  MaiBotPluginConfigSchema,
  MaiBotPluginConfigSection,
  MaiBotPluginConfigState,
  MaiBotPluginConfigValue,
  MaiBotPluginConfigLocalizedText,
  MaiBotInstalledPlugin,
  MaiBotPluginMarketSource,
  MaiBotPluginDownloadResult,
  MaiBotPluginListOptions,
  MaiBotMarketPlugin,
  MaiBotPluginDisplayIcon,
  MaiBotPluginListResult,
  MaiBotPluginManifest,
  MaiBotPluginType,
  MaiBotPluginOperationResult,
  MaiBotPluginRatingResult,
  MaiBotPluginReadmeResult,
  MaiBotPluginStats,
  MaiBotPluginUserState,
  MaiBotPluginUserStates,
  MaiBotPluginVoteResult,
} from "../../shared/contracts";
import { RemoteSourceManager, type ResolvedGitHubUrlCandidate } from "./remote-source-manager";

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
const PLUGIN_CONFIG_BACKUP_DIR = "config_back";
const PLUGIN_UPDATE_BACKUP_DIR = ".update_backups";
const PLUGIN_UPDATE_TMP_DIR = ".update_tmp";
const PLUGIN_TYPES = new Set<MaiBotPluginType>([
  "adapter",
  "chat",
  "creative",
  "provider",
  "management",
  "search",
  "knowledge",
  "media",
  "game",
  "security",
  "automation",
  "extension",
  "other",
]);

export interface MaiBotPluginClientOptions {
  maibotRoot: string;
  gitPath: string;
  remoteSourceManager?: RemoteSourceManager;
}

interface GitRunResult {
  exitCode: number;
  output: string;
}

interface CacheFile<T> {
  timestamp: number;
  data: T;
}

interface MarketRequest {
  cacheKey: string;
  promise: Promise<MaiBotMarketPlugin[]>;
}

interface SourceFailure {
  label: string;
  url: string;
  error: string;
}

interface LocalPythonConfigInspection {
  classes: Map<string, LocalPythonConfigClass>;
  configModel?: string;
}

interface LocalPythonConfigClass {
  name: string;
  description?: string;
  label?: string;
  icon?: string;
  order?: number;
  fields: LocalPythonConfigField[];
}

interface LocalPythonConfigField {
  name: string;
  annotation: string;
  defaultFactory?: string;
  defaultValue?: MaiBotPluginConfigValue;
  label?: MaiBotPluginConfigLocalizedText;
  description?: MaiBotPluginConfigLocalizedText;
  hint?: MaiBotPluginConfigLocalizedText;
  placeholder?: MaiBotPluginConfigLocalizedText;
  uiType?: string;
  inputType?: string;
  choices?: Array<MaiBotPluginConfigValue | { label?: MaiBotPluginConfigLocalizedText; value: MaiBotPluginConfigValue }>;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  required?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  order?: number;
  icon?: string;
  itemType?: string;
  minItems?: number;
  maxItems?: number;
}

export class MaiBotPluginClient {
  private readonly maibotRoot: string;

  private readonly pluginsRoot: string;

  private readonly gitPath: string;

  private readonly remoteSourceManager: RemoteSourceManager;

  private marketCache = new Map<string, CacheFile<MaiBotMarketPlugin[]>>();

  private marketRequest: MarketRequest | null = null;

  private statsCache: CacheFile<Record<string, MaiBotPluginStats>> | null = null;

  private statsRequest: Promise<Record<string, MaiBotPluginStats>> | null = null;

  constructor(options: MaiBotPluginClientOptions) {
    this.maibotRoot = resolve(options.maibotRoot);
    this.pluginsRoot = resolve(this.maibotRoot, "plugins");
    this.gitPath = options.gitPath;
    this.remoteSourceManager = options.remoteSourceManager ?? new RemoteSourceManager();
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
        manifest: await enrichInstalledManifestDisplayIcon({ ...normalizePluginManifestDisplay(manifest), id }, pluginPath),
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
          comment_count: statsItem?.comment_count ?? plugin.comment_count,
        };
      });

    return { installed, market, stats };
  }

  async install(
    pluginId: string,
    repositoryUrl: string,
    branch = "main",
    sourcePreset: MaiBotPluginMarketSource = "auto",
  ): Promise<MaiBotPluginOperationResult> {
    const targetPath = this.installTargetPath(pluginId);
    if (await pathExists(targetPath)) {
      throw new Error("插件已安装，请先卸载");
    }

    await this.cloneRepositoryWithFallback(repositoryUrl, targetPath, branch, sourcePreset);
    const manifest = await this.validateInstalledManifest(targetPath, pluginId);
    return {
      success: true,
      message: "Plugin installed successfully",
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
    sourcePreset: MaiBotPluginMarketSource = "auto",
  ): Promise<MaiBotPluginOperationResult> {
    const pluginPath = await this.resolveInstalledPluginPath(pluginId);
    if (!pluginPath) {
      throw new Error("Plugin is not installed; install it first");
    }

    const oldManifest = await this.readManifest(pluginPath);
    const oldVersion = oldManifest ? pluginVersion(oldManifest) : "unknown";
    if (latestVersion && !isNewerVersion(latestVersion, oldVersion)) {
      throw new Error("Already on the latest version; no update needed");
    }
    const repositoryCandidates = await this.resolveSourceUrlCandidates(repositoryUrl, sourcePreset);
    if (!(await isDirectory(join(pluginPath, ".git")))) {
      return this.replaceNonGitPlugin(pluginId, pluginPath, repositoryCandidates, branch, oldVersion);
    }

    const beforeCommit = await this.currentGitCommit(pluginPath);
    if (!beforeCommit) {
      throw new Error("Plugin Git repository cannot be read; update cannot continue");
    }

    const failures: SourceFailure[] = [];
    for (const candidate of repositoryCandidates) {
      try {
        await this.forcePullRepository(pluginPath, candidate.url, branch);
        const newManifest = await this.validateInstalledManifest(pluginPath, pluginId, false);
        return {
          success: true,
          message: failures.length > 0
            ? `插件更新成功，已自动切换到 ${candidate.label}`
            : "插件更新成功",
          plugin_id: pluginId,
          plugin_name: pluginName({ id: pluginId, manifest: newManifest }),
          old_version: oldVersion,
          new_version: pluginVersion(newManifest),
        };
      } catch (error) {
        failures.push({ label: candidate.label, url: candidate.url, error: toErrorMessage(error) });
        await this.rollbackRepository(pluginPath, beforeCommit);
      }
    }
    throw new Error(formatSourceFailures("插件更新失败，所有插件源均不可用", failures));
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

  async createFromBlueprint(
    blueprint: MaiBotPluginBlueprint,
    overwrite = false,
  ): Promise<MaiBotPluginBlueprintCreateResult> {
    const errors = validateMaiBotPluginBlueprint(blueprint);
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }

    const pluginId = validatePluginId(blueprint.manifest.pluginId);
    const folderName = sanitizeMaiBotPluginFolderName(
      blueprint.manifest.folderName ?? defaultMaiBotPluginFolderName(pluginId),
      pluginId,
    );
    const pluginPath = this.safePluginPath(folderName, false);
    const alreadyExists = await pathExists(pluginPath);

    if (alreadyExists && !overwrite) {
      throw new Error("插件目录已存在，请启用覆盖后再生成。");
    }

    const files = buildMaiBotPluginBlueprintFiles({
      ...blueprint,
      manifest: {
        ...blueprint.manifest,
        pluginId,
        folderName,
      },
    });

    if (alreadyExists && overwrite) {
      await rm(pluginPath, { recursive: true, force: true });
    }
    await mkdir(pluginPath, { recursive: true });

    for (const file of files) {
      const targetPath = resolve(pluginPath, file.relativePath);
      if (!isPathInside(pluginPath, targetPath)) {
        throw new Error(`拒绝写入插件目录外的文件: ${file.relativePath}`);
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content, "utf8");
    }

    return {
      pluginId,
      pluginPath,
      files,
      overwritten: alreadyExists,
      createdAt: Date.now(),
    };
  }

  async parseToBlueprint(pluginId: string): Promise<MaiBotPluginBlueprintParseResult> {
    const pluginPath = await this.requireInstalledPluginPath(pluginId);
    const manifest = await this.readManifest(pluginPath);
    const config = await this.readPluginConfig(pluginPath).catch(() => ({}));
    const schema = await buildLocalPluginConfigSchema(pluginPath, config)
      ?? buildPluginConfigSchema(config, "local");
    const pythonFiles = await collectPluginPythonFiles(pluginPath).catch(() => []);
    const sources: string[] = [];
    for (const filePath of pythonFiles) {
      try {
        if ((await stat(filePath)).size <= 512 * 1024) {
          sources.push(await readFile(filePath, "utf8"));
        }
      } catch {
        // Keep parsing any readable files.
      }
    }

    const parsedComponents = parsePluginBlueprintComponents(sources);
    const resolvedPluginId = validatePluginId(manifest?.id?.trim() || pluginId);
    const blueprint: MaiBotPluginBlueprint = {
      manifest: {
        pluginId: resolvedPluginId,
        folderName: basename(pluginPath),
        name: manifest?.name?.trim() || resolvedPluginId,
        version: manifest?.version?.trim() || "1.0.0",
        description: manifest?.description?.trim() || "从现有插件解析生成的蓝图",
        authorName: manifestAuthorName(manifest),
        authorUrl: manifestAuthorUrl(manifest),
        license: manifest?.license?.trim() || "MIT",
        repositoryUrl: manifestRepositoryUrl(manifest),
        minHostVersion: manifest?.host_application?.min_version?.trim() || "1.0.0",
        maxHostVersion: manifest?.host_application?.max_version?.trim() || "1.99.99",
        minSdkVersion: readManifestSdkVersion(manifest, "min_version") || "2.0.0",
        maxSdkVersion: readManifestSdkVersion(manifest, "max_version") || "2.99.99",
        capabilities: manifest?.capabilities?.length ? manifest.capabilities : ["send.text", "config.get"],
      },
      components: parsedComponents.components,
      configFields: blueprintFieldsFromConfigSchema(schema),
    };

    return {
      pluginId: resolvedPluginId,
      pluginPath,
      blueprint,
      parsed: {
        manifest: manifest !== null,
        configFields: blueprint.configFields.length,
        tools: parsedComponents.tools,
        commands: parsedComponents.commands,
        unsupportedDecorators: parsedComponents.unsupportedDecorators,
      },
    };
  }

  async getConfig(pluginId: string, serviceUrl?: string): Promise<MaiBotPluginConfigState> {
    const pluginPath = await this.requireInstalledPluginPath(pluginId);
    const configPath = resolve(pluginPath, PLUGIN_CONFIG_FILE);
    if (!isPathInside(pluginPath, configPath)) {
      throw new Error("Plugin config path is outside the allowed range");
    }

    const runtimeConfig = await this.getRuntimeConfig(pluginId, pluginPath, configPath, serviceUrl);
    if (runtimeConfig) {
      return runtimeConfig;
    }

    const exists = await pathExists(configPath);
    const raw = exists ? await readFile(configPath, "utf8") : "";
    const config = exists ? parsePluginConfig(raw, configPath) : {};
    const schema = await buildLocalPluginConfigSchema(pluginPath, config)
      ?? buildPluginConfigSchema(config, "local");

    return {
      pluginId,
      pluginPath,
      configPath,
      exists,
      config,
      schema,
      raw,
    };
  }

  async saveConfig(
    pluginId: string,
    config: Record<string, MaiBotPluginConfigValue>,
    serviceUrl?: string,
  ): Promise<MaiBotPluginConfigSaveResult> {
    const pluginPath = await this.requireInstalledPluginPath(pluginId);
    const configPath = resolve(pluginPath, PLUGIN_CONFIG_FILE);
    if (!isPathInside(pluginPath, configPath)) {
      throw new Error("Plugin config path is outside the allowed range");
    }

    const runtimeConfig = normalizePluginConfigRoot(config);
    const runtimeResult = await this.saveRuntimeConfig(pluginId, runtimeConfig, pluginPath, configPath, serviceUrl);
    if (runtimeResult) {
      return runtimeResult;
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
      schema: await buildLocalPluginConfigSchema(pluginPath, normalizedConfig)
        ?? buildPluginConfigSchema(normalizedConfig, "local"),
      raw,
      backupPath,
      savedAt: Date.now(),
    };
  }

  async saveConfigRaw(
    pluginId: string,
    raw: string,
    serviceUrl?: string,
  ): Promise<MaiBotPluginConfigSaveResult> {
    const pluginPath = await this.requireInstalledPluginPath(pluginId);
    const configPath = resolve(pluginPath, PLUGIN_CONFIG_FILE);
    if (!isPathInside(pluginPath, configPath)) {
      throw new Error("Plugin config path is outside the allowed range");
    }

    const writtenRaw = raw.endsWith("\n") ? raw : `${raw}\n`;
    const parsedConfig = parsePluginConfig(writtenRaw, configPath);
    const runtimeResult = await this.saveRuntimeConfigRaw(pluginId, writtenRaw, pluginPath, configPath, serviceUrl);
    if (runtimeResult) {
      return runtimeResult;
    }

    let backupPath: string | undefined;
    if (await pathExists(configPath)) {
      backupPath = `${configPath}.${new Date().toISOString().replace(/[:.]/gu, "-")}.bak`;
      await copyFile(configPath, backupPath);
    }

    await mkdir(pluginPath, { recursive: true });
    await writeFile(configPath, writtenRaw, "utf8");

    return {
      pluginId,
      configPath,
      config: parsedConfig,
      schema: await buildLocalPluginConfigSchema(pluginPath, parsedConfig)
        ?? buildPluginConfigSchema(parsedConfig, "local"),
      raw: writtenRaw,
      backupPath,
      savedAt: Date.now(),
    };
  }

  async resetConfig(pluginId: string, serviceUrl?: string): Promise<MaiBotPluginConfigSaveResult> {
    const pluginPath = await this.requireInstalledPluginPath(pluginId);
    const configPath = resolve(pluginPath, PLUGIN_CONFIG_FILE);
    if (!isPathInside(pluginPath, configPath)) {
      throw new Error("Plugin config path is outside the allowed range");
    }

    const runtimeResult = await this.resetRuntimeConfig(pluginId, pluginPath, configPath, serviceUrl);
    if (runtimeResult) {
      return runtimeResult;
    }

    let backupPath: string | undefined;
    if (await pathExists(configPath)) {
      backupPath = `${configPath}.${new Date().toISOString().replace(/[:.]/gu, "-")}.bak`;
      await copyFile(configPath, backupPath);
      await rm(configPath, { force: true });
    }

    const config: Record<string, MaiBotPluginConfigValue> = {};
    return {
      pluginId,
      configPath,
      config,
      schema: await buildLocalPluginConfigSchema(pluginPath, config)
        ?? buildPluginConfigSchema(config, "local"),
      raw: "",
      backupPath,
      savedAt: Date.now(),
    };
  }

  async getReadme(
    pluginId: string,
    repositoryUrl?: string,
    sourcePreset: MaiBotPluginMarketSource = "auto",
  ): Promise<MaiBotPluginReadmeResult> {
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

    if (!repositoryUrl) {
      return { success: false, error: "Plugin README not found" };
    }

    const failures: SourceFailure[] = [];
    for (const branch of ["main", "master"]) {
      const candidates = await this.remoteSourceManager.resolveGitHubReadmeUrlCandidates(repositoryUrl, branch, sourcePreset);
      for (const candidate of candidates) {
        const response = await fetchWithTimeout(candidate.url).catch((error: unknown) => {
          failures.push({ label: candidate.label, url: candidate.url, error: toErrorMessage(error) });
          return null;
        });
        if (response?.ok) {
          return { success: true, content: await response.text() };
        }
        if (response) {
          failures.push({ label: candidate.label, url: candidate.url, error: `HTTP ${response.status}` });
        }
      }
    }
    return { success: false, error: failures.length > 0 ? formatSourceFailures("Plugin README not found", failures) : "Plugin README not found" };
  }

  async getStats(pluginId: string): Promise<MaiBotPluginStats | null> {
    const response = await fetchWithTimeout(`${PLUGIN_STATS_BASE_URL}/stats/${encodeURIComponent(pluginId)}`).catch(() => null);
    if (!response?.ok) {
      return null;
    }
    const data = (await response.json()) as unknown;
    return normalizePluginStatsDetail(pluginId, data);
  }

  async getUserState(pluginId: string, userId: string): Promise<MaiBotPluginUserState | null> {
    const query = new URLSearchParams({ plugin_id: pluginId, user_id: userId });
    const data = await requestPluginStatsService("GET", `/stats/user-state?${query.toString()}`);
    return data ? normalizePluginUserState(data) : null;
  }

  async getUserStates(userId: string): Promise<MaiBotPluginUserStates> {
    const query = new URLSearchParams({ user_id: userId });
    const data = await requestPluginStatsService("GET", `/stats/user-states?${query.toString()}`);
    if (isUnknownRecord(data) && data.success === false) {
      throw new Error(typeof data.error === "string" ? data.error : "Plugin user states request failed");
    }
    return normalizePluginUserStates(data);
  }

  async likePlugin(pluginId: string, userId: string): Promise<MaiBotPluginVoteResult> {
    const result = await this.postPluginVote("/stats/like", pluginId, userId);
    this.mergeCachedPluginStats(pluginId, {
      likes: result.likes,
      dislikes: result.dislikes,
    });
    return result;
  }

  async dislikePlugin(pluginId: string, userId: string): Promise<MaiBotPluginVoteResult> {
    const result = await this.postPluginVote("/stats/dislike", pluginId, userId);
    this.mergeCachedPluginStats(pluginId, {
      likes: result.likes,
      dislikes: result.dislikes,
    });
    return result;
  }

  async ratePlugin(
    pluginId: string,
    rating: number | null | undefined,
    comment: string | null | undefined,
    userId: string,
  ): Promise<MaiBotPluginRatingResult> {
    if (rating !== undefined && rating !== null && (rating < 1 || rating > 5)) {
      return { success: false, error: "评分必须在 1-5 之间" };
    }
    if (rating === undefined && comment === undefined) {
      return { success: false, error: "评分和评论至少需要提交一项" };
    }

    const payload: Record<string, unknown> = {
      plugin_id: pluginId,
      user_id: userId,
    };
    if (rating !== undefined) {
      payload.rating = rating;
    }
    if (comment !== undefined) {
      payload.comment = comment;
    }

    const data = await requestPluginStatsService("POST", "/stats/rate", payload);
    const result = normalizePluginRatingResult(data);
    this.mergeCachedPluginStats(pluginId, {
      rating: result.rating,
      rating_count: result.rating_count,
      comment_count: result.comment_count,
    });
    return result;
  }

  async recordDownload(
    pluginId: string,
    userId?: string,
    fingerprint?: string,
  ): Promise<MaiBotPluginDownloadResult> {
    const data = await requestPluginStatsService("POST", "/stats/download", {
      plugin_id: pluginId,
      user_id: userId,
      fingerprint,
    });
    const result = normalizePluginDownloadResult(data);
    this.mergeCachedPluginStats(pluginId, { downloads: result.downloads });
    return result;
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
    const marketSource = normalizeMarketSource(options.marketSource);
    const cacheKey = marketSourceCacheKey(marketSource);
    const cacheFileName = `onekey-plugin-market-list-cache-${cacheKey}.json`;
    const cached = await this.readCache(
      cacheFileName,
      this.marketCache.get(cacheKey) ?? null,
      isMarketPluginList,
    );
    if (!options.forceRefresh && cached && Date.now() - cached.timestamp < PLUGIN_MARKET_CACHE_TTL_MS) {
      this.marketCache.set(cacheKey, cached);
      return cached.data;
    }

    if (!this.marketRequest || this.marketRequest.cacheKey !== cacheKey || options.forceRefresh) {
      const promise = this.fetchMarketPluginsWithFallback(marketSource)
        .then(async (plugins) => {
          const nextCache = { timestamp: Date.now(), data: plugins };
          this.marketCache.set(cacheKey, nextCache);
          await this.writeCache(cacheFileName, nextCache);
          return plugins;
        })
        .catch((error) => {
          if (cached) {
            return cached.data;
          }
          throw error;
        })
        .finally(() => {
          if (this.marketRequest?.cacheKey === cacheKey) {
            this.marketRequest = null;
          }
        });
      this.marketRequest = { cacheKey, promise };
    }

    return this.marketRequest.promise;
  }

  private async getPluginStatsSummary(options: MaiBotPluginListOptions): Promise<Record<string, MaiBotPluginStats>> {
    const cached = await this.readCache(
      "onekey-plugin-market-stats-cache-v2.json",
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
          await this.writeCache("onekey-plugin-market-stats-cache-v2.json", nextCache);
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

  private async postPluginVote(path: string, pluginId: string, userId: string): Promise<MaiBotPluginVoteResult> {
    const data = await requestPluginStatsService("POST", path, {
      plugin_id: pluginId,
      user_id: userId,
    });
    return normalizePluginVoteResult(data);
  }

  private mergeCachedPluginStats(pluginId: string, partialStats: Partial<MaiBotPluginStats>): void {
    const currentCache = this.statsCache;
    if (!currentCache) {
      return;
    }

    const previousStats = currentCache.data[pluginId] ?? createEmptyPluginStats(pluginId);
    const nextStats = normalizePluginStats(pluginId, {
      ...previousStats,
      ...Object.fromEntries(Object.entries(partialStats).filter(([, value]) => value !== undefined)),
      plugin_id: pluginId,
    })?.[1] ?? previousStats;

    this.statsCache = {
      timestamp: Date.now(),
      data: {
        ...currentCache.data,
        [pluginId]: nextStats,
      },
    };
  }

  private async resolveSourceUrlCandidates(
    url: string,
    source: MaiBotPluginMarketSource,
  ): Promise<ResolvedGitHubUrlCandidate[]> {
    return this.remoteSourceManager.resolveGitHubUrlCandidates(url, source);
  }

  private async fetchMarketPluginsWithFallback(source: MaiBotPluginMarketSource): Promise<MaiBotMarketPlugin[]> {
    const candidates = await this.remoteSourceManager.resolveGitHubUrlCandidates(MARKET_URL, source);
    const failures: SourceFailure[] = [];
    for (const candidate of candidates) {
      try {
        return await fetchMarketPluginsUncached(candidate.url);
      } catch (error) {
        failures.push({ label: candidate.label, url: candidate.url, error: toErrorMessage(error) });
      }
    }
    throw new Error(formatSourceFailures("插件市场列表获取失败，所有插件市场源均不可用", failures));
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
      throw new Error("Plugin market cache path is outside the allowed range");
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

  private async cloneRepositoryWithFallback(
    repositoryUrl: string,
    targetPath: string,
    branch: string,
    sourcePreset: MaiBotPluginMarketSource,
  ): Promise<void> {
    const candidates = await this.resolveSourceUrlCandidates(repositoryUrl, sourcePreset);
    const failures: SourceFailure[] = [];
    for (const candidate of candidates) {
      try {
        await this.cloneRepository(candidate.url, targetPath, branch);
        return;
      } catch (error) {
        failures.push({ label: candidate.label, url: candidate.url, error: toErrorMessage(error) });
      }
    }
    throw new Error(formatSourceFailures("插件仓库克隆失败，所有插件源均不可用", failures));
  }

  private async currentGitCommit(pluginPath: string): Promise<string | null> {
    if (!(await isDirectory(join(pluginPath, ".git")))) {
      return null;
    }
    const result = await runGit(this.gitPath, ["rev-parse", "HEAD"], pluginPath);
    return result.exitCode === 0 && result.output.trim() ? result.output.trim().split(/\s+/u)[0] : null;
  }

  private async replaceNonGitPlugin(
    pluginId: string,
    pluginPath: string,
    repositoryCandidates: ResolvedGitHubUrlCandidate[],
    branch: string,
    oldVersion: string,
  ): Promise<MaiBotPluginOperationResult> {
    const { backupPath, tempPath } = this.createPluginUpdateWorkspace(pluginId);

    await mkdir(dirname(backupPath), { recursive: true });
    await mkdir(dirname(tempPath), { recursive: true });
    await rename(pluginPath, backupPath);

    const failures: SourceFailure[] = [];
    for (const candidate of repositoryCandidates) {
      try {
        await this.cloneRepository(candidate.url, tempPath, branch);
        const newManifest = await this.validateReplacementManifest(tempPath, pluginId);
        await this.restoreOfficialPluginConfig(backupPath, tempPath);
        await rename(tempPath, pluginPath);

        return {
          success: true,
          message: failures.length > 0
            ? `Plugin updated successfully via ${candidate.label}`
            : "Plugin updated successfully",
          plugin_id: pluginId,
          plugin_name: pluginName({ id: pluginId, manifest: newManifest }),
          old_version: oldVersion,
          new_version: pluginVersion(newManifest),
        };
      } catch (error) {
        failures.push({ label: candidate.label, url: candidate.url, error: toErrorMessage(error) });
        await rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await this.restoreUpdateBackup(backupPath, pluginPath);
    throw new Error(formatSourceFailures("插件更新失败，所有插件源均不可用", failures));
  }

  private createPluginUpdateWorkspace(pluginId: string): { backupPath: string; tempPath: string } {
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const safeId = sanitizeUpdateWorkspaceName(validatePluginId(pluginId));
    const folderName = `${safeId}.${timestamp}.${process.pid}`;
    const backupPath = resolve(this.pluginsRoot, PLUGIN_UPDATE_BACKUP_DIR, folderName);
    const tempPath = resolve(this.pluginsRoot, PLUGIN_UPDATE_TMP_DIR, folderName);

    if (!isPathInside(this.pluginsRoot, backupPath) || !isPathInside(this.pluginsRoot, tempPath)) {
      throw new Error("Plugin update workspace path is outside the allowed range");
    }
    return { backupPath, tempPath };
  }

  private async restoreUpdateBackup(backupPath: string, pluginPath: string): Promise<void> {
    if (!(await pathExists(backupPath))) {
      return;
    }

    if (await pathExists(pluginPath)) {
      await rm(pluginPath, { recursive: true, force: true });
    }
    await rename(backupPath, pluginPath);
  }

  private async restoreOfficialPluginConfig(backupPath: string, pluginPath: string): Promise<void> {
    await this.restorePluginConfigEntry(backupPath, pluginPath, PLUGIN_CONFIG_FILE);
    await this.restorePluginConfigEntry(backupPath, pluginPath, PLUGIN_CONFIG_BACKUP_DIR);
  }

  private async restorePluginConfigEntry(
    backupPath: string,
    pluginPath: string,
    entryName: string,
  ): Promise<void> {
    const sourcePath = resolve(backupPath, entryName);
    const targetPath = resolve(pluginPath, entryName);
    if (!isPathInside(backupPath, sourcePath) || !isPathInside(pluginPath, targetPath)) {
      throw new Error("Plugin config restore path is outside the allowed range");
    }
    if (!(await pathExists(sourcePath))) {
      return;
    }

    const sourceStat = await stat(sourcePath);
    await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    if (sourceStat.isDirectory()) {
      await cp(sourcePath, targetPath, { recursive: true, force: true });
    } else if (sourceStat.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }

  private async forcePullRepository(pluginPath: string, repositoryUrl: string, branch: string): Promise<void> {
    const remote = repositoryUrl.trim();
    const targetBranch = branch || "main";
    await this.runGitOrThrow(pluginPath, ["remote", "set-url", "origin", remote], "更新插件远端失败");
    await this.runGitOrThrow(pluginPath, ["fetch", "--force", "--prune", "origin", targetBranch], "拉取插件远端失败");
    await this.runGitOrThrow(pluginPath, ["reset", "--hard", `origin/${targetBranch}`], "强制更新插件失败");
    await this.runGitOrThrow(pluginPath, ["submodule", "update", "--init", "--recursive"], "更新插件子模块失败", true);
  }

  private async rollbackRepository(pluginPath: string, commit: string): Promise<void> {
    await runGit(this.gitPath, ["reset", "--hard", commit], pluginPath);
    await runGit(this.gitPath, ["submodule", "update", "--init", "--recursive"], pluginPath);
  }

  private async runGitOrThrow(pluginPath: string, args: string[], message: string, optional = false): Promise<void> {
    const result = await runGit(this.gitPath, args, pluginPath);
    if (result.exitCode !== 0 && !optional) {
      throw new Error(result.output || message);
    }
  }

  private async validateReplacementManifest(pluginPath: string, pluginId: string): Promise<MaiBotPluginManifest> {
    const manifest = await this.readManifest(pluginPath);
    if (!manifest) {
      throw new Error("Invalid plugin: missing _manifest.json");
    }

    const expectedId = validatePluginId(pluginId);
    const manifestId = manifest.id?.trim();
    if (manifestId !== expectedId) {
      throw new Error(`Invalid _manifest.json: plugin id must be ${expectedId}`);
    }
    if (!manifest.name?.trim()) {
      throw new Error("Invalid _manifest.json: missing required field name");
    }
    if (!manifest.version?.trim()) {
      throw new Error("Invalid _manifest.json: missing required field version");
    }

    const authorName = typeof manifest.author === "string" ? manifest.author.trim() : manifest.author?.name?.trim();
    if (!authorName) {
      throw new Error("Invalid _manifest.json: missing required field author");
    }

    return { ...manifest, id: manifestId };
  }

  private async validateInstalledManifest(pluginPath: string, pluginId: string, removeOnFailure = true): Promise<MaiBotPluginManifest> {
    const manifest = await this.readManifest(pluginPath);
    if (!manifest) {
      if (removeOnFailure) {
        await rm(pluginPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw new Error("无效的插件：缺少 _manifest.json");
    }

    for (const field of ["name", "version", "author"]) {
      if (!(field in manifest)) {
        if (removeOnFailure) {
          await rm(pluginPath, { recursive: true, force: true }).catch(() => undefined);
        }
        throw new Error(`Invalid _manifest.json: missing required field ${field}`);
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

  private async getRuntimeConfig(
    pluginId: string,
    pluginPath: string,
    configPath: string,
    serviceUrl?: string,
  ): Promise<MaiBotPluginConfigState | null> {
    const schemaUrl = maibotApiUrl(serviceUrl, `/api/webui/plugins/config/${encodeURIComponent(pluginId)}/schema`);
    const configUrl = maibotApiUrl(serviceUrl, `/api/webui/plugins/config/${encodeURIComponent(pluginId)}`);
    if (!schemaUrl || !configUrl) {
      return null;
    }

    try {
      const headers = await this.maibotRuntimeAuthHeaders(serviceUrl);
      const [schemaResponse, configResponse] = await Promise.all([
        fetchWithTimeout(schemaUrl, MAIBOT_API_TIMEOUT_MS, { headers }),
        fetchWithTimeout(configUrl, MAIBOT_API_TIMEOUT_MS, { headers }),
      ]);
      if (!schemaResponse.ok || !configResponse.ok) {
        return null;
      }

      const [schemaPayload, configPayload] = await Promise.all([
        schemaResponse.json() as Promise<unknown>,
        configResponse.json() as Promise<unknown>,
      ]);
      const dashboardSchema = readDashboardConfigSchema(schemaPayload);
      const config = readDashboardConfig(configPayload);
      if (!dashboardSchema || !config) {
        return null;
      }

      const raw = await this.getRuntimeConfigRaw(pluginId, serviceUrl);
      return {
        pluginId,
        pluginPath,
        configPath,
        exists: true,
        config,
        schema: buildDashboardPluginConfigSchema(dashboardSchema, config),
        raw: raw ?? stringifyToml(normalizePluginConfigRootForToml(config)),
      };
    } catch {
      return null;
    }
  }

  private async getRuntimeConfigRaw(pluginId: string, serviceUrl?: string): Promise<string | null> {
    const rawUrl = maibotApiUrl(serviceUrl, `/api/webui/plugins/config/${encodeURIComponent(pluginId)}/raw`);
    if (!rawUrl) {
      return null;
    }
    try {
      const response = await fetchWithTimeout(rawUrl, MAIBOT_API_TIMEOUT_MS, {
        headers: await this.maibotRuntimeAuthHeaders(serviceUrl),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as unknown;
      return readDashboardRawConfig(payload);
    } catch {
      return null;
    }
  }

  private async saveRuntimeConfig(
    pluginId: string,
    config: Record<string, MaiBotPluginConfigValue>,
    pluginPath: string,
    configPath: string,
    serviceUrl?: string,
  ): Promise<MaiBotPluginConfigSaveResult | null> {
    const configUrl = maibotApiUrl(serviceUrl, `/api/webui/plugins/config/${encodeURIComponent(pluginId)}`);
    if (!configUrl) {
      return null;
    }

    try {
      const response = await fetchWithTimeout(configUrl, MAIBOT_API_TIMEOUT_MS, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(await this.maibotRuntimeAuthHeaders(serviceUrl)),
        },
        body: JSON.stringify({ config }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as unknown;
      if (!isUnknownRecord(payload) || payload.success !== true) {
        return null;
      }
      const state = await this.getRuntimeConfig(pluginId, pluginPath, configPath, serviceUrl);
      if (!state) {
        return null;
      }
      return {
        pluginId,
        configPath,
        config: state.config,
        schema: state.schema,
        raw: state.raw,
        savedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  private async saveRuntimeConfigRaw(
    pluginId: string,
    raw: string,
    pluginPath: string,
    configPath: string,
    serviceUrl?: string,
  ): Promise<MaiBotPluginConfigSaveResult | null> {
    const rawUrl = maibotApiUrl(serviceUrl, `/api/webui/plugins/config/${encodeURIComponent(pluginId)}/raw`);
    if (!rawUrl) {
      return null;
    }

    try {
      const response = await fetchWithTimeout(rawUrl, MAIBOT_API_TIMEOUT_MS, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(await this.maibotRuntimeAuthHeaders(serviceUrl)),
        },
        body: JSON.stringify({ config: raw }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as unknown;
      if (!isUnknownRecord(payload) || payload.success !== true) {
        return null;
      }
      const state = await this.getRuntimeConfig(pluginId, pluginPath, configPath, serviceUrl);
      if (!state) {
        return null;
      }
      return {
        pluginId,
        configPath,
        config: state.config,
        schema: state.schema,
        raw: state.raw,
        savedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  private async resetRuntimeConfig(
    pluginId: string,
    pluginPath: string,
    configPath: string,
    serviceUrl?: string,
  ): Promise<MaiBotPluginConfigSaveResult | null> {
    const resetUrl = maibotApiUrl(serviceUrl, `/api/webui/plugins/config/${encodeURIComponent(pluginId)}/reset`);
    if (!resetUrl) {
      return null;
    }

    try {
      const response = await fetchWithTimeout(resetUrl, MAIBOT_API_TIMEOUT_MS, {
        method: "POST",
        headers: await this.maibotRuntimeAuthHeaders(serviceUrl),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as unknown;
      if (!isUnknownRecord(payload) || payload.success !== true) {
        return null;
      }
      const state = await this.getRuntimeConfig(pluginId, pluginPath, configPath, serviceUrl);
      if (!state) {
        return null;
      }
      return {
        pluginId,
        configPath,
        config: state.config,
        schema: state.schema,
        raw: state.raw,
        backupPath: typeof payload.backup === "string" ? payload.backup : undefined,
        savedAt: Date.now(),
      };
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
      throw new Error("Plugin ID contains invalid characters");
    }

    const targetPath = resolve(this.pluginsRoot, folderName);
    if (!isPathInside(this.pluginsRoot, targetPath)) {
      throw new Error("Plugin path is outside the allowed range");
    }
    if (mustExist && targetPath === this.pluginsRoot) {
      throw new Error("拒绝操作插件根目录");
    }
    return targetPath;
  }
}

interface ParsedBlueprintComponents {
  components: MaiBotPluginBlueprintComponent[];
  tools: number;
  commands: number;
  unsupportedDecorators: string[];
}

function manifestAuthorName(manifest: MaiBotPluginManifest | null): string {
  if (typeof manifest?.author === "string") {
    return manifest.author;
  }
  return manifest?.author?.name?.trim() || "MaiBot Developer";
}

function manifestAuthorUrl(manifest: MaiBotPluginManifest | null): string {
  if (typeof manifest?.author === "object" && manifest.author?.url) {
    return manifest.author.url;
  }
  return manifest?.homepage_url?.trim() || manifest?.urls?.homepage?.trim() || "https://example.com";
}

function manifestRepositoryUrl(manifest: MaiBotPluginManifest | null): string {
  return manifest?.repository_url?.trim()
    || manifest?.urls?.repository?.trim()
    || manifest?.homepage_url?.trim()
    || manifest?.urls?.homepage?.trim()
    || "https://example.com/maibot-plugin";
}

function readManifestSdkVersion(
  manifest: MaiBotPluginManifest | null,
  key: "min_version" | "max_version",
): string | undefined {
  return manifest?.sdk?.[key]?.trim();
}

function blueprintFieldsFromConfigSchema(schema: MaiBotPluginConfigSchema): MaiBotPluginBlueprintConfigField[] {
  const fields: MaiBotPluginBlueprintConfigField[] = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.path.length < 2) {
        continue;
      }
      const sectionName = field.path[0];
      const fieldName = field.path[1];
      if (sectionName === "plugin" && (fieldName === "enabled" || fieldName === "config_version")) {
        continue;
      }
      const type = blueprintScalarTypeFromConfigValue(field.value);
      if (!type) {
        continue;
      }
      fields.push({
        id: `field-${sectionName}-${fieldName}`,
        section: sectionName,
        name: fieldName,
        type,
        label: localizedConfigTextToString(field.label, fieldName),
        description: localizedConfigTextToString(field.description, ""),
        defaultValue: blueprintDefaultFromConfigValue(field.value),
      });
    }
  }
  return fields;
}

function blueprintScalarTypeFromConfigValue(value: MaiBotPluginConfigValue): MaiBotPluginBlueprintScalarType | null {
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "float";
  }
  if (typeof value === "string") {
    return "string";
  }
  return null;
}

function blueprintDefaultFromConfigValue(value: MaiBotPluginConfigValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function localizedConfigTextToString(value: MaiBotPluginConfigLocalizedText | undefined, fallback: string): string {
  if (typeof value === "string") {
    return value || fallback;
  }
  return value?.["zh-CN"] || value?.zh || value?.en || Object.values(value ?? {})[0] || fallback;
}

function parsePluginBlueprintComponents(sources: string[]): ParsedBlueprintComponents {
  const components: MaiBotPluginBlueprintComponent[] = [];
  const unsupportedDecorators = new Set<string>();

  for (const source of sources) {
    components.push(...parseDecoratorComponents(source, "Tool"));
    components.push(...parseDecoratorComponents(source, "Command"));
    for (const decorator of source.matchAll(/@(Action|EventHandler|API|Schedule)\s*\(/gu)) {
      unsupportedDecorators.add(decorator[1]);
    }
  }

  return {
    components: dedupeBlueprintComponents(components),
    tools: components.filter((component) => component.kind === "tool").length,
    commands: components.filter((component) => component.kind === "command").length,
    unsupportedDecorators: [...unsupportedDecorators],
  };
}

function parseDecoratorComponents(source: string, decoratorName: "Tool" | "Command"): MaiBotPluginBlueprintComponent[] {
  const components: MaiBotPluginBlueprintComponent[] = [];
  let index = 0;
  const marker = `@${decoratorName}`;
  while (index < source.length) {
    const markerIndex = source.indexOf(marker, index);
    if (markerIndex < 0) {
      break;
    }
    const openIndex = source.indexOf("(", markerIndex + marker.length);
    if (openIndex < 0) {
      break;
    }
    const closeIndex = findMatchingDelimiter(source, openIndex, "(", ")");
    if (closeIndex < 0) {
      break;
    }
    const argsText = source.slice(openIndex + 1, closeIndex);
    const methodStart = source.indexOf("async def", closeIndex);
    const nextDecorator = source.indexOf("\n    @", closeIndex + 1);
    const methodEnd = nextDecorator < 0 ? source.length : nextDecorator;
    const methodText = methodStart >= 0 && methodStart < methodEnd ? source.slice(methodStart, methodEnd) : "";
    const component = decoratorName === "Tool"
      ? parseToolComponent(argsText, methodText, components.length)
      : parseCommandComponent(argsText, methodText, components.length);
    if (component) {
      components.push(component);
    }
    index = closeIndex + 1;
  }
  return components;
}

function parseToolComponent(
  argsText: string,
  methodText: string,
  index: number,
): MaiBotPluginBlueprintComponent | null {
  const name = readDecoratorName(argsText) || readMethodName(methodText)?.replace(/^handle_/u, "") || `tool_${index + 1}`;
  return {
    id: `tool-${name}-${index}`,
    kind: "tool",
    name,
    description: readDecoratorStringArg(argsText, ["description", "brief_description", "detailed_description"]) || name,
    responseText: readMethodMessage(methodText) || "工具已执行。",
    parameters: parseToolParameters(argsText, methodText),
  };
}

function parseCommandComponent(
  argsText: string,
  methodText: string,
  index: number,
): MaiBotPluginBlueprintComponent | null {
  const name = readDecoratorName(argsText) || readMethodName(methodText)?.replace(/^handle_/u, "") || `command_${index + 1}`;
  return {
    id: `command-${name}-${index}`,
    kind: "command",
    name,
    description: readDecoratorStringArg(argsText, ["description"]) || name,
    trigger: readDecoratorStringArg(argsText, ["pattern"]) || `^/${name}$`,
    responseText: readMethodMessage(methodText) || "命令已执行。",
  };
}

function readDecoratorName(argsText: string): string | undefined {
  const literal = readPythonStringLiteral(argsText, skipWhitespace(argsText, 0));
  return literal?.value.trim() || undefined;
}

function readDecoratorStringArg(argsText: string, names: string[]): string | undefined {
  for (const name of names) {
    const match = new RegExp(`${escapeRegExp(name)}\\s*=\\s*([rRuUbBfF]*["'])`, "u").exec(argsText);
    if (!match) {
      continue;
    }
    const literalStart = match.index + match[0].lastIndexOf(match[1]);
    const literal = readPythonStringLiteral(argsText, literalStart);
    if (literal?.value.trim()) {
      return literal.value.trim();
    }
  }
  return undefined;
}

function parseToolParameters(argsText: string, methodText: string): MaiBotPluginBlueprintParameter[] {
  const parameters: MaiBotPluginBlueprintParameter[] = [];
  const parameterRegex = /ToolParameterInfo\s*\(/gu;
  let match: RegExpExecArray | null;
  while ((match = parameterRegex.exec(argsText)) !== null) {
    const openIndex = argsText.indexOf("(", match.index);
    const closeIndex = findMatchingDelimiter(argsText, openIndex, "(", ")");
    if (closeIndex < 0) {
      break;
    }
    const parameterText = argsText.slice(openIndex + 1, closeIndex);
    const name = readDecoratorStringArg(parameterText, ["name"]) || "";
    if (!name) {
      parameterRegex.lastIndex = closeIndex + 1;
      continue;
    }
    const type = readToolParameterType(parameterText);
    parameters.push({
      id: `param-${name}`,
      name,
      type,
      description: readDecoratorStringArg(parameterText, ["description"]) || name,
      required: /required\s*=\s*True/u.test(parameterText),
      defaultValue: readMethodParameterDefault(methodText, name) ?? defaultValueForBlueprintScalar(type),
    });
    parameterRegex.lastIndex = closeIndex + 1;
  }
  return parameters;
}

function readToolParameterType(parameterText: string): MaiBotPluginBlueprintScalarType {
  const type = parameterText.match(/ToolParamType\.([A-Z_]+)/u)?.[1];
  switch (type) {
    case "FLOAT":
    case "NUMBER":
      return "float";
    case "INTEGER":
    case "INT":
      return "integer";
    case "BOOLEAN":
    case "BOOL":
      return "boolean";
    default:
      return "string";
  }
}

function readMethodParameterDefault(methodText: string, name: string): string | undefined {
  const signature = methodText.match(/async\s+def\s+\w+\s*\(([\s\S]*?)\)\s*:/u)?.[1];
  if (!signature) {
    return undefined;
  }
  const match = new RegExp(`${escapeRegExp(name)}\\s*:[^=,]+=(\\s*[^,]+)`, "u").exec(signature);
  return match?.[1]?.trim().replace(/^["']|["']$/gu, "");
}

function defaultValueForBlueprintScalar(type: MaiBotPluginBlueprintScalarType): string {
  if (type === "boolean") return "false";
  if (type === "integer" || type === "float") return "0";
  return "";
}

function readMethodName(methodText: string): string | undefined {
  return methodText.match(/async\s+def\s+(\w+)/u)?.[1];
}

function readMethodMessage(methodText: string): string | undefined {
  const assignment = methodText.match(/message\s*=\s*([rRuUbBfF]*["'])/u);
  if (assignment) {
    const literalStart = assignment.index! + assignment[0].lastIndexOf(assignment[1]);
    return readPythonStringLiteral(methodText, literalStart)?.value.trim();
  }
  const sendText = methodText.match(/send\.text\s*\(\s*([rRuUbBfF]*["'])/u);
  if (sendText) {
    const literalStart = sendText.index! + sendText[0].lastIndexOf(sendText[1]);
    return readPythonStringLiteral(methodText, literalStart)?.value.trim();
  }
  return undefined;
}

function dedupeBlueprintComponents(components: MaiBotPluginBlueprintComponent[]): MaiBotPluginBlueprintComponent[] {
  const seen = new Set<string>();
  return components.filter((component) => {
    const key = `${component.kind}:${component.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeMarketPlugin(raw: unknown, index = 0): MaiBotMarketPlugin | null {
  if (!raw || typeof raw !== "object" || !("manifest" in raw)) {
    return null;
  }

  const item = raw as {
    id?: string;
    manifest?: MaiBotPluginManifest;
    marketplace_id?: string;
    marketplace_order?: unknown;
    published_at?: unknown;
    created_at?: unknown;
    added_at?: unknown;
    updated_at?: unknown;
    modified_at?: unknown;
    source?: string;
    downloads?: unknown;
    rating?: unknown;
    likes?: unknown;
    comment_count?: unknown;
    comments?: unknown;
  };
  const manifest = item.manifest;
  const id = manifest?.id?.trim() || item.id?.trim();
  if (!manifest || !id || !manifest.name || !manifest.version) {
    return null;
  }

  return {
    id,
    manifest: normalizePluginManifestDisplay({ ...manifest, id }),
    marketplace_id: typeof item.marketplace_id === "string" ? item.marketplace_id : item.id,
    marketplace_order: numberOrUndefined(item.marketplace_order) ?? index,
    published_at: normalizeDateString(item.published_at ?? item.created_at ?? item.added_at),
    updated_at: normalizeDateString(item.updated_at ?? item.modified_at),
    source: item.source,
    downloads: normalizeStatsNumber(item.downloads),
    rating: normalizeStatsNumber(item.rating),
    likes: normalizeStatsNumber(item.likes),
    comment_count: normalizeStatsNumber(item.comment_count) ?? normalizeStatsNumber(item.comments),
  };
}

function normalizePluginManifestDisplay(manifest: MaiBotPluginManifest): MaiBotPluginManifest {
  const pluginType = normalizePluginType(manifest.plugin_type);
  const icon = normalizePluginDisplayIcon(manifest.display?.icon);
  const display = manifest.display
    ? { ...manifest.display, icon }
    : undefined;
  return {
    ...manifest,
    plugin_type: pluginType,
    display,
  };
}

function normalizePluginType(value: unknown): MaiBotPluginType {
  if (typeof value !== "string" || !value.trim()) {
    return "extension";
  }

  const normalizedValue = value.trim();
  return PLUGIN_TYPES.has(normalizedValue as MaiBotPluginType)
    ? normalizedValue as MaiBotPluginType
    : "other";
}

function normalizePluginDisplayIcon(icon: unknown): MaiBotPluginDisplayIcon | undefined {
  if (!isUnknownRecord(icon)) {
    return undefined;
  }

  const type = icon.type;
  const value = typeof icon.value === "string" ? icon.value.trim() : "";
  if ((type !== "lucide" && type !== "emoji" && type !== "local") || !value) {
    return undefined;
  }
  const fallback = typeof icon.fallback === "string" && icon.fallback.trim() ? icon.fallback.trim() : undefined;
  const background = typeof icon.background === "string" && /^#[0-9a-f]{6}$/iu.test(icon.background.trim())
    ? icon.background.trim()
    : undefined;
  return { type, value, fallback, background };
}

async function enrichInstalledManifestDisplayIcon(
  manifest: MaiBotPluginManifest,
  pluginPath: string,
): Promise<MaiBotPluginManifest> {
  const icon = manifest.display?.icon;
  if (icon?.type !== "local" || icon.value.startsWith("data:")) {
    return manifest;
  }

  const iconPath = resolve(pluginPath, icon.value);
  if (!isPathInside(pluginPath, iconPath) || !(await pathExists(iconPath))) {
    return manifest;
  }

  const mimeType = localIconMimeType(iconPath);
  if (!mimeType) {
    return manifest;
  }

  try {
    const data = await readFile(iconPath);
    if (data.byteLength > 256 * 1024) {
      return manifest;
    }
    return {
      ...manifest,
      display: {
        ...manifest.display,
        icon: {
          ...icon,
          value: `data:${mimeType};base64,${data.toString("base64")}`,
        },
      },
    };
  } catch {
    return manifest;
  }
}

function localIconMimeType(filePath: string): string | null {
  const suffix = filePath.toLowerCase().split(".").at(-1);
  switch (suffix) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

function normalizeDateString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function normalizeMarketSource(source: MaiBotPluginListOptions["marketSource"]): MaiBotPluginMarketSource {
  const normalized = typeof source === "string" ? source.trim() : "";
  if (!normalized || normalized === "configured") {
    return "auto";
  }
  return normalized === "official" ? "github" : normalized;
}

function marketSourceCacheKey(source: MaiBotPluginMarketSource): string {
  return source;
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
  const loadStatus = typeof raw.load_status === "string" ? raw.load_status : undefined;
  const loaded = loadStatus === "success"
    ? true
    : loadStatus === "failed"
      ? false
      : raw.loaded === true
        ? true
        : undefined;

  return {
    id,
    manifest: normalizePluginManifestDisplay({ ...manifest, id: manifest.id?.trim() || id }),
    path: typeof raw.path === "string" ? raw.path : "",
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : typeof raw.disabled === "boolean" ? !raw.disabled : true,
    loaded,
    load_status: loadStatus,
  };
}

async function fetchMarketPluginsUncached(marketUrl: string): Promise<MaiBotMarketPlugin[]> {
  const response = await fetchWithTimeout(marketUrl);
  if (!response.ok) {
    throw new Error(`Plugin market list failed: HTTP ${response.status}`);
  }

  const rawList = (await response.json()) as unknown;
  const sourceList = Array.isArray(rawList) ? rawList : [];
  return sourceList
    .map((item, index) => normalizeMarketPlugin(item, index))
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
  const recentRatings = normalizePluginRatings(rawStats.recent_ratings);
  const ratingCount = normalizeStatsNumber(rawStats.rating_count) ?? 0;
  const commentCount = normalizeStatsNumber(rawStats.comment_count)
    ?? normalizeStatsNumber(rawStats.comments)
    ?? recentRatings?.filter((rating) => rating.comment?.trim()).length
    ?? 0;
  return [
    pluginId,
    {
      plugin_id: normalizedId,
      likes: normalizeStatsNumber(rawStats.likes) ?? 0,
      dislikes: normalizeStatsNumber(rawStats.dislikes) ?? 0,
      downloads: normalizeStatsNumber(rawStats.downloads) ?? 0,
      rating: normalizeStatsNumber(rawStats.rating) ?? 0,
      rating_count: ratingCount,
      comment_count: commentCount,
      recent_ratings: recentRatings,
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
      id: typeof rating.id === "string" ? rating.id : undefined,
      user_id: String(rating.user_id ?? "匿名用户"),
      rating: rating.rating === null ? null : normalizeStatsNumber(rating.rating),
      comment: typeof rating.comment === "string" ? rating.comment : undefined,
      created_at: String(rating.created_at ?? ""),
      updated_at: typeof rating.updated_at === "string" ? rating.updated_at : undefined,
      likes: normalizeStatsNumber(rating.likes) ?? normalizeStatsNumber(rating.like_count),
      dislikes: normalizeStatsNumber(rating.dislikes) ?? normalizeStatsNumber(rating.dislike_count),
    }))
    .filter((rating) => (typeof rating.rating === "number" && rating.rating > 0) || rating.comment);
}

function createEmptyPluginStats(pluginId: string): MaiBotPluginStats {
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

function normalizePluginUserState(rawData: unknown): MaiBotPluginUserState | null {
  if (!isUnknownRecord(rawData) || rawData.success === false) {
    return null;
  }

  return {
    liked: rawData.liked === true,
    disliked: rawData.disliked === true,
    rating: rawData.rating === null ? null : normalizeStatsNumber(rawData.rating) ?? 0,
    comment: typeof rawData.comment === "string" ? rawData.comment : "",
  };
}

function normalizePluginUserStates(rawData: unknown): MaiBotPluginUserStates {
  if (!isUnknownRecord(rawData) || rawData.success === false || !isUnknownRecord(rawData.states)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(rawData.states)
      .map(([pluginId, rawState]) => {
        const state = normalizePluginUserState(rawState);
        if (!state) {
          return null;
        }
        const normalizedPluginId = isUnknownRecord(rawState) && typeof rawState.plugin_id === "string"
          ? rawState.plugin_id
          : pluginId;
        return [normalizedPluginId, state] as const;
      })
      .filter((entry): entry is readonly [string, MaiBotPluginUserState] => entry !== null),
  );
}

function normalizePluginVoteResult(rawData: unknown): MaiBotPluginVoteResult {
  if (!isUnknownRecord(rawData)) {
    return { success: false, error: "插件统计服务响应格式无效" };
  }

  return {
    success: rawData.success === true,
    error: typeof rawData.error === "string" ? rawData.error : undefined,
    liked: typeof rawData.liked === "boolean" ? rawData.liked : undefined,
    disliked: typeof rawData.disliked === "boolean" ? rawData.disliked : undefined,
    likes: normalizeStatsNumber(rawData.likes),
    dislikes: normalizeStatsNumber(rawData.dislikes),
    remaining: normalizeStatsNumber(rawData.remaining),
  };
}

function normalizePluginRatingResult(rawData: unknown): MaiBotPluginRatingResult {
  if (!isUnknownRecord(rawData)) {
    return { success: false, error: "插件统计服务响应格式无效" };
  }

  return {
    success: rawData.success === true,
    error: typeof rawData.error === "string" ? rawData.error : undefined,
    user_rating: rawData.user_rating === null ? null : normalizeStatsNumber(rawData.user_rating),
    rating: normalizeStatsNumber(rawData.rating),
    rating_count: normalizeStatsNumber(rawData.rating_count),
    comment_count: normalizeStatsNumber(rawData.comment_count) ?? normalizeStatsNumber(rawData.comments),
    remaining: normalizeStatsNumber(rawData.remaining),
  };
}

function normalizePluginDownloadResult(rawData: unknown): MaiBotPluginDownloadResult {
  if (!isUnknownRecord(rawData)) {
    return { success: false, error: "插件统计服务响应格式无效" };
  }

  return {
    success: rawData.success === true,
    error: typeof rawData.error === "string" ? rawData.error : undefined,
    counted: typeof rawData.counted === "boolean" ? rawData.counted : undefined,
    downloads: normalizeStatsNumber(rawData.downloads),
    remaining: normalizeStatsNumber(rawData.remaining),
  };
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
    throw new Error("Plugin ID cannot be empty and cannot start or end with a dot");
  }
  if ([".", ".."].includes(normalized) || /[\\/\0\r\n\t]/u.test(normalized) || normalized.includes("..")) {
    throw new Error("Plugin ID contains invalid characters");
  }
  return normalized;
}

function sanitizeUpdateWorkspaceName(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/\.+/gu, ".");
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

async function buildLocalPluginConfigSchema(
  pluginPath: string,
  config: Record<string, MaiBotPluginConfigValue>,
): Promise<MaiBotPluginConfigSchema | null> {
  const pythonFiles = await collectPluginPythonFiles(pluginPath).catch(() => []);
  if (pythonFiles.length === 0) {
    return null;
  }

  const sources: string[] = [];
  for (const filePath of pythonFiles) {
    try {
      if ((await stat(filePath)).size > 512 * 1024) {
        continue;
      }
      sources.push(await readFile(filePath, "utf8"));
    } catch {
      // Ignore unreadable plugin helper files and keep the weak TOML fallback available.
    }
  }

  if (sources.length === 0) {
    return null;
  }

  const inspection = parseLocalPythonConfigInspection(sources);
  if (inspection.classes.size === 0) {
    return null;
  }
  return buildPluginConfigSchemaFromLocalPython(inspection, config);
}

async function collectPluginPythonFiles(
  pluginPath: string,
  currentPath = pluginPath,
  depth = 0,
  files: string[] = [],
): Promise<string[]> {
  if (depth > 2 || files.length >= 80) {
    return files;
  }

  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= 80) {
      break;
    }
    if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules") {
      continue;
    }

    const entryPath = resolve(currentPath, entry.name);
    if (!isPathInside(pluginPath, entryPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectPluginPythonFiles(pluginPath, entryPath, depth + 1, files);
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      files.push(entryPath);
    }
  }
  return files;
}

function parseLocalPythonConfigInspection(sources: string[]): LocalPythonConfigInspection {
  const classes = new Map<string, LocalPythonConfigClass>();
  let configModel: string | undefined;

  for (const source of sources) {
    configModel ??= extractPythonConfigModel(source);
    for (const configClass of parsePythonConfigClasses(source)) {
      if (configClass.fields.length > 0 || configClass.label || configClass.description) {
        classes.set(configClass.name, configClass);
      }
    }
  }

  return { classes, configModel };
}

function extractPythonConfigModel(source: string): string | undefined {
  const match = source.match(/^\s{4}config_model(?:\s*:[^=\n]+)?\s*=\s*([A-Za-z_]\w*)/mu)
    ?? source.match(/^config_model(?:\s*:[^=\n]+)?\s*=\s*([A-Za-z_]\w*)/mu);
  return match?.[1];
}

function parsePythonConfigClasses(source: string): LocalPythonConfigClass[] {
  const classHeaders: Array<{ name: string; headerEnd: number; start: number }> = [];
  const classRegex = /^class\s+([A-Za-z_]\w*)\([^)]*\):/gmu;
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classRegex.exec(source)) !== null) {
    classHeaders.push({
      name: classMatch[1],
      headerEnd: classMatch.index + classMatch[0].length,
      start: classMatch.index,
    });
  }

  return classHeaders.map((header, index) => {
    const nextHeader = classHeaders[index + 1];
    const block = source.slice(header.headerEnd, nextHeader?.start);
    return parsePythonConfigClass(header.name, block);
  });
}

function parsePythonConfigClass(name: string, block: string): LocalPythonConfigClass {
  return {
    name,
    description: extractPythonClassDocstring(block),
    label: extractPythonClassStringAttribute(block, "__ui_label__"),
    icon: extractPythonClassStringAttribute(block, "__ui_icon__"),
    order: extractPythonClassNumberAttribute(block, "__ui_order__"),
    fields: parsePythonConfigFields(block),
  };
}

function parsePythonConfigFields(block: string): LocalPythonConfigField[] {
  const fields: LocalPythonConfigField[] = [];
  const fieldRegex = /^ {4}([A-Za-z_]\w*)\s*:\s*([^=\n]+?)\s*=\s*Field\s*\(/gmu;
  let fieldMatch: RegExpExecArray | null;
  while ((fieldMatch = fieldRegex.exec(block)) !== null) {
    const openParenIndex = fieldMatch.index + fieldMatch[0].lastIndexOf("(");
    const closeParenIndex = findMatchingDelimiter(block, openParenIndex, "(", ")");
    if (closeParenIndex < 0) {
      continue;
    }

    const name = fieldMatch[1];
    const annotation = fieldMatch[2].trim();
    const expression = block.slice(openParenIndex + 1, closeParenIndex);
    const extra = extractPythonFieldExtra(expression);
    fields.push({
      name,
      annotation,
      defaultFactory: extractPythonIdentifierKeyword(expression, "default_factory"),
      defaultValue: extractPythonDefaultValue(expression),
      label: extra.label,
      description: extractPythonStringKeyword(expression, "description") ?? extra.description,
      hint: extra.hint,
      placeholder: extra.placeholder,
      uiType: extra.uiType,
      inputType: extra.inputType,
      choices: extra.choices ?? extractLiteralChoices(annotation),
      min: extra.min,
      max: extra.max,
      step: extra.step,
      rows: extra.rows,
      required: extra.required,
      hidden: extra.hidden,
      disabled: extra.disabled,
      order: extra.order,
      icon: extra.icon,
      itemType: extra.itemType,
      minItems: extra.minItems,
      maxItems: extra.maxItems,
    });
    fieldRegex.lastIndex = closeParenIndex + 1;
  }
  return fields;
}

function buildPluginConfigSchemaFromLocalPython(
  inspection: LocalPythonConfigInspection,
  config: Record<string, MaiBotPluginConfigValue>,
): MaiBotPluginConfigSchema | null {
  const rootClass = resolveLocalPythonRootConfigClass(inspection, config);
  if (!rootClass) {
    return null;
  }

  const sections: MaiBotPluginConfigSection[] = [];
  const usedConfigKeys = new Set<string>();
  const rootFields = [...rootClass.fields].sort(compareLocalPythonFields);

  for (const rootField of rootFields) {
    const sectionValue = config[rootField.name];
    const sectionClassName = resolveLocalPythonFieldClassName(rootField, inspection.classes);
    const sectionClass = sectionClassName ? inspection.classes.get(sectionClassName) : undefined;
    if (!sectionClass && !isConfigRecord(sectionValue)) {
      continue;
    }

    usedConfigKeys.add(rootField.name);
    sections.push(buildLocalPythonConfigSection(
      rootField.name,
      isConfigRecord(sectionValue) ? sectionValue : {},
      sectionClass,
      rootField,
    ));
  }

  const generalFields = rootFields
    .filter((field) => !usedConfigKeys.has(field.name) && field.hidden !== true)
    .map((field) => buildLocalPythonConfigField([field.name], field, config[field.name]))
    .filter((field): field is MaiBotPluginConfigField => field !== null);

  const extraGeneralFields = Object.entries(config)
    .filter(([key, value]) => !usedConfigKeys.has(key) && !rootClass.fields.some((field) => field.name === key) && !isConfigRecord(value))
    .map(([key, value]) => buildPluginConfigField([key], key, value));

  if (generalFields.length > 0 || extraGeneralFields.length > 0) {
    sections.unshift({
      name: "general",
      title: "General",
      fields: [...generalFields, ...extraGeneralFields],
    });
  }

  for (const [sectionName, sectionValue] of Object.entries(config)) {
    if (usedConfigKeys.has(sectionName) || !isConfigRecord(sectionValue)) {
      continue;
    }
    sections.push(buildLocalPythonConfigSection(sectionName, sectionValue));
  }

  if (sections.length === 0) {
    return null;
  }
  return {
    pluginInfo: {
      name: rootClass.label,
      description: rootClass.description,
    },
    sections: sections.sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
    source: "local",
  };
}

function resolveLocalPythonRootConfigClass(
  inspection: LocalPythonConfigInspection,
  config: Record<string, MaiBotPluginConfigValue>,
): LocalPythonConfigClass | undefined {
  if (inspection.configModel && inspection.classes.has(inspection.configModel)) {
    return inspection.classes.get(inspection.configModel);
  }

  const configKeys = new Set(Object.keys(config));
  return [...inspection.classes.values()]
    .map((configClass) => {
      let score = 0;
      for (const field of configClass.fields) {
        const className = resolveLocalPythonFieldClassName(field, inspection.classes);
        if (className) {
          score += 4;
        }
        if (configKeys.has(field.name)) {
          score += 2;
        }
      }
      return { configClass, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.configClass;
}

function buildLocalPythonConfigSection(
  sectionName: string,
  sectionConfig: Record<string, MaiBotPluginConfigValue>,
  sectionClass?: LocalPythonConfigClass,
  rootField?: LocalPythonConfigField,
): MaiBotPluginConfigSection {
  const metadataFields = [...(sectionClass?.fields ?? [])].sort(compareLocalPythonFields);
  const metadataNames = new Set(metadataFields.map((field) => field.name));
  const fields = [
    ...metadataFields
      .filter((field) => field.hidden !== true)
      .map((field) => buildLocalPythonConfigField([sectionName, field.name], field, sectionConfig[field.name]))
      .filter((field): field is MaiBotPluginConfigField => field !== null),
    ...Object.entries(sectionConfig)
      .filter(([fieldName]) => !metadataNames.has(fieldName))
      .map(([fieldName, fieldValue]) => buildPluginConfigField([sectionName, fieldName], fieldName, fieldValue)),
  ];

  return {
    name: sectionName,
    title: sectionClass?.label ?? rootField?.label ?? labelFromKey(sectionName),
    description: sectionClass?.description ?? rootField?.description,
    icon: sectionClass?.icon ?? rootField?.icon,
    order: sectionClass?.order ?? rootField?.order,
    fields,
  };
}

function buildLocalPythonConfigField(
  path: string[],
  metadata: LocalPythonConfigField,
  currentValue: MaiBotPluginConfigValue | undefined,
): MaiBotPluginConfigField | null {
  if (metadata.hidden === true) {
    return null;
  }
  const value = currentValue
    ?? metadata.defaultValue
    ?? defaultValueForPythonAnnotation(metadata.annotation, metadata.defaultFactory);
  return {
    name: metadata.name,
    label: metadata.label ?? metadata.description ?? labelFromKey(metadata.name),
    path,
    type: pluginConfigValueType(value),
    value,
    description: metadata.description,
    hint: metadata.hint,
    placeholder: metadata.placeholder,
    uiType: metadata.uiType,
    inputType: metadata.inputType,
    choices: metadata.choices,
    min: metadata.min,
    max: metadata.max,
    step: metadata.step,
    rows: metadata.rows,
    required: metadata.required,
    disabled: metadata.disabled,
    order: metadata.order,
    icon: metadata.icon,
    default: metadata.defaultValue,
    itemType: metadata.itemType,
    minItems: metadata.minItems,
    maxItems: metadata.maxItems,
  };
}

function compareLocalPythonFields(left: LocalPythonConfigField, right: LocalPythonConfigField): number {
  return (left.order ?? 0) - (right.order ?? 0);
}

function resolveLocalPythonFieldClassName(
  field: LocalPythonConfigField,
  classes: Map<string, LocalPythonConfigClass>,
): string | undefined {
  const candidates = [
    ...extractPythonIdentifierTokens(field.annotation),
    ...(field.defaultFactory ? extractPythonIdentifierTokens(field.defaultFactory) : []),
  ];
  return candidates.find((candidate) => classes.has(candidate));
}

function defaultValueForPythonAnnotation(annotation: string, defaultFactory?: string): MaiBotPluginConfigValue {
  const normalized = annotation.toLowerCase();
  const factory = defaultFactory?.toLowerCase();
  if (factory === "list" || normalized.includes("list[")) {
    return [];
  }
  if (factory === "dict" || normalized.includes("dict[") || normalized.includes("mapping[")) {
    return {};
  }
  if (normalized.includes("bool")) {
    return false;
  }
  if (normalized.includes("int") || normalized.includes("float")) {
    return 0;
  }
  return "";
}

function extractPythonClassDocstring(block: string): string | undefined {
  const firstContent = block.match(/^\s*(?:(?:\r?\n)\s*)*/u)?.[0].length ?? 0;
  const literal = readPythonStringLiteral(block, firstContent);
  return literal?.value.trim() || undefined;
}

function extractPythonClassStringAttribute(block: string, attribute: string): string | undefined {
  const regex = new RegExp(`^ {4}${escapeRegExp(attribute)}(?:\\s*:[^=\\n]+)?\\s*=\\s*`, "mu");
  const match = regex.exec(block);
  if (!match) {
    return undefined;
  }
  return readPythonStringLiteral(block, match.index + match[0].length)?.value;
}

function extractPythonClassNumberAttribute(block: string, attribute: string): number | undefined {
  const regex = new RegExp(`^ {4}${escapeRegExp(attribute)}(?:\\s*:[^=\\n]+)?\\s*=\\s*([-+]?\\d+(?:\\.\\d+)?)`, "mu");
  const value = Number(regex.exec(block)?.[1]);
  return Number.isFinite(value) ? value : undefined;
}

function extractPythonFieldExtra(expression: string): Partial<LocalPythonConfigField> {
  return {
    label: extractPythonDictStringValue(expression, "label"),
    description: extractPythonDictStringValue(expression, "description"),
    hint: extractPythonDictStringValue(expression, "hint"),
    placeholder: extractPythonDictStringValue(expression, "placeholder"),
    uiType: extractPythonDictStringValue(expression, "ui_type"),
    inputType: extractPythonDictStringValue(expression, "input_type"),
    icon: extractPythonDictStringValue(expression, "icon"),
    itemType: extractPythonDictStringValue(expression, "item_type"),
    hidden: extractPythonDictBooleanValue(expression, "hidden"),
    disabled: extractPythonDictBooleanValue(expression, "disabled"),
    required: extractPythonDictBooleanValue(expression, "required"),
    order: extractPythonDictNumberValue(expression, "order"),
    min: extractPythonDictNumberValue(expression, "min"),
    max: extractPythonDictNumberValue(expression, "max"),
    step: extractPythonDictNumberValue(expression, "step"),
    rows: extractPythonDictNumberValue(expression, "rows"),
    minItems: extractPythonDictNumberValue(expression, "min_items"),
    maxItems: extractPythonDictNumberValue(expression, "max_items"),
    choices: extractPythonDictChoices(expression, "choices"),
  };
}

function extractPythonDefaultValue(expression: string): MaiBotPluginConfigValue | undefined {
  const rawDefault = extractPythonKeywordExpression(expression, "default");
  if (rawDefault !== undefined) {
    return parsePythonLiteral(rawDefault);
  }

  const factory = extractPythonIdentifierKeyword(expression, "default_factory")?.toLowerCase();
  if (factory === "list") {
    return [];
  }
  if (factory === "dict") {
    return {};
  }
  return undefined;
}

function extractPythonStringKeyword(expression: string, keyword: string): string | undefined {
  const rawValue = extractPythonKeywordExpression(expression, keyword);
  if (rawValue === undefined) {
    return undefined;
  }
  return readPythonStringLiteral(rawValue, 0)?.value;
}

function extractPythonIdentifierKeyword(expression: string, keyword: string): string | undefined {
  const rawValue = extractPythonKeywordExpression(expression, keyword);
  return rawValue?.trim().match(/^[A-Za-z_]\w*/u)?.[0];
}

function extractPythonKeywordExpression(expression: string, keyword: string): string | undefined {
  const regex = new RegExp(`\\b${escapeRegExp(keyword)}\\s*=`, "u");
  const match = regex.exec(expression);
  if (!match) {
    return undefined;
  }
  return readPythonExpressionUntilComma(expression, match.index + match[0].length).trim();
}

function extractPythonDictStringValue(expression: string, key: string): string | undefined {
  for (const rawValue of extractPythonDictExpressions(expression, key)) {
    const literal = readPythonStringLiteral(rawValue, 0);
    if (literal?.value) {
      return literal.value;
    }
  }
  return undefined;
}

function extractPythonDictBooleanValue(expression: string, key: string): boolean | undefined {
  for (const rawValue of extractPythonDictExpressions(expression, key)) {
    const parsed = parsePythonLiteral(rawValue);
    if (typeof parsed === "boolean") {
      return parsed;
    }
  }
  return undefined;
}

function extractPythonDictNumberValue(expression: string, key: string): number | undefined {
  for (const rawValue of extractPythonDictExpressions(expression, key)) {
    const parsed = parsePythonLiteral(rawValue);
    if (typeof parsed === "number") {
      return parsed;
    }
  }
  return undefined;
}

function extractPythonDictChoices(
  expression: string,
  key: string,
): Array<MaiBotPluginConfigValue | { label?: MaiBotPluginConfigLocalizedText; value: MaiBotPluginConfigValue }> | undefined {
  for (const rawValue of extractPythonDictExpressions(expression, key)) {
    const parsed = parsePythonLiteral(rawValue);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractPythonDictExpressions(expression: string, key: string): string[] {
  const values: string[] = [];
  const regex = new RegExp(`["']${escapeRegExp(key)}["']\\s*:`, "gu");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(expression)) !== null) {
    values.push(readPythonExpressionUntilComma(expression, match.index + match[0].length).trim());
  }
  return values;
}

function extractLiteralChoices(annotation: string): MaiBotPluginConfigValue[] | undefined {
  const literalMatch = annotation.match(/Literal\s*\[(.*)\]/u);
  if (!literalMatch) {
    return undefined;
  }
  const values: MaiBotPluginConfigValue[] = [];
  const content = literalMatch[1];
  let index = 0;
  while (index < content.length) {
    const rawExpression = readPythonExpressionUntilComma(content, index);
    const expression = rawExpression.trim();
    const parsed = parsePythonLiteral(expression);
    if (parsed !== undefined) {
      values.push(parsed);
    }
    index += rawExpression.length + 1;
  }
  return values.length > 0 ? values : undefined;
}

function parsePythonLiteral(rawValue: string): MaiBotPluginConfigValue | undefined {
  const value = rawValue.trim();
  if (!value) {
    return undefined;
  }
  if (value === "True") {
    return true;
  }
  if (value === "False") {
    return false;
  }
  if (value === "None") {
    return null;
  }

  const stringLiteral = readPythonStringLiteral(value, 0);
  if (stringLiteral && value.slice(stringLiteral.end).trim().length === 0) {
    return stringLiteral.value;
  }

  if (/^[-+]?\d+(?:\.\d+)?$/u.test(value)) {
    return Number(value);
  }

  if (value === "[]" || value.toLowerCase() === "list()") {
    return [];
  }
  if (value === "{}" || value.toLowerCase() === "dict()") {
    return {};
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return parsePythonListLiteral(value);
  }
  return undefined;
}

function parsePythonListLiteral(value: string): MaiBotPluginConfigValue[] | undefined {
  const content = value.slice(1, -1);
  const values: MaiBotPluginConfigValue[] = [];
  let index = 0;
  while (index < content.length) {
    const rawExpression = readPythonExpressionUntilComma(content, index);
    const item = rawExpression.trim();
    if (item) {
      const parsed = parsePythonLiteral(item);
      if (parsed === undefined || isConfigRecord(parsed)) {
        return undefined;
      }
      values.push(parsed);
    }
    index += rawExpression.length + 1;
  }
  return values;
}

function readPythonExpressionUntilComma(text: string, startIndex: number): string {
  let depth = 0;
  for (let index = startIndex; index < text.length; index++) {
    const stringEnd = findPythonStringEnd(text, index);
    if (stringEnd > index) {
      index = stringEnd - 1;
      continue;
    }

    const char = text[index];
    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        return text.slice(startIndex, index);
      }
      depth--;
    } else if (char === "," && depth === 0) {
      return text.slice(startIndex, index);
    }
  }
  return text.slice(startIndex);
}

function findMatchingDelimiter(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    const stringEnd = findPythonStringEnd(text, index);
    if (stringEnd > index) {
      index = stringEnd - 1;
      continue;
    }

    if (text[index] === open) {
      depth++;
    } else if (text[index] === close) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function readPythonStringLiteral(text: string, startIndex: number): { value: string; end: number } | null {
  let index = skipWhitespace(text, startIndex);
  while (/[rRuUbBfF]/u.test(text[index] ?? "") && (text[index + 1] === "\"" || text[index + 1] === "'")) {
    index++;
  }

  const quote = text[index];
  if (quote !== "\"" && quote !== "'") {
    return null;
  }

  const triple = text.slice(index, index + 3) === quote.repeat(3);
  const contentStart = index + (triple ? 3 : 1);
  let value = "";
  for (let cursor = contentStart; cursor < text.length; cursor++) {
    if (triple && text.slice(cursor, cursor + 3) === quote.repeat(3)) {
      return { value, end: cursor + 3 };
    }
    if (!triple && text[cursor] === quote) {
      return { value, end: cursor + 1 };
    }
    if (text[cursor] === "\\" && cursor + 1 < text.length) {
      value += decodePythonEscapedChar(text[cursor + 1]);
      cursor++;
    } else {
      value += text[cursor];
    }
  }
  return null;
}

function findPythonStringEnd(text: string, index: number): number {
  const literal = readPythonStringLiteral(text, index);
  return literal?.end ?? index;
}

function decodePythonEscapedChar(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return char;
  }
}

function skipWhitespace(text: string, startIndex: number): number {
  let index = startIndex;
  while (/\s/u.test(text[index] ?? "")) {
    index++;
  }
  return index;
}

function extractPythonIdentifierTokens(value: string): string[] {
  return [...value.matchAll(/[A-Za-z_]\w*/gu)].map((match) => match[0]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface DashboardConfigFieldSchema {
  name?: unknown;
  type?: unknown;
  default?: unknown;
  description?: unknown;
  label?: unknown;
  placeholder?: unknown;
  hint?: unknown;
  icon?: unknown;
  ui_type?: unknown;
  input_type?: unknown;
  choices?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
  rows?: unknown;
  required?: unknown;
  hidden?: unknown;
  disabled?: unknown;
  order?: unknown;
  item_type?: unknown;
  min_items?: unknown;
  max_items?: unknown;
}

interface DashboardConfigSectionSchema {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  icon?: unknown;
  collapsed?: unknown;
  order?: unknown;
  fields?: unknown;
}

interface DashboardConfigSchema {
  plugin_id?: unknown;
  plugin_info?: unknown;
  sections?: unknown;
  layout?: unknown;
}

function readDashboardConfigSchema(payload: unknown): DashboardConfigSchema | null {
  if (!isUnknownRecord(payload)) {
    return null;
  }
  const schema = payload.schema;
  return isUnknownRecord(schema) && isUnknownRecord(schema.sections) ? schema : null;
}

function readDashboardConfig(payload: unknown): Record<string, MaiBotPluginConfigValue> | null {
  if (!isUnknownRecord(payload)) {
    return null;
  }
  return isUnknownRecord(payload.config) ? normalizePluginConfigRoot(payload.config) : null;
}

function readDashboardRawConfig(payload: unknown): string | null {
  if (!isUnknownRecord(payload)) {
    return null;
  }
  return typeof payload.config === "string" ? payload.config : null;
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
    throw new Error(`TOML does not support null: ${path}`);
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
  throw new Error(`Unsupported plugin config value: ${path}`);
}

function buildPluginConfigSchema(
  config: Record<string, MaiBotPluginConfigValue>,
  source: MaiBotPluginConfigSchema["source"] = "local",
): MaiBotPluginConfigSchema {
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

  return { sections, source };
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

function buildDashboardPluginConfigSchema(
  dashboardSchema: DashboardConfigSchema,
  config: Record<string, MaiBotPluginConfigValue>,
): MaiBotPluginConfigSchema {
  const sectionsRecord = isUnknownRecord(dashboardSchema.sections) ? dashboardSchema.sections : {};
  const sections = Object.entries(sectionsRecord)
    .map(([sectionKey, rawSection]) => normalizeDashboardSection(sectionKey, rawSection, config))
    .filter((section): section is MaiBotPluginConfigSchema["sections"][number] => section !== null)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

  const pluginInfo = isUnknownRecord(dashboardSchema.plugin_info)
    ? {
        name: localizedTextOrUndefined(dashboardSchema.plugin_info.name),
        version: stringOrUndefined(dashboardSchema.plugin_info.version),
        description: localizedTextOrUndefined(dashboardSchema.plugin_info.description),
        author: stringOrUndefined(dashboardSchema.plugin_info.author),
      }
    : undefined;
  const layout = normalizeDashboardLayout(dashboardSchema.layout);

  return { pluginInfo, sections, layout, source: "runtime" };
}

function normalizeDashboardSection(
  sectionKey: string,
  rawSection: unknown,
  config: Record<string, MaiBotPluginConfigValue>,
): MaiBotPluginConfigSchema["sections"][number] | null {
  if (!isUnknownRecord(rawSection)) {
    return null;
  }
  const section = rawSection as DashboardConfigSectionSchema;
  const fieldsRecord = isUnknownRecord(section.fields) ? section.fields : {};
  const sectionName = stringOrUndefined(section.name) ?? sectionKey;
  const fields = Object.entries(fieldsRecord)
    .map(([fieldKey, rawField]) => normalizeDashboardField(sectionName, fieldKey, rawField, config))
    .filter((field): field is MaiBotPluginConfigSchema["sections"][number]["fields"][number] => field !== null)
    .filter((field) => field.hidden !== true)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

  return {
    name: sectionName,
    title: localizedTextOrUndefined(section.title) ?? labelFromKey(sectionName),
    description: localizedTextOrUndefined(section.description),
    icon: stringOrUndefined(section.icon),
    collapsed: typeof section.collapsed === "boolean" ? section.collapsed : undefined,
    order: numberOrUndefined(section.order),
    fields,
  };
}

function normalizeDashboardField(
  sectionName: string,
  fieldKey: string,
  rawField: unknown,
  config: Record<string, MaiBotPluginConfigValue>,
): MaiBotPluginConfigSchema["sections"][number]["fields"][number] | null {
  if (!isUnknownRecord(rawField)) {
    return null;
  }
  const field = rawField as DashboardConfigFieldSchema;
  const name = stringOrUndefined(field.name) ?? fieldKey;
  const path = [sectionName, name];
  const configValue = getConfigValueAtPath(config, path);
  const defaultValue = field.default === undefined ? undefined : normalizePluginConfigValue(field.default);
  const value = configValue ?? defaultValue ?? defaultValueForDashboardType(field.type);
  return {
    name,
    label: localizedTextOrUndefined(field.label) ?? labelFromKey(name),
    path,
    type: pluginConfigValueType(value),
    value,
    description: localizedTextOrUndefined(field.description),
    hint: localizedTextOrUndefined(field.hint),
    placeholder: localizedTextOrUndefined(field.placeholder),
    uiType: stringOrUndefined(field.ui_type),
    inputType: stringOrUndefined(field.input_type),
    choices: normalizeDashboardChoices(field.choices),
    min: numberOrUndefined(field.min),
    max: numberOrUndefined(field.max),
    step: numberOrUndefined(field.step),
    rows: numberOrUndefined(field.rows),
    required: typeof field.required === "boolean" ? field.required : undefined,
    hidden: typeof field.hidden === "boolean" ? field.hidden : undefined,
    disabled: typeof field.disabled === "boolean" ? field.disabled : undefined,
    order: numberOrUndefined(field.order),
    icon: stringOrUndefined(field.icon),
    default: defaultValue,
    itemType: stringOrUndefined(field.item_type),
    minItems: numberOrUndefined(field.min_items),
    maxItems: numberOrUndefined(field.max_items),
  };
}

function normalizeDashboardLayout(rawLayout: unknown): MaiBotPluginConfigSchema["layout"] {
  if (!isUnknownRecord(rawLayout)) {
    return undefined;
  }
  const rawTabs = Array.isArray(rawLayout.tabs) ? rawLayout.tabs : [];
  const tabs = rawTabs
    .filter(isUnknownRecord)
    .map((tab) => ({
      id: stringOrUndefined(tab.id) ?? "",
      title: localizedTextOrUndefined(tab.title) ?? "",
      sections: Array.isArray(tab.sections) ? tab.sections.map(String) : [],
      icon: stringOrUndefined(tab.icon),
      order: numberOrUndefined(tab.order),
      badge: stringOrUndefined(tab.badge),
    }))
    .filter((tab) => tab.id && tab.title)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const type = rawLayout.type === "tabs" || rawLayout.type === "pages" ? rawLayout.type : "auto";
  return { type, tabs };
}

function normalizeDashboardChoices(
  choices: unknown,
): MaiBotPluginConfigSchema["sections"][number]["fields"][number]["choices"] {
  if (!Array.isArray(choices)) {
    return undefined;
  }
  return choices.map((choice) => {
    if (isUnknownRecord(choice) && "value" in choice) {
      return {
        label: localizedTextOrUndefined(choice.label),
        value: normalizePluginConfigValue(choice.value),
      };
    }
    return normalizePluginConfigValue(choice);
  });
}

function getConfigValueAtPath(config: Record<string, MaiBotPluginConfigValue>, path: string[]): MaiBotPluginConfigValue | undefined {
  let cursor: MaiBotPluginConfigValue | Record<string, MaiBotPluginConfigValue> = config;
  for (const segment of path) {
    if (!isConfigRecord(cursor) || !(segment in cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor as MaiBotPluginConfigValue;
}

function defaultValueForDashboardType(type: unknown): MaiBotPluginConfigValue {
  switch (type) {
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 0;
    case "array":
    case "list":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
}

function localizedTextOrUndefined(value: unknown): MaiBotPluginConfigLocalizedText | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
  return Number.isFinite(numberValue) ? numberValue : undefined;
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

async function requestPluginStatsService(
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  };
  const response = await fetchWithTimeout(`${PLUGIN_STATS_BASE_URL}${path}`, MARKET_TIMEOUT_MS, init).catch(() => null);
  if (!response) {
    return { success: false, error: "插件统计服务暂不可用" };
  }

  const data = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    return isUnknownRecord(data)
      ? { ...data, success: false }
      : { success: false, error: `插件统计服务返回 HTTP ${response.status}` };
  }
  return data;
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSourceFailures(title: string, failures: SourceFailure[]): string {
  if (failures.length === 0) {
    return title;
  }
  return `${title}\n${failures.map((failure) => `${failure.label} (${failure.url}): ${failure.error}`).join("\n")}`;
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
