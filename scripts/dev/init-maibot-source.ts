import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveGitPath } from "../../src/main/services/git-runtime";
import { assertSourceCheckout, parseDevLaunchOptions } from "./dev-launch-options";

async function main(): Promise<void> {
  const workspace = resolve(import.meta.dir, "../..");
  const options = parseDevLaunchOptions(process.argv.slice(2), workspace, "source");
  if (options.help) {
    console.log("bun run dev:source:init [--source <源码目录>] [--dry-run]");
    return;
  }
  if (options.mode !== "source") throw new Error("该命令只用于准备本地源码");
  if (existsSync(options.sourceRoot)) {
    console.log(`[dev:source:init] 复用已有源码，不更新或覆盖：${assertSourceCheckout(options.sourceRoot)}`);
    return;
  }
  console.log(`[dev:source:init] 克隆 MaiBot 官方 dev 分支到：${options.sourceRoot}`);
  if (options.dryRun) return;
  const git = await resolveGitPath(join(workspace, "runtime"));
  if (!git) throw new Error("未找到可用 Git，请先准备内置 Git：bun run runtime:git");
  await mkdir(dirname(options.sourceRoot), { recursive: true });
  const clone = Bun.spawn([git, "clone", "--depth", "1", "--no-single-branch", "--branch", "dev", "https://github.com/Mai-with-u/MaiBot.git", options.sourceRoot], {
    cwd: workspace, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  if (await clone.exited !== 0) throw new Error("MaiBot 源码克隆失败，请检查网络后重试");
  assertSourceCheckout(options.sourceRoot);
  console.log("[dev:source:init] 准备完成，运行 bun run dev:source 启动本地源码");
}

if (import.meta.main) main().catch((error) => { console.error(`[dev:source:init] ${String(error)}`); process.exitCode = 1; });
