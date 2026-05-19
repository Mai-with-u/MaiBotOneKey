import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ModuleSourceConfig,
  ModuleSourceOption,
  ModuleSourcePreset,
  ModuleSourceUpdate,
  ModuleTagOption,
  ModuleUpdateResult,
  RuntimePaths,
} from "../../shared/contracts";
import { InitManager } from "./init-manager";

const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
/** 单次 git fetch origin 的最长等待时间。失败/超时后会恢复到更新前状态。 */
const FETCH_ORIGIN_TIMEOUT_MS = 15 * 60 * 1000;
const OFFICIAL_MAIBOT_REMOTE_URL = "https://github.com/Mai-with-u/MaiBot.git";
const OFFICIAL_NAPCAT_ADAPTER_REMOTE_URL = "https://github.com/Mai-with-u/MaiBot-Napcat-Adapter.git";
const GHPROXY_MAIBOT_REMOTE_URL = "https://gh.llkk.cc/https://github.com/Mai-with-u/MaiBot.git";
const GHPROXY_NAPCAT_ADAPTER_REMOTE_URL =
  "https://gh.llkk.cc/https://github.com/Mai-with-u/MaiBot-Napcat-Adapter.git";
const SOURCE_CONFIG_FILE = "module-sources.json";
const SOURCE_OPTIONS: ModuleSourceOption[] = [
  {
    preset: "ghproxy",
    label: "GitHub 镜像代理",
    maibotUrl: GHPROXY_MAIBOT_REMOTE_URL,
    napcatAdapterUrl: GHPROXY_NAPCAT_ADAPTER_REMOTE_URL,
  },
  {
    preset: "official",
    label: "官方 GitHub",
    maibotUrl: OFFICIAL_MAIBOT_REMOTE_URL,
    napcatAdapterUrl: OFFICIAL_NAPCAT_ADAPTER_REMOTE_URL,
  },
];

interface GitRunResult {
  output: string[];
}

interface RepoUpdateSpec {
  moduleId: ModuleUpdateResult["moduleId"];
  moduleName: string;
  cwd: string;
  bundledDir: string;
  remoteUrl: string;
  defaultBranch: string;
  /** 是否在更新失败时把错误抛到外层（false 时仅返回 result，原地保留错误信息）。 */
  throwOnFailure: boolean;
  /** 是否执行 git submodule 更新（仅主仓需要）。 */
  runSubmodule: boolean;
  targetTag?: string;
}

