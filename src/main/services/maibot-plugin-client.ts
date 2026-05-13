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
  MaiBotMarketPlugin,
  MaiBotPluginListResult,
  MaiBotPluginManifest,
  MaiBotPluginOperationResult,
} from "../../shared/contracts";

const MARKET_URL =
  "https://raw.githubusercontent.com/Mai-with-u/plugin-repo/main/plugin_details.json";
const MARKET_TIMEOUT_MS = 10_000;
const PLUGIN_CONFIG_FILE = "config.toml";

export interface MaiBotPluginClientOptions {
  maibotRoot: string;
  gitPath: string;
}

interface GitRunResult {
  exitCode: number;
  output: string;
}

export class MaiBotPluginClient {
  private readonly maibotRoot: string;

  private readonly pluginsRoot: string;

  private readonly gitPath: string;

  constructor(options: MaiBotPluginClientOptions) {
    this.maibotRoot = resolve(options.maibotRoot);
    this.pluginsRoot = resolve(this.maibotRoot, "plugins");
    this.gitPath = options.gitPath;
  }

  async listInstalled(): Promise<MaiBotInstalledPlugin[]> {
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
        loaded: false,
        load_status: enabled ? "offline" : "disabled",
      });
    }

    return plugins.sort((left, right) => pluginName(left).localeCompare(pluginName(right), "zh-CN"));
  }

  async listMarket(): Promise<MaiBotPluginListResult> {
    const installed = await this.listInstalled();
    const response = await fetchWithTimeout(MARKET_URL);
    if (!response.ok) {
      throw new Error(`Plugin market list failed: HTTP ${response.status}`);
    }

    const rawList = (await response.json()) as unknown;
    const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
    const sourceList = Array.isArray(rawList) ? rawList : [];
    const market = sourceList
      .map(normalizeMarketPlugin)
      .filter((plugin): plugin is MaiBotMarketPlugin => plugin !== null)
      .map((plugin) => {
        const installedPlugin = installedById.get(plugin.id);
        return {
          ...plugin,
          installed: Boolean(installedPlugin),
          installedVersion: installedPlugin ? pluginVersion(installedPlugin.manifest) : undefined,
        };
      });

    return { installed, market };
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

  const item = raw as { id?: string; manifest?: MaiBotPluginManifest; source?: string };
  const manifest = item.manifest;
  const id = manifest?.id?.trim() || item.id?.trim();
  if (!manifest || !id || !manifest.name || !manifest.version) {
    return null;
  }

  return { id, manifest: { ...manifest, id }, source: item.source };
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

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKET_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
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
