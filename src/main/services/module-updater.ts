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

    const before = await this.readGitValue(gitPath, cwd, ["rev-parse", "--short", "HEAD"]);
    const branch = await this.readGitValue(gitPath, cwd, ["branch", "--show-current"]);
    const statusBefore = await this.readGitValue(gitPath, cwd, ["status", "--short"]);
    if (statusBefore) {
      output.push("检测到 MaiBot 代码工作区存在本地改动；本次强制更新会覆盖代码改动，但不会清理 data/logs/config 等用户数据目录。");
    }

    append("--version", (await this.runGit(gitPath, cwd, ["--version"], 8_000)).output);
    append(
      "fetch origin --prune --tags --force --progress",
      (await this.runGit(gitPath, cwd, ["fetch", "origin", "--prune", "--tags", "--force", "--progress"])).output,
    );

    const upstream = await this.resolveUpstream(gitPath, cwd, branch);
    append(
      `reset --hard ${upstream}`,
      (await this.runGit(gitPath, cwd, ["reset", "--hard", upstream])).output,
    );
    append(
      "submodule update --init --recursive --force",
      (await this.runGit(gitPath, cwd, ["submodule", "update", "--init", "--recursive", "--force"])).output,
    );

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