function isPrereleaseTag(tag: string): boolean {
  return /(?:^|[._+-])(?:a|alpha|b|beta|rc|pre|preview|dev)\d*/iu.test(tag);
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
  private readonly sourceConfigPath: string;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly initManager: InitManager,
  ) {
    this.sourceConfigPath = join(paths.userDataRoot, SOURCE_CONFIG_FILE);
  }

  async getSourceConfig(): Promise<ModuleSourceConfig> {
    return this.resolveSourceConfig(await this.readStoredSourceConfig());
  }

  async saveSourceConfig(update: ModuleSourceUpdate): Promise<ModuleSourceConfig> {
    const config = this.resolveSourceConfig(update);
    await mkdir(dirname(this.sourceConfigPath), { recursive: true });
    await writeFile(
      this.sourceConfigPath,
      `${JSON.stringify(
        {
          version: 1,
          preset: config.preset,
          maibotUrl: config.maibotUrl,
          napcatAdapterUrl: config.napcatAdapterUrl,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return config;
  }

  async listMaiBotTags(): Promise<ModuleTagOption[]> {
    const gitPath = this.initManager.getGitPath();
    const sourceConfig = await this.getSourceConfig();
    const result = await this.runGit(
      gitPath,
      this.paths.installRoot,
      ["ls-remote", "--tags", "--refs", sourceConfig.maibotUrl],
      FETCH_ORIGIN_TIMEOUT_MS,
    );
    return result.output
      .map((line) => line.match(/refs\/tags\/(.+)$/u)?.[1])
      .filter((tag): tag is string => Boolean(tag))
      .sort((left, right) => right.localeCompare(left, "en-US", { numeric: true, sensitivity: "base" }))
      .slice(0, 80)
      .map((name) => ({ name, isPrerelease: isPrereleaseTag(name) }));
  }

  async updateMaiBot(targetTag?: string): Promise<ModuleUpdateResult> {
    const gitPath = this.initManager.getGitPath();
    if (!existsSync(gitPath)) {
      throw new Error(`未找到可用 Git: ${gitPath}`);
    }

    const sourceConfig = await this.getSourceConfig();

    // 主仓
    const mainResult = await this.updateGitRepository(gitPath, {
      moduleId: "maibot",
      moduleName: "MaiBot",
      cwd: this.paths.maibotRoot,
      bundledDir: join(this.paths.bundledModulesRoot, "MaiBot"),
      remoteUrl: sourceConfig.maibotUrl,
      defaultBranch: "main",
      throwOnFailure: true,
      runSubmodule: true,
      targetTag: targetTag?.trim() || undefined,
    });
    return mainResult;
  }

  /**
   * 直接用一键包内置的 napcat-adapter 快照覆盖可写目录里的对应插件，不走任何网络。
   * 适用场景：用户因 .gitignore 历史问题导致 plugins/napcat-adapter/runtime/ 缺失，
   * 报 `[E_PLUGIN_NOT_FOUND] No module named '_maibot_plugin_maibot_team_napcat_adapter.runtime'`，
   * 又不想等 git fetch 联网。强制清空再整目录复制 bundled，含 .git。
   */
  async repairNapcatAdapterFromBundled(): Promise<ModuleUpdateResult> {
    const moduleId: ModuleUpdateResult["moduleId"] = "napcat-adapter";
    const moduleName = "napcat-adapter";
    const cwd = join(this.paths.maibotRoot, "plugins", "napcat-adapter");
    const bundled = join(this.paths.bundledModulesRoot, "MaiBot", "plugins", "napcat-adapter");
    const gitPath = this.initManager.getGitPath();
    const output: string[] = [];

    if (!existsSync(bundled)) {
      throw new Error(`一键包内置的 napcat-adapter 模板缺失: ${bundled}`);
    }
    let bundledStat: Awaited<ReturnType<typeof stat>>;
    try {
      bundledStat = await stat(bundled);
    } catch (err) {
      throw new Error(`无法读取一键包内置 napcat-adapter 模板: ${toDetail(err)}`);
    }
    if (!bundledStat.isDirectory()) {
      throw new Error(`一键包内置 napcat-adapter 路径不是目录: ${bundled}`);
    }

    output.push(`[${moduleName}] 使用一键包内置快照修复（不联网，强制覆盖整个插件目录）。`);
    output.push(`[${moduleName}] 来源: ${bundled}`);
    output.push(`[${moduleName}] 目标: ${cwd}`);

    if (existsSync(cwd)) {
      output.push(`[${moduleName}] 删除既有目录...`);
      await rm(cwd, { recursive: true, force: true });
    }

    output.push(`[${moduleName}] 复制内置快照（含 .git）...`);
    await cp(bundled, cwd, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });

    let after: string | undefined;
    if (existsSync(join(cwd, ".git"))) {
      after = await this.readGitValue(gitPath, cwd, ["rev-parse", "--short", "HEAD"]);
    }

    output.push(`[${moduleName}] ✓ 修复完成。`);

    return {
      moduleId,
      moduleName,
      cwd,
      gitPath,
      changed: true,
      after,
      output,
      updatedAt: Date.now(),
      source: "bundled",
      warning:
        "已使用一键包内置 napcat-adapter 快照覆盖修复。此快照与本一键包发布日同步，可能落后于上游最新代码；建议稍后在网络恢复时点击「更新 MaiBot」拉取最新版本。",
    };
  }

  private async updateGitRepository(
    gitPath: string,
    spec: RepoUpdateSpec,
  ): Promise<ModuleUpdateResult> {
    const { cwd, bundledDir, remoteUrl, defaultBranch, moduleId, moduleName } = spec;

    if (!existsSync(cwd)) {
      // 模块目录不存在：若 bundled 里有，则尝试从 bundled 复制 .git 后再走 reset 流程；
      // 这里简单抛错让上层（init-manager 的 ensure 流程）先确保目录存在。
      throw new Error(`模块目录不存在: ${cwd}`);
    }

    const output: string[] = [];
    const append = (label: string, lines: string[]): void => {
      output.push(`$ git ${label}`);
      output.push(...lines);
    };

    if (!existsSync(join(cwd, ".git"))) {
      output.push(
        `[${moduleName}] 未发现 .git，正在接入官方 Git 仓库；不会清理 data/logs/config 等用户数据目录。`,
      );
      append(`[${moduleName}] init`, (await this.runGit(gitPath, cwd, ["init"], 30_000)).output);
    }

    let remote = await this.readGitValue(gitPath, cwd, ["config", "--get", "remote.origin.url"]);
    const originalRemote = remote;
    const hadOriginRemote = Boolean(remote);
    if (!remote) {
      append(
        `[${moduleName}] remote add origin ${remoteUrl}`,
        (await this.runGit(gitPath, cwd, ["remote", "add", "origin", remoteUrl], 30_000)).output,
      );
      remote = remoteUrl;
    } else if (remote !== remoteUrl) {
      append(
        `[${moduleName}] remote set-url origin ${remoteUrl}`,
        (await this.runGit(gitPath, cwd, ["remote", "set-url", "origin", remoteUrl], 30_000)).output,
      );
      remote = remoteUrl;
    }

    const bundledHasGit = bundledDir !== cwd && existsSync(join(bundledDir, ".git"));
    if (bundledHasGit) {
      const existingBundledUrl = await this.readGitValue(gitPath, cwd, [
        "config",
        "--get",
        "remote.bundled.url",
      ]);
      if (!existingBundledUrl) {
        append(
          `[${moduleName}] remote add bundled ${bundledDir}`,
          (await this.runGit(gitPath, cwd, ["remote", "add", "bundled", bundledDir], 30_000)).output,
        );
      } else if (existingBundledUrl !== bundledDir) {
        append(
          `[${moduleName}] remote set-url bundled ${bundledDir}`,
          (await this.runGit(gitPath, cwd, ["remote", "set-url", "bundled", bundledDir], 30_000)).output,
        );
      }
    }

    const before = await this.readGitValue(gitPath, cwd, ["rev-parse", "--short", "HEAD"]);
    const branch = await this.readGitValue(gitPath, cwd, ["branch", "--show-current"]);
    const statusBefore = await this.readGitValue(gitPath, cwd, ["status", "--short"]);
    if (statusBefore) {
      output.push(
        `[${moduleName}] 检测到工作区存在本地改动；本次强制更新会覆盖代码改动，但不会清理 data/logs/config 等用户数据目录。`,
      );
    }

    let warning: string | undefined;
    let remoteError: string | undefined;
    let upstream: string;

    try {
      append(
        `[${moduleName}] fetch origin --prune --tags --force --progress (timeout ${Math.round(FETCH_ORIGIN_TIMEOUT_MS / 1000)}s)`,
        (
          await this.runGit(
            gitPath,
            cwd,
            ["fetch", "origin", "--prune", "--tags", "--force", "--progress"],
            FETCH_ORIGIN_TIMEOUT_MS,
          )
        ).output,
      );
      upstream = spec.targetTag ? `refs/tags/${spec.targetTag}` : await this.resolveUpstream(gitPath, cwd, branch ?? defaultBranch);
      append(
        `[${moduleName}] reset --hard ${upstream}`,
        (await this.runGit(gitPath, cwd, ["reset", "--hard", upstream])).output,
      );
    } catch (originErr) {
      remoteError = toDetail(originErr);
      output.push(`[${moduleName}] 远端拉取或更新失败: ${remoteError}`);
      await this.restoreRepositoryBeforeUpdate(gitPath, cwd, moduleName, before, originalRemote, hadOriginRemote, output);
      const failure = spec.targetTag
        ? `无法拉取远端 tag ${spec.targetTag}，已恢复到更新前状态: ${remoteError}`
        : `远端更新失败，已恢复到更新前状态: ${remoteError}`;
      if (spec.throwOnFailure) {
        throw new Error(failure);
      }
      return {
        moduleId,
        moduleName,
        cwd,
        gitPath,
        remote: originalRemote ?? remote,
        branch,
        before,
        changed: false,
        output: [...output, failure],
        updatedAt: Date.now(),
        source: "remote",
        warning: failure,
        remoteError,
      };
    }

    if (spec.runSubmodule) {
      try {
        append(
          `[${moduleName}] submodule update --init --recursive --force`,
          (await this.runGit(gitPath, cwd, ["submodule", "update", "--init", "--recursive", "--force"])).output,
        );
      } catch (subErr) {
        if (spec.throwOnFailure) {
          const remoteError = toDetail(subErr);
          output.push(`[${moduleName}] 子模块更新失败: ${remoteError}`);
          await this.restoreRepositoryBeforeUpdate(gitPath, cwd, moduleName, before, originalRemote, hadOriginRemote, output);
          throw new Error(`子模块更新失败，已恢复到更新前状态: ${remoteError}`);
        } else {
          output.push(`[${moduleName}] 子模块更新失败（已忽略）: ${toDetail(subErr)}`);
        }
      }
    }

    const after = await this.readGitValue(gitPath, cwd, ["rev-parse", "--short", "HEAD"]);

    return {
      moduleId,
      moduleName,
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
      source: "remote",
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

  private async restoreRepositoryBeforeUpdate(
    gitPath: string,
    cwd: string,
    moduleName: string,
    before: string | undefined,
    originalRemote: string | undefined,
    hadOriginRemote: boolean,
    output: string[],
  ): Promise<void> {
    try {
      if (before) {
        output.push(`[${moduleName}] 恢复到更新前提交 ${before} ...`);
        output.push(...(await this.runGit(gitPath, cwd, ["reset", "--hard", before], 60_000)).output);
      }
    } catch (restoreError) {
      output.push(`[${moduleName}] 恢复提交失败: ${toDetail(restoreError)}`);
    }

    try {
      if (hadOriginRemote && originalRemote) {
        output.push(`[${moduleName}] 恢复 origin: ${originalRemote}`);
        output.push(...(await this.runGit(gitPath, cwd, ["remote", "set-url", "origin", originalRemote], 30_000)).output);
      } else {
        output.push(`[${moduleName}] 移除本次新增的 origin`);
        output.push(...(await this.runGit(gitPath, cwd, ["remote", "remove", "origin"], 30_000)).output);
      }
    } catch (restoreError) {
      output.push(`[${moduleName}] 恢复 origin 失败: ${toDetail(restoreError)}`);
    }
  }

  private async readStoredSourceConfig(): Promise<ModuleSourceUpdate | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.sourceConfigPath, "utf8")) as Partial<ModuleSourceUpdate>;
      return {
        preset: raw.preset ?? "ghproxy",
        maibotUrl: raw.maibotUrl,
        napcatAdapterUrl: raw.napcatAdapterUrl,
      };
    } catch {
      return undefined;
    }
  }

  private resolveSourceConfig(update?: ModuleSourceUpdate): ModuleSourceConfig {
    const preset = this.normalizePreset(update?.preset);
    const option = SOURCE_OPTIONS.find((item) => item.preset === preset);
    const maibotUrl = preset === "custom" ? update?.maibotUrl?.trim() : option?.maibotUrl;
    const napcatAdapterUrl = preset === "custom" ? update?.napcatAdapterUrl?.trim() : option?.napcatAdapterUrl;

    if (!maibotUrl || !napcatAdapterUrl) {
      throw new Error("自定义模块更新源需要同时填写 MaiBot 与 napcat-adapter 仓库地址。");
    }

    return {
      preset,
      maibotUrl,
      napcatAdapterUrl,
      options: SOURCE_OPTIONS,
    };
  }

  private normalizePreset(preset: ModuleSourcePreset | undefined): ModuleSourcePreset {
    return preset === "official" || preset === "custom" ? preset : "ghproxy";
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
