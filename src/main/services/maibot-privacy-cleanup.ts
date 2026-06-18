import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";

const CLEANUP_VERSION = "0.4.12";
const CLEANUP_STATE_FILE = "maibot-privacy-cleanup-0.4.12.json";

interface MaiSakaPromptCleanupSpec {
  category: string;
  matches: (name: string) => boolean;
}

const qqGroupPromptDirPattern = /^qq_group_\d+$/u;
const localWebUiPromptDir = "webui_private_webui_user_onekey-local-user";

const leakedMaiSakaPromptSpecs: MaiSakaPromptCleanupSpec[] = [
  { category: "expression_learner", matches: (name) => qqGroupPromptDirPattern.test(name) },
  { category: "planner", matches: (name) => qqGroupPromptDirPattern.test(name) || name === localWebUiPromptDir },
  { category: "replyer", matches: (name) => qqGroupPromptDirPattern.test(name) || name === localWebUiPromptDir },
];

const leakedRuntimeLogDirs = [
  "expression_review",
  "plugin_runtime_debug",
];

interface CleanupState {
  version: 1;
  cleanupVersion: string;
  cleanedAt: number;
  removed: {
    promptDirs: number;
    llmRequestEntries: number;
    appLogFiles: number;
    extraLogDirs: number;
  };
}

export interface MaiBotPrivacyCleanupResult {
  skipped: boolean;
  statePath: string;
  logsRoot: string;
  removedPromptDirs: string[];
  removedLlmRequestEntries: string[];
  removedAppLogFiles: string[];
  removedExtraLogDirs: string[];
}

function cleanupStatePath(paths: RuntimePaths): string {
  return join(paths.userDataRoot, CLEANUP_STATE_FILE);
}

function isSameOrInsidePath(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  if (rootPath === targetPath) {
    return true;
  }
  const diff = relative(rootPath, targetPath);
  return Boolean(diff) && diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff);
}

async function hasCompletedCleanup(statePath: string): Promise<boolean> {
  if (!existsSync(statePath)) {
    return false;
  }
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as Partial<CleanupState>;
    return state.cleanupVersion === CLEANUP_VERSION;
  } catch {
    return false;
  }
}

async function removePathInside(root: string, targetPath: string): Promise<boolean> {
  if (!existsSync(targetPath)) {
    return false;
  }
  if (!isSameOrInsidePath(root, targetPath)) {
    throw new Error(`拒绝清理不在允许目录内的路径: ${targetPath}`);
  }
  await rm(targetPath, { recursive: true, force: true });
  return true;
}

async function removeDirectoryContents(root: string, targetPath: string): Promise<string[]> {
  if (!existsSync(targetPath)) {
    return [];
  }
  if (!isSameOrInsidePath(root, targetPath)) {
    throw new Error(`拒绝清理不在允许目录内的路径: ${targetPath}`);
  }
  const targetStat = await stat(targetPath);
  if (!targetStat.isDirectory()) {
    await rm(targetPath, { force: true });
    return [targetPath];
  }

  const removed: string[] = [];
  const entries = await readdir(targetPath);
  for (const entry of entries) {
    const entryPath = join(targetPath, entry);
    await rm(entryPath, { recursive: true, force: true });
    removed.push(entryPath);
  }
  return removed;
}

async function removeAppJsonlLogs(logsRoot: string): Promise<string[]> {
  if (!existsSync(logsRoot)) {
    return [];
  }

  const removed: string[] = [];
  const entries = await readdir(logsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^app_.*\.log\.jsonl$/u.test(entry.name)) {
      continue;
    }
    const entryPath = join(logsRoot, entry.name);
    if (await removePathInside(logsRoot, entryPath)) {
      removed.push(entryPath);
    }
  }
  return removed;
}

async function removeLeakedMaiSakaPromptDirs(logsRoot: string): Promise<string[]> {
  const promptRoot = join(logsRoot, "maisaka_prompt");
  const removed: string[] = [];

  for (const spec of leakedMaiSakaPromptSpecs) {
    const categoryRoot = join(promptRoot, spec.category);
    if (!existsSync(categoryRoot)) {
      continue;
    }
    if (!isSameOrInsidePath(logsRoot, categoryRoot)) {
      throw new Error(`拒绝清理不在允许目录内的路径: ${categoryRoot}`);
    }
    const entries = await readdir(categoryRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !spec.matches(entry.name)) {
        continue;
      }
      const targetPath = join(categoryRoot, entry.name);
      if (await removePathInside(logsRoot, targetPath)) {
        removed.push(targetPath);
      }
    }
  }

  return removed;
}

export async function cleanupMaiBotPrivacyLeakOnce(paths: RuntimePaths): Promise<MaiBotPrivacyCleanupResult> {
  const statePath = cleanupStatePath(paths);
  const logsRoot = join(paths.maibotRoot, "logs");
  const skipped = await hasCompletedCleanup(statePath);
  if (skipped) {
    return {
      skipped: true,
      statePath,
      logsRoot,
      removedPromptDirs: [],
      removedLlmRequestEntries: [],
      removedAppLogFiles: [],
      removedExtraLogDirs: [],
    };
  }

  const removedPromptDirs = await removeLeakedMaiSakaPromptDirs(logsRoot);
  const removedLlmRequestEntries = await removeDirectoryContents(logsRoot, join(logsRoot, "llm_request"));

  const removedExtraLogDirs: string[] = [];
  for (const dirName of leakedRuntimeLogDirs) {
    const targetPath = join(logsRoot, dirName);
    if (await removePathInside(logsRoot, targetPath)) {
      removedExtraLogDirs.push(targetPath);
    }
  }

  const removedAppLogFiles = await removeAppJsonlLogs(logsRoot);

  await mkdir(paths.userDataRoot, { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        cleanupVersion: CLEANUP_VERSION,
        cleanedAt: Date.now(),
        removed: {
          promptDirs: removedPromptDirs.length,
          llmRequestEntries: removedLlmRequestEntries.length,
          appLogFiles: removedAppLogFiles.length,
          extraLogDirs: removedExtraLogDirs.length,
        },
      } satisfies CleanupState,
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    skipped: false,
    statePath,
    logsRoot,
    removedPromptDirs,
    removedLlmRequestEntries,
    removedAppLogFiles,
    removedExtraLogDirs,
  };
}
