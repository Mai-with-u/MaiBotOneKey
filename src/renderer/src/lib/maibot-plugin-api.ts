import type {
  MaiBotInstalledPlugin,
  MaiBotPluginConfigSaveResult,
  MaiBotPluginConfigState,
  MaiBotPluginConfigValue,
  MaiBotMarketPlugin,
  MaiBotPluginListOptions,
  MaiBotPluginListResult,
  MaiBotPluginManifest,
  MaiBotPluginOperationResult,
  MaiBotPluginReadmeResult,
  MaiBotPluginStats,
  ServiceDescriptor,
} from "@shared/contracts";

export type PluginManifest = MaiBotPluginManifest;
export type MarketPlugin = MaiBotMarketPlugin;
export type InstalledPlugin = MaiBotInstalledPlugin;
export type PluginOperationResponse = MaiBotPluginOperationResult;
export type PluginStats = MaiBotPluginStats;
export type PluginReadmeResult = MaiBotPluginReadmeResult;
export type PluginConfigState = MaiBotPluginConfigState;
export type PluginConfigValue = MaiBotPluginConfigValue;
export type PluginConfigSaveResponse = MaiBotPluginConfigSaveResult;

function requirePluginBridge(): NonNullable<typeof window.maibotDesktop>["plugins"] {
  const bridge = window.maibotDesktop?.plugins;
  if (!bridge) {
    throw new Error("Electron plugin bridge is not connected.");
  }
  return bridge;
}

export function maibotServiceBaseUrl(service?: ServiceDescriptor): string {
  try {
    return new URL(service?.url ?? "http://127.0.0.1:8001").origin;
  } catch {
    return "http://127.0.0.1:8001";
  }
}

export function pluginName(plugin: { id: string; manifest: PluginManifest }): string {
  return plugin.manifest.name?.trim() || plugin.id;
}

export function pluginAuthor(manifest: PluginManifest): string {
  if (typeof manifest.author === "string") return manifest.author;
  return manifest.author?.name ?? "Unknown";
}

export function pluginDescription(manifest: PluginManifest): string {
  return manifest.description?.trim() || "暂无描述";
}

export function pluginVersion(manifest: PluginManifest): string {
  return manifest.version?.trim() || "unknown";
}

export function pluginRepositoryUrl(manifest: PluginManifest): string | undefined {
  return manifest.repository_url?.trim() || manifest.urls?.repository?.trim();
}

export function pluginHomepageUrl(manifest: PluginManifest): string | undefined {
  return manifest.homepage_url?.trim() || manifest.urls?.homepage?.trim();
}

export function pluginNeedsUpdate(plugin: MarketPlugin): boolean {
  return Boolean(
    plugin.installed
      && plugin.installedVersion
      && isNewerPluginVersion(pluginVersion(plugin.manifest), plugin.installedVersion),
  );
}

export function comparePluginVersions(left: string | undefined, right: string | undefined): number {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function isNewerPluginVersion(candidate: string | undefined, current: string | undefined): boolean {
  return comparePluginVersions(candidate, current) > 0;
}

export function getPluginCompatibilityReason(
  manifest: PluginManifest,
  maibotVersion: string | undefined,
): string | null {
  if (!maibotVersion) {
    return null;
  }

  const currentParts = normalizeVersion(maibotVersion);
  const manifestVersion = manifest.manifest_version ?? 1;
  if (manifestVersion <= 1 && (currentParts[0] ?? 0) >= 1) {
    return `该插件使用旧版 manifest v${manifestVersion}，不支持 MaiBot ${maibotVersion}`;
  }

  const host = manifest.host_application;
  if (!host) {
    return null;
  }

  if (host.min_version && comparePluginVersions(maibotVersion, host.min_version) < 0) {
    return `需要 MaiBot ${host.min_version}+，当前 ${maibotVersion}`;
  }
  if (host.max_version && comparePluginVersions(maibotVersion, host.max_version) > 0) {
    return `最高支持 MaiBot ${host.max_version}，当前 ${maibotVersion}`;
  }

  return null;
}

export function isPluginCompatible(manifest: PluginManifest, maibotVersion: string | undefined): boolean {
  return getPluginCompatibilityReason(manifest, maibotVersion) === null;
}

function normalizeVersion(version: string | undefined): number[] {
  const normalized = (version ?? "")
    .trim()
    .toLowerCase()
    .replace(/^v/u, "")
    .split(/[+-]/u, 1)[0];

  return normalized.split(/[._-]/u).map((part) => {
    const value = part.match(/^\d+/u)?.[0];
    return value ? Number(value) : 0;
  });
}

export function fetchInstalledPlugins(_service?: ServiceDescriptor): Promise<InstalledPlugin[]> {
  return requirePluginBridge().listInstalled(_service?.url);
}

export function fetchMarketPlugins(
  _service?: ServiceDescriptor,
  options?: MaiBotPluginListOptions,
): Promise<MaiBotPluginListResult> {
  return requirePluginBridge().listMarket(_service?.url, options);
}

export function installMaiBotPlugin(
  _service: ServiceDescriptor | undefined,
  pluginId: string,
  repositoryUrl: string,
  branch: string,
): Promise<PluginOperationResponse> {
  return requirePluginBridge().install({
    pluginId,
    repositoryUrl,
    branch: branch || "main",
  });
}

export function uninstallMaiBotPlugin(
  _service: ServiceDescriptor | undefined,
  pluginId: string,
): Promise<PluginOperationResponse> {
  return requirePluginBridge().uninstall(pluginId);
}

export function updateMaiBotPlugin(
  _service: ServiceDescriptor | undefined,
  pluginId: string,
  repositoryUrl: string,
  branch: string,
  latestVersion?: string,
): Promise<PluginOperationResponse> {
  return requirePluginBridge().update({
    pluginId,
    repositoryUrl,
    branch: branch || "main",
    latestVersion,
  });
}

export function fetchPluginConfig(pluginId: string): Promise<PluginConfigState> {
  return requirePluginBridge().getConfig(pluginId);
}

export function savePluginConfig(
  pluginId: string,
  config: Record<string, PluginConfigValue>,
): Promise<PluginConfigSaveResponse> {
  return requirePluginBridge().saveConfig(pluginId, config);
}

export function fetchPluginReadme(pluginId: string, repositoryUrl?: string): Promise<PluginReadmeResult> {
  return requirePluginBridge().getReadme(pluginId, repositoryUrl);
}

export function fetchPluginStats(pluginId: string): Promise<PluginStats | null> {
  return requirePluginBridge().getStats(pluginId);
}
