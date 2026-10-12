import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceSettingsManager } from "../../src/main/services/source-settings-manager";
import { RemoteSourceManager } from "../../src/main/services/remote-source-manager";
import type { RuntimePaths } from "../../src/shared/contracts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
test("saved source URLs override built-in presets in automatic and explicit resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "maibot-source-")); roots.push(root);
  const sourceSettingsManager = new SourceSettingsManager({ userDataRoot: root } as RuntimePaths);
  await sourceSettingsManager.saveSettings({ github: [{ id: "gh-proxy-com", label: "custom", url: "https://custom.example/" }] });
  const remote = new RemoteSourceManager({ sourceSettingsManager });
  const repo = "https://github.com/Mai-with-u/MaiBot.git";
  for (const preset of ["auto", "gh-proxy-com"] as const) {
    expect(await remote.resolveGitHubUrlCandidates(repo, preset)).toEqual([{ preset: "gh-proxy-com", label: "custom", url: `https://custom.example/${repo}` }]);
  }
  expect((await remote.resolveGitHubReadmeUrlCandidates(repo, "main", "gh-proxy-com"))[0].url).toBe("https://custom.example/https://raw.githubusercontent.com/Mai-with-u/MaiBot/main/README.md");
});
test("default source resolution uses the shared source settings", async () => {
  const candidates = await new RemoteSourceManager().resolveGitHubUrlCandidates("https://github.com/Mai-with-u/MaiBot.git");
  expect(candidates[0].url).toStartWith("https://gitproxy.mrhjx.cn/");
  expect(candidates.some((candidate) => candidate.url === "https://github.com/Mai-with-u/MaiBot.git")).toBe(true);
});
