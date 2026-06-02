import type { GithubSourcePreset } from "../../shared/contracts";
import { SourceSettingsManager } from "./source-settings-manager";

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
  sourceSettingsManager?: SourceSettingsManager;
}

export interface ResolvedGitHubUrlCandidate {
  preset: GithubSourcePreset;
  label: string;
  url: string;
}

export class RemoteSourceManager {
  private readonly sourceSettingsManager?: SourceSettingsManager;

  constructor(options: RemoteSourceManagerOptions = {}) {
    this.sourceSettingsManager = options.sourceSettingsManager;
  }

  async resolveGitHubUrlCandidates(
    url: string,
    sourcePreset: GithubSourcePreset = "auto",
  ): Promise<ResolvedGitHubUrlCandidate[]> {
    const candidates: ResolvedGitHubUrlCandidate[] = [];
    const seen = new Set<string>();
    const pushCandidate = (preset: GithubSourcePreset, label: string): void => {
      const resolvedUrl = preset === "github"
        ? normalizeGithubUrl(url) ?? url
        : this.resolvePresetGitHubUrl(url, preset);
      const key = resolvedUrl.trim().toLowerCase();
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({ preset, label, url: resolvedUrl });
    };

    const settingsSources = this.sourceSettingsManager?.getGitSources() ?? [];
    if (sourcePreset === "auto") {
      for (const source of settingsSources) {
        const preset = source.id === "official" ? "github" : source.id;
        pushCandidate(preset, source.label);
      }
      if (candidates.length === 0) {
        pushCandidate("github", "GitHub");
      }
      return candidates;
    }

    const normalizedPreset = sourcePreset === "official" ? "github" : sourcePreset;
    const selectedSource = settingsSources.find((source) => source.id === sourcePreset || source.id === normalizedPreset);
    pushCandidate(normalizedPreset, selectedSource?.label ?? (normalizedPreset === "github" ? "GitHub" : normalizedPreset));
    return candidates;
  }

  async resolveGitHubReadmeUrlCandidates(
    repositoryUrl: string,
    branch: string,
    sourcePreset: GithubSourcePreset = "auto",
  ): Promise<ResolvedGitHubUrlCandidate[]> {
    const rawUrl = githubRawReadmeUrl(repositoryUrl, branch);
    return rawUrl ? this.resolveGitHubUrlCandidates(rawUrl, sourcePreset) : [];
  }

  private resolvePresetGitHubUrl(url: string, sourcePreset: GithubSourcePreset): string {
    if (sourcePreset === "github") {
      return normalizeGithubUrl(url) ?? url;
    }

    const normalized = normalizeGithubUrl(url);
    if (!normalized) {
      return url;
    }

    const sourceBaseUrl = GITHUB_SOURCE_PREFIXES[sourcePreset] ?? this.sourceSettingsManager
      ?.getGitSources()
      .find((source) => source.id === sourcePreset)
      ?.url;
    if (isOfficialGithubBase(sourceBaseUrl)) {
      return normalized;
    }

    const prefix = githubSourceBasePrefix(sourceBaseUrl);
    return prefix ? `${prefix}${normalized}` : url;
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

function githubSourceBasePrefix(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  const officialSourceIndex = trimmed.toLowerCase().indexOf(OFFICIAL_MAIBOT_REMOTE_URL.toLowerCase());
  if (officialSourceIndex > 0) {
    return trimmed.slice(0, officialSourceIndex);
  }
  return `${trimmed.replace(/\/+$/u, "")}/`;
}

function isOfficialGithubBase(baseUrl: string | undefined): boolean {
  return baseUrl?.trim().replace(/\/+$/u, "").toLowerCase() === "https://github.com";
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
