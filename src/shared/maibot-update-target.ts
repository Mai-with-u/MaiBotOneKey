import type { ModuleUpdateTarget } from "./contracts";

export function publishedStableReleaseTags(
  releases: Array<{ tag_name?: unknown; draft?: unknown; prerelease?: unknown }>,
): string[] {
  return releases
    .filter((release) => release.draft !== true && release.prerelease !== true && typeof release.tag_name === "string")
    .map((release) => (release.tag_name as string).trim())
    .filter(Boolean);
}

export function resolveMaiBotUpdateTarget(
  channel: "stable" | "other",
  stableReleaseTag: string | undefined,
  historyTag: string | undefined,
): ModuleUpdateTarget | undefined {
  if (channel === "stable") {
    return stableReleaseTag ? { type: "package", name: stableReleaseTag.replace(/^v/iu, "") } : undefined;
  }
  return historyTag ? { type: "package", name: historyTag.replace(/^v/iu, "") } : undefined;
}
