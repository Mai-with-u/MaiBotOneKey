import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveGitPath } from "../../src/main/services/git-runtime";
import { runProcess } from "../../src/main/services/runtime-file-utils";
import { assertSourceCheckout } from "./dev-launch-options";

async function sourceGit(workspace: string): Promise<string> {
  const git = await resolveGitPath(join(workspace, "runtime"));
  if (!git) throw new Error("未找到可用 Git，请先准备内置 Git：bun run runtime:git");
  return git;
}

export async function updateMaiBotSource(workspace: string, sourceRoot: string, dryRun: boolean): Promise<void> {
  const git = await sourceGit(workspace);
  const branch = await runProcess(git, ["branch", "--show-current"], sourceRoot);
  if (branch !== "dev") throw new Error("请先将 MaiBot 源码切换到 dev 分支，再执行 --update。");
  if (await runProcess(git, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"], sourceRoot)) {
    throw new Error("MaiBot 源码有未提交的改动，请先提交或暂存后再更新。");
  }
  console.log(`[dev] 快进更新 origin/dev：${sourceRoot}`);
  if (dryRun) return;
  const pull = Bun.spawn([git, "pull", "--ff-only", "--no-rebase", "--no-autostash", "origin", "dev"], {
    cwd: sourceRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  if (await pull.exited !== 0) throw new Error("MaiBot 源码更新失败，请检查网络或处理本地分支分叉后重试。");
}

export async function prepareMaiBotSource(workspace: string, sourceRoot: string, dryRun: boolean): Promise<void> {
  if (existsSync(sourceRoot)) { assertSourceCheckout(sourceRoot); return; }
  console.log(`[dev] 克隆 MaiBot 官方 dev 分支到：${sourceRoot}`);
  if (dryRun) return;
  const git = await sourceGit(workspace);
  await mkdir(dirname(sourceRoot), { recursive: true });
  const clone = Bun.spawn([git, "clone", "--depth", "1", "--no-single-branch", "--branch", "dev", "https://github.com/Mai-with-u/MaiBot.git", sourceRoot], {
    cwd: workspace, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  if (await clone.exited !== 0) throw new Error("MaiBot 源码克隆失败，请检查网络后重试");
  assertSourceCheckout(sourceRoot);
}
