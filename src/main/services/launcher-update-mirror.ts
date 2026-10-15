export const CNB_REPOSITORY = "https://cnb.cool/Mai-with-u/MaiBotOneKey";
export const CNB_UPDATE_MANIFEST = `${CNB_REPOSITORY}/-/git/raw/cnb-updates/latest.json`;
const GITHUB_REPOSITORY = "https://github.com/Mai-with-u/MaiBotOneKey";

export function isOfficialLauncherDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ((url.hostname === "github.com" && url.pathname.startsWith("/Mai-with-u/MaiBotOneKey/releases/download/")) ||
       (url.hostname === "cnb.cool" && url.pathname.startsWith("/Mai-with-u/MaiBotOneKey/-/releases/download/")));
  } catch {
    return false;
  }
}

export interface MirrorAsset {
  name: string;
  size: number;
  sha256: string;
  browser_download_url: string;
  fallback_download_url: string;
}

export interface MirrorRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  assets: MirrorAsset[];
}

export function parseMirrorManifest(value: unknown): { latest: MirrorRelease; releases: MirrorRelease[] } {
  const data = value as { schema?: unknown; latestTag?: unknown; releases?: unknown } | null;
  if (data?.schema !== 1 || typeof data.latestTag !== "string" || !Array.isArray(data.releases) || !data.releases.length) {
    throw new Error("CNB 更新清单格式无效");
  }
  const releases: MirrorRelease[] = data.releases.map((release) => {
    if (!release || typeof release.tag_name !== "string" || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name) ||
        typeof release.name !== "string" || typeof release.body !== "string" || !Array.isArray(release.assets)) {
      throw new Error("CNB 版本信息无效");
    }
    const tag = encodeURIComponent(release.tag_name);
    const assets: MirrorAsset[] = release.assets.map((asset: Record<string, unknown>) => {
      if (!asset || typeof asset.name !== "string" || !asset.name || /[/\\\x00-\x1f]/.test(asset.name) ||
          !Number.isSafeInteger(asset.size) || Number(asset.size) <= 0 ||
          typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
        throw new Error("CNB 安装包信息无效");
      }
      const name = encodeURIComponent(asset.name);
      return { name: asset.name, size: Number(asset.size), sha256: asset.sha256,
        browser_download_url: `${CNB_REPOSITORY}/-/releases/download/${tag}/${name}`,
        fallback_download_url: `${GITHUB_REPOSITORY}/releases/download/${tag}/${name}` };
    });
    return { tag_name: release.tag_name, name: release.name, body: release.body,
      html_url: `${CNB_REPOSITORY}/-/releases/tag/${tag}`, assets };
  });
  const latest = releases.find((release) => release.tag_name === data.latestTag);
  if (!latest) throw new Error("CNB 清单缺少最新版本");
  return { latest, releases };
}

export async function fetchMirrorManifest(fetcher: typeof fetch = fetch) {
  const response = await fetcher(CNB_UPDATE_MANIFEST, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!response.ok) throw new Error(`CNB 更新清单 HTTP ${response.status}`);
  return parseMirrorManifest(await response.json());
}

export async function withDownloadFallback<T>(urls: string[], download: (url: string) => Promise<T>): Promise<T> {
  const errors: unknown[] = [];
  for (const url of new Set(urls)) {
    try { return await download(url); } catch (error) { errors.push(error); }
  }
  throw new AggregateError(errors, `安装包下载失败：${errors.map((error) => error instanceof Error ? error.message : String(error)).join("；")}`);
}
