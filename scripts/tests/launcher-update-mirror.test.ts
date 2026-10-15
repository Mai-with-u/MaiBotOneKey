import { expect, test } from "bun:test";
import { CNB_UPDATE_MANIFEST, fetchMirrorManifest, isOfficialLauncherDownloadUrl, parseMirrorManifest, withDownloadFallback } from "../../src/main/services/launcher-update-mirror";

test("launcher downloads allow only the project's CNB and official GitHub endpoints", () => {
  for (const url of [
    "https://cnb.cool/Mai-with-u/MaiBotOneKey/-/releases/download/0.7.0/setup.exe",
    "https://github.com/Mai-with-u/MaiBotOneKey/releases/download/0.7.0/setup.exe",
  ]) expect(isOfficialLauncherDownloadUrl(url)).toBe(true);
  for (const url of [
    "https://ghproxy.example/https://github.com/Mai-with-u/MaiBotOneKey/releases/download/0.7.0/setup.exe",
    "https://github.com.example/Mai-with-u/MaiBotOneKey/releases/download/0.7.0/setup.exe",
    "https://github.com/another/repo/releases/download/0.7.0/setup.exe",
    "http://github.com/Mai-with-u/MaiBotOneKey/releases/download/0.7.0/setup.exe",
    "https://user:password@github.com/Mai-with-u/MaiBotOneKey/releases/download/0.7.0/setup.exe",
    "not a URL",
  ]) expect(isOfficialLauncherDownloadUrl(url)).toBe(false);
});

function manifest() {
  return { schema: 1, latestTag: "0.7.0", releases: [{ tag_name: "0.7.0", name: "0.7.0", body: "更新说明",
    assets: [{ name: "MaiBot OK.exe", size: 1024, sha256: "a".repeat(64) }] }] };
}

test("mirror URLs pin the same tag and filename on both hosts, ignoring supplied URLs", () => {
  const data = manifest();
  Object.assign(data.releases[0].assets[0], { browser_download_url: "https://untrusted.invalid/payload.exe" });
  const { latest } = parseMirrorManifest(data);
  expect(latest.assets[0].browser_download_url).toBe("https://cnb.cool/Mai-with-u/MaiBotOneKey/-/releases/download/0.7.0/MaiBot%20OK.exe");
  expect(latest.assets[0].fallback_download_url).toBe("https://github.com/Mai-with-u/MaiBotOneKey/releases/download/0.7.0/MaiBot%20OK.exe");
});

test("incomplete manifests, unsafe filenames and missing hashes are rejected", () => {
  for (const value of [null, {}, { ...manifest(), latestTag: "0.8.0" }]) {
    expect(() => parseMirrorManifest(value)).toThrow();
  }
  for (const change of [{ name: "../installer.exe" }, { size: 0 }, { sha256: "bad" }]) {
    const data = manifest();
    Object.assign(data.releases[0].assets[0], change);
    expect(() => parseMirrorManifest(data)).toThrow();
  }
  const data = manifest();
  data.releases[0].tag_name = "0.7.0-rc1";
  expect(() => parseMirrorManifest(data)).toThrow();
});

test("public manifest fetch never sends credentials and rejects HTML/login/error responses", async () => {
  const fetcher = (async (_url, options) => {
    expect(_url).toBe(CNB_UPDATE_MANIFEST);
    expect(String(_url)).toContain("/-/git/raw/cnb-updates/latest.json");
    expect(options?.headers).toBeUndefined();
    expect(options?.signal).toBeDefined();
    return Response.json(manifest());
  }) as typeof fetch;
  expect((await fetchMirrorManifest(fetcher)).latest.tag_name).toBe("0.7.0");
  for (const response of [new Response("unauthorized", { status: 401 }), new Response("<html>login</html>")]) {
    await expect(fetchMirrorManifest((async () => response) as typeof fetch)).rejects.toThrow();
  }
});

test("failed or corrupt CNB download retries GitHub and stops after success", async () => {
  const calls: string[] = [];
  expect(await withDownloadFallback(["cnb", "github"], async (url) => {
    calls.push(url);
    if (url === "cnb") throw new Error("SHA-256 mismatch");
    return "installer";
  })).toBe("installer");
  expect(calls).toEqual(["cnb", "github"]);
  calls.length = 0;
  await withDownloadFallback(["cnb", "github"], async (url) => { calls.push(url); });
  expect(calls).toEqual(["cnb"]);
});

test("all-source failure reports both errors without duplicate requests", async () => {
  const calls: string[] = [];
  await expect(withDownloadFallback(["cnb", "cnb", "github"], async (url) => {
    calls.push(url);
    throw new Error(`${url} unavailable`);
  })).rejects.toThrow("cnb unavailable；github unavailable");
  expect(calls).toEqual(["cnb", "github"]);
});
