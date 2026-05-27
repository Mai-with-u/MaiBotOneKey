import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";

export const LAUNCHER_UPDATE_DOWNLOAD_DIR = "updates";

export interface LauncherUpdateCleanupResult {
  removed: string[];
  failed: Array<{
    name: string;
    message: string;
  }>;
}

export function getLauncherUpdateDownloadRoot(paths: RuntimePaths): string {
  return join(paths.userDataRoot, LAUNCHER_UPDATE_DOWNLOAD_DIR);
}

export async function cleanupLauncherUpdateDownloads(paths: RuntimePaths): Promise<LauncherUpdateCleanupResult> {
  const updatesRoot = getLauncherUpdateDownloadRoot(paths);
  let entries;
  try {
    entries = await readdir(updatesRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { removed: [], failed: [] };
    }
    throw error;
  }

  const removed: string[] = [];
  const failed: LauncherUpdateCleanupResult["failed"] = [];

  await Promise.all(
    entries.map(async (entry) => {
      const targetPath = join(updatesRoot, entry.name);
      try {
        await rm(targetPath, { recursive: true, force: true });
        removed.push(entry.name);
      } catch (error: unknown) {
        failed.push({
          name: entry.name,
          message: describeError(error),
        });
      }
    }),
  );

  if (failed.length === 0) {
    await rm(updatesRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return { removed: removed.sort(), failed: failed.sort((a, b) => a.name.localeCompare(b.name)) };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
