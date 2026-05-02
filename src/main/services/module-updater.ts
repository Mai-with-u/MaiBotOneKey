import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModuleUpdateResult, RuntimePaths } from "../../shared/contracts";
import { InitManager } from "./init-manager";

const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const MAIBOT_REMOTE_URL = "https://github.com/Mai-with-u/MaiBot.git";

interface GitRunResult {
  output: string[];
}

function splitOutput(output: string): string[] {
  return output
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ModuleUpdater {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly initManager: InitManager,
  ) {}

  async updateMaiBot(): Promise<ModuleUpdateResult> {
    const cwd = join(this.paths.modulesRoot, "MaiBot");
    const gitPath = this.initManager.getGitPath();

    if (!existsSync(gitPath)) {
      throw new Error(`内置 Git 不存在: ${gitPath}`);
    }
    if (!existsSync(cwd)) {
      throw new Error(`MaiBot 模块目录不存在: ${cwd}`);
    }

    const output: string[] = [];
    const append = (label: string, lines: string[]): void => {
      output.push(`$ git ${label}`);
      output.push(...lines);
    };

    if (!existsSync(join(cwd, ".git"))) {
      output.push("未发现 .git，正在把现有 MaiBot 模块接入官方 Git 仓库；不会清理 data/logs/config 等用户数据目录。");
      append("init", (await this.runGit(gitPath, cwd, ["init"], 30_000)).output);
    }

    let remote = await this.readGitValue(gitPath, cwd, ["config", "--get", "remote.origin.url"]);
    if (!remote) {
      append(
        `remote add origin ${MAIBOT_REMOTE_URL}`,
        (await this.runGit(gitPath, cwd, ["remote", "add", "origin", MAIBOT_REMOTE_URL], 30_000)).output,
      );
      remote = MAIBOT_REMOTE_URL;
    }

    const bundledMaiBot = join(this.paths.bundledModulesRoot, "MaiBot");
    const bundledHasGit =
      bundledMaiBot !== cwd && existsSync(join(bundledMaiBot, ".git"));
    if (bundledHasGit) {
      const existingBundledUrl = await this.readGitValue(gitPath, cwd, [
        "config",
        "--get",
        "remote.bundled.url",
      ]);
      if (!existingBundledUrl) {
        append(
          `remote add bundled ${bundledMaiBot}`,
          (await this.runGit(gitPath, cwd, ["remote", "add", "bundled", bundledMaiBot], 30_000)).output,
        );
      } else if (existingBundledUrl !== bundledMaiBot) {
        append(
          `remote set-url bundled ${bundledMaiBot}`,
          (await this.runGit(gitPath, cwd, ["remote", "set-url", "bundled", bundledMaiBot], 30_000)).output,
        );
      }
    }

    const before = await this.readGitValue(gitPath, cwd, ["rev-parse", "--short", "HEAD"]);
    const branch = await this.readGitValue(gitPath, cwd, ["branch", "--show-current"]);
    const statusBefore = await this.readGitValue(gitPath, cwd, ["status", "--short"]);
    if (statusBefore) {
      output.push("检测到 MaiBot 代码工作区存在本地改动；本次强制更新会覆盖代码改动，但不会清理 data/logs/config 等用户数据目录。");
    }

    append("--version", (await this.runGit(gitPath, cwd, ["--version"], 8_000)).output);

    let source: "remote" | "bundled" = "remote";
    let warning: string | undefined;
    let remoteError: string | undefined;
    let upstream: string;

    try {
      append(
        "fetch origin --prune --tags --force --progress",
        (await this.runGit(gitPath, cwd, ["fetch", "origin", "--prune", "--tags", "--force", "--progress"])).output,
      );
      upstream = await this.resolveUpstream(gitPath, cwd, branch);
      append(
        `reset --hard ${upstream}`,
        (await this.runGit(gitPath, cwd, ["reset", "--hard", upstream])).output,
      );
    } catch (originErr) {
      remoteError = toDetail(originErr);
      output.push(`远端 (origin) 拉取失败: ${remoteError}`);
      if (!bundledHasGit) {
        throw new Error(
          `无法连接 GitHub 远端 (${MAIBOT_REMOTE_URL})，且未找到一键包内置兜底仓库可供回退：${remoteError}`,
        );
      }

      output.push(
        "⚠ 网络拉取失败，已自动回退到一键包内置 MaiBot 快照（与本一键包发布日同步，可能落后于上游最新代码）。",
      );
      append(
        "fetch bundled --prune --tags --force",
        (await this.runGit(gitPath, cwd, ["fetch", "bundled", "--prune", "--tags", "--force"])).output,
      );
      const bundledHead =
        (await this.readGitValue(gitPath, cwd, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/bundled/HEAD",
        ])) ?? (branch ? `bundled/${branch}` : "bundled/main");
      upstream = bundledHead;
      append(
        `reset --hard ${upstream}`,
        (await this.runGit(gitPath, cwd, ["reset", "--hard", upstream])).output,
      );
      source = "bundled";
      warning =
        "已回退到一键包内置 MaiBot 快照。该版本仅与本一键包发布时同步，可能落后于上游最新代码；请稍后在网络恢复后再次执行「更新 MaiBot」以拉取最新版本。";
    }

    try {
      append(
        "submodule update --init --recursive --force",
        (await this.runGit(gitPath, cwd, ["submodule", "update", "--init", "--recursive", "--force"])).output,
      );
    } catch (subErr) {
      if (source === "bundled") {
        output.push(`子模块更新跳过（离线兜底模式）: ${toDetail(subErr)}`);
      } else {
        throw subErr;
      }
    }

    const after = await this.readGitValue(gitPath, cwd, ["rev-parse", "--short", "HEAD"]);

    return {
      moduleId: "maibot",
      moduleName: "MaiBot",
      cwd,
      gitPath,
      remote,
      branch,
      upstream,
      before,
      after,
      changed: before ? Boolean(after && before !== after) : Boolean(after),
      output,
      updatedAt: Date.now(),
      source,
      warning,
      remoteError,
    };
  }

  private async resolveUpstream(gitPath: string, cwd: string, branch?: string): Promise<string> {
    const configuredUpstream = await this.readGitValue(gitPath, cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    if (configuredUpstream) {
      return configuredUpstream;
    }

    const originHead = await this.readGitValue(gitPath, cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (originHead) {
      return originHead;
    }

    if (branch) {
      return `origin/${branch}`;
    }

    return "origin/main";
  }

  private async readGitValue(gitPath: string, cwd: string, args: string[]): Promise<string | undefined> {
    try {
      const result = await this.runGit(gitPath, cwd, args, 15_000);
      return result.output.join("\n").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private runGit(
    gitPath: string,
    cwd: string,
    args: string[],
    timeoutMs = UPDATE_TIMEOUT_MS,
  ): Promise<GitRunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        gitPath,
        args,
        {
          cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            GCM_INTERACTIVE: "Never",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C.UTF-8",
            LANG: "C.UTF-8",
          },
        },
        (error, stdout, stderr) => {
          const output = splitOutput(`${stdout}${stderr}`);
          if (error) {
            reject(new Error(output.join("\n") || toDetail(error)));
            return;
          }

          resolve({ output });
        },
      );
    });
  }
}
