import type { GithubSourcePreset, ModuleSourceConfig } from "../../shared/contracts";

export type RemoteSourcePurpose =
  | "module-git"
  | "plugin-market"
  | "plugin-git"
  | "plugin-readme";

const OFFICIAL_GITHUB_BASE_URL = "https://github.com/";
const OFFICIAL_RAW_GITHUB_BASE_URL = "https://raw.githubusercontent.com/";
const OFFICIAL_MAIBOT_REMOTE_URL = "https://github.com/Mai-with-u/MaiBot.git";
const GITHUB_SOURCE_PREFIXES: Partial<Record<GithubSourcePreset, string>> = {
  "gh-proxy-com": "https://gh-proxy.com/",
  "v6-gh-proxy-org": "https://v6.gh-proxy.org/",
  "cdn-gh-proxy-com": "https://cdn.gh-proxy.com/",
  "gitproxy-mrhjx-cn": "https://gitproxy.mrhjx.cn/",
  "ghproxy-net": "https://ghproxy.net/",
  "ghproxy-vip": "https://ghproxy.vip/",
};

export interface RemoteSourceManagerOptions {
  getModuleSourceConfig?: () => Promise<ModuleSourceConfig>;
}

export class RemoteSourceManager {
  private readonly getModuleSourceConfig?: () => Promise<ModuleSourceConfig>;

  constructor(options: RemoteSourceManagerOptions = {}) {
    this.getModuleSourceConfig = options.getModuleSourceConfig;
  }

  async resolveGitHubUrl(
    url: string,
    purpose: RemoteSourcePurpose,
    sourcePreset: GithubSourcePreset = "configured",
  ): Promise<string> {
    if (purpose === "module-git" || !this.getModuleSourceConfig) {
      return sourcePreset === "github" ? normalizeGithubUrl(url) ?? url : this.resolvePresetGitHubUrl(url, sourcePreset);
    }

    if (sourcePreset !== "configured") {
      return this.resolvePresetGitHubUrl(url, sourcePreset);
    }

    try {
      const config = await this.getModuleSourceConfig();
      return rewriteGithubUrl(url, config.maibotUrl);
    } catch {
      return url;
    }
  }

  async resolveOfficialGitHubUrl(url: string): Promise<string> {
    return normalizeGithubUrl(url) ?? url;
  }

  async resolveGitHubReadmeUrl(
    repositoryUrl: string,
    branch: string,
    purpose: RemoteSourcePurpose = "plugin-readme",
    sourcePreset: GithubSourcePreset = "configured",
  ): Promise<string | undefined> {
    const rawUrl = githubRawReadmeUrl(repositoryUrl, branch);
    return rawUrl ? this.resolveGitHubUrl(rawUrl, purpose, sourcePreset) : undefined;
  }

  private resolvePresetGitHubUrl(url: string, sourcePreset: GithubSourcePreset): string {
    if (sourcePreset === "github" || sourcePreset === "configured") {
      return normalizeGithubUrl(url) ?? url;
    }

    const normalized = normalizeGithubUrl(url);
    const prefix = GITHUB_SOURCE_PREFIXES[sourcePreset];
    return normalized && prefix ? `${prefix}${normalized}` : url;
  }
}

function githubRawReadmeUrl(repositoryUrl: string, branch: string): string | undefined {
  const match = repositoryUrl.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#]|$)/iu);
  if (!match) {
    return undefined;
  }
  const [, owner, repo] = match;
  return `${OFFICIAL_RAW_GITHUB_BASE_URL}${owner}/${repo.replace(/\.git$/iu, "")}/${branch}/README.md`;
}

function rewriteGithubUrl(url: string, sourceMaibotUrl: string): string {
  const sourcePrefix = githubSourcePrefix(sourceMaibotUrl);
  if (!sourcePrefix) {
    return url;
  }

  const normalized = normalizeGithubUrl(url);
  return normalized ? `${sourcePrefix}${normalized}` : url;
}

function githubSourcePrefix(sourceMaibotUrl: string): string | undefined {
  const normalizedSource = sourceMaibotUrl.trim();
  const officialSourceIndex = normalizedSource.toLowerCase().indexOf(OFFICIAL_MAIBOT_REMOTE_URL.toLowerCase());
  if (officialSourceIndex > 0) {
    return normalizedSource.slice(0, officialSourceIndex);
  }
  return undefined;
}

function normalizeGithubUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }

  const rawMatch = trimmed.match(/raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s#?]+)\/(.+)$/iu);
  if (rawMatch) {
    const [, owner, repo, rest] = rawMatch;
    return `${OFFICIAL_RAW_GITHUB_BASE_URL}${owner}/${repo.replace(/\.git$/iu, "")}/${rest}`;
  }

  const repoMatch = trimmed.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#]|$)/iu);
  if (!repoMatch) {
    return undefined;
  }

  const [, owner, repo] = repoMatch;
  return `${OFFICIAL_GITHUB_BASE_URL}${owner}/${repo.replace(/\.git$/iu, "")}.git`;
}
