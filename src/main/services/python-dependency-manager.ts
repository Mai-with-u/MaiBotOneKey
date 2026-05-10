import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type {
  ManagedPythonPackage,
  ManagedPythonPackageName,
  PythonOverridesState,
  PythonPackageInstallRequest,
  PythonPackageInstallResult,
  PythonPackageVersion,
  PythonPackageVersionList,
  RuntimePaths,
} from "../../shared/contracts";
import { InitManager } from "./init-manager";

const TUNA_PYPI_ROOT = "https://pypi.tuna.tsinghua.edu.cn";
const TUNA_SIMPLE_INDEX = `${TUNA_PYPI_ROOT}/simple`;
const PYPI_SIMPLE_INDEX = "https://pypi.org/simple";
const MANAGED_PACKAGES: ManagedPythonPackage[] = [
  { name: "maibot-dashboard", label: "MaiBot Dashboard" },
  { name: "maim-message", label: "Maim Message" },
];
const REQUEST_TIMEOUT_MS = 60_000;
const PIP_TIMEOUT_MS = 10 * 60 * 1000;
const SIMPLE_ACCEPT = "application/vnd.pypi.simple.v1+json, application/json;q=0.9, text/html;q=0.8";

interface SimpleProjectFile {
  filename?: unknown;
  "upload-time"?: unknown;
  yanked?: unknown;
}

interface SimpleProjectJson {
  files?: SimpleProjectFile[];
  versions?: unknown;
}

interface FetchTextResult {
  contentType: string;
  text: string;
}

interface StartupDependencyUpgradeResult {
  sourceFile: string;
  sourceUrl: string;
  targetDir: string;
  output: string[];
  installedAt: number;
}

type PythonOutputHandler = (line: string) => void;

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

function assertManagedPackage(packageName: ManagedPythonPackageName): void {
  if (!MANAGED_PACKAGES.some((item) => item.name === packageName)) {
    throw new Error(`涓嶆敮鎸佹洿鏂版 Python 渚濊禆: ${packageName}`);
  }
}

function isDevVersion(version: string): boolean {
  return /(?:^|[._+-])dev\d*/iu.test(version);
}

function isPrereleaseVersion(version: string): boolean {
  return isDevVersion(version) || /(?:^|[._+-])(?:a|alpha|b|beta|rc|pre|preview)\d*/iu.test(version);
}

function isYanked(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.length > 0);
}

function uploadTime(raw: unknown): { uploadedAt?: string; uploadedAtMs?: number } {
  if (typeof raw !== "string" || raw.length === 0) {
    return {};
  }

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    return {};
  }

  return {
    uploadedAt: raw,
    uploadedAtMs: timestamp,
  };
}

function sortVersions(versions: PythonPackageVersion[]): PythonPackageVersion[] {
  return versions.sort((left, right) => {
    const byTime = (right.uploadedAtMs ?? 0) - (left.uploadedAtMs ?? 0);
    if (byTime !== 0) {
      return byTime;
    }

    return right.version.localeCompare(left.version, "en-US", { numeric: true, sensitivity: "base" });
  });
}

function versionEntry(version: string, upload?: { uploadedAt?: string; uploadedAtMs?: number }): PythonPackageVersion {
  return {
    version,
    isPrerelease: isPrereleaseVersion(version),
    isDev: isDevVersion(version),
    ...upload,
  };
}

function normalizeProjectName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

function stripArchiveExtension(filename: string): string {
  return filename
    .replace(/\.tar\.gz$/iu, "")
    .replace(/\.tar\.bz2$/iu, "")
    .replace(/\.tar\.xz$/iu, "")
    .replace(/\.zip$/iu, "")
    .replace(/\.whl$/iu, "");
}

function projectPrefixes(packageName: ManagedPythonPackageName): string[] {
  return Array.from(new Set([
    packageName,
    packageName.replace(/[-.]+/gu, "_"),
    normalizeProjectName(packageName),
  ])).sort((left, right) => right.length - left.length);
}

function versionFromFilename(packageName: ManagedPythonPackageName, filename: string): string | undefined {
  const basename = stripArchiveExtension(filename);
  const lowerBasename = basename.toLowerCase();

  for (const prefix of projectPrefixes(packageName)) {
    const marker = `${prefix.toLowerCase()}-`;
    if (!lowerBasename.startsWith(marker)) {
      continue;
    }

    const remainder = basename.slice(marker.length);
    return filename.toLowerCase().endsWith(".whl") ? remainder.split("-")[0] : remainder;
  }

  return undefined;
}

function mergeUploadTime(
  current: PythonPackageVersion | undefined,
  version: string,
  upload?: { uploadedAt?: string; uploadedAtMs?: number },
): PythonPackageVersion {
  if (!current) {
    return versionEntry(version, upload);
  }

  if (upload?.uploadedAtMs !== undefined && (current.uploadedAtMs === undefined || upload.uploadedAtMs > current.uploadedAtMs)) {
    return {
      ...current,
      uploadedAt: upload.uploadedAt,
      uploadedAtMs: upload.uploadedAtMs,
    };
  }

  return current;
}

function buildVersionListFromMap(versions: Map<string, PythonPackageVersion>): PythonPackageVersion[] {
  return sortVersions(Array.from(versions.values()));
}

function parseSimpleJson(packageName: ManagedPythonPackageName, data: SimpleProjectJson): PythonPackageVersion[] {
  const versions = new Map<string, PythonPackageVersion>();

  if (Array.isArray(data.versions)) {
    for (const version of data.versions) {
      if (typeof version === "string" && version.length > 0) {
        versions.set(version, versionEntry(version));
      }
    }
  }

  for (const file of data.files ?? []) {
    if (isYanked(file.yanked) || typeof file.filename !== "string") {
      continue;
    }

    const version = versionFromFilename(packageName, file.filename);
    if (!version) {
      continue;
    }

    versions.set(version, mergeUploadTime(versions.get(version), version, uploadTime(file["upload-time"])));
  }

  return buildVersionListFromMap(versions);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function attributeValue(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu");
  const match = pattern.exec(attrs);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function filenameFromUrl(rawUrl: string): string | undefined {
  const withoutFragment = rawUrl.split("#")[0]?.split("?")[0];
  const rawName = withoutFragment?.split("/").filter(Boolean).pop();
  if (!rawName) {
    return undefined;
  }

  try {
    return decodeURIComponent(rawName);
  } catch {
    return rawName;
  }
}

function parseSimpleHtml(packageName: ManagedPythonPackageName, html: string): PythonPackageVersion[] {
  const versions = new Map<string, PythonPackageVersion>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = attributeValue(match[1] ?? "", "href");
    const filename = href ? filenameFromUrl(href) : decodeHtml((match[2] ?? "").replace(/<[^>]*>/gu, "").trim());
    if (!filename) {
      continue;
    }

    const version = versionFromFilename(packageName, filename);
    if (!version) {
      continue;
    }

    versions.set(version, mergeUploadTime(versions.get(version), version));
  }

  return buildVersionListFromMap(versions);
}

function mergeVersionLists(primary: PythonPackageVersion[], supplemental: PythonPackageVersion[]): PythonPackageVersion[] {
  const supplementalByVersion = new Map(supplemental.map((version) => [version.version, version]));

  return sortVersions(
    primary.map((version) => {
      const extra = supplementalByVersion.get(version.version);
      if (!extra?.uploadedAtMs || version.uploadedAtMs) {
        return version;
      }

      return {
        ...version,
        uploadedAt: extra.uploadedAt,
        uploadedAtMs: extra.uploadedAtMs,
      };
    }),
  );
}

async function fetchText(url: string): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: SIMPLE_ACCEPT },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return {
      contentType: response.headers.get("content-type") ?? "",
      text: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseSimpleResponse(
  packageName: ManagedPythonPackageName,
  response: FetchTextResult,
): PythonPackageVersion[] {
  if (response.contentType.toLowerCase().includes("json")) {
    return parseSimpleJson(packageName, JSON.parse(response.text) as SimpleProjectJson);
  }

  return parseSimpleHtml(packageName, response.text);
}

async function fetchSimpleVersions(packageName: ManagedPythonPackageName, indexUrl: string): Promise<PythonPackageVersion[]> {
  const response = await fetchText(`${indexUrl}/${packageName}/`);
  return parseSimpleResponse(packageName, response);
}

function hasMissingUploadTimes(versions: PythonPackageVersion[]): boolean {
  return versions.some((version) => version.uploadedAtMs === undefined);
}

export class PythonDependencyManager {
  private startupUpgradePromise?: Promise<StartupDependencyUpgradeResult>;
  private startupUpgradeAbort?: AbortController;
  private startupUpgradeChild?: ChildProcessWithoutNullStreams;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly initManager: InitManager,
  ) {}

  getOverridesRoot(): string {
    return join(this.paths.userDataRoot, "python-overrides");
  }

  getState(): PythonOverridesState {
    return {
      root: this.getOverridesRoot(),
      sourceUrl: TUNA_SIMPLE_INDEX,
      packages: MANAGED_PACKAGES,
    };
  }

  buildPythonPathEnv(baseEnv: Record<string, string | undefined> = process.env): Record<string, string> {
    return {
      PYTHONPATH: [this.getOverridesRoot(), baseEnv.PYTHONPATH].filter(Boolean).join(delimiter),
    };
  }

  async listVersions(packageName: ManagedPythonPackageName): Promise<PythonPackageVersionList> {
    assertManagedPackage(packageName);
    const tunaUrl = `${TUNA_SIMPLE_INDEX}/${packageName}/`;
    const output = [`GET ${tunaUrl}`];

    try {
      let versions = await fetchSimpleVersions(packageName, TUNA_SIMPLE_INDEX);
      output.push(`从清华 Simple 索引解析到 ${versions.length} 个版本`);
      if (versions.length === 0) {
        throw new Error("娓呭崕 Simple 绱㈠紩娌℃湁杩斿洖鍙В鏋愮殑鐗堟湰");
      }

      if (hasMissingUploadTimes(versions)) {
        output.push(`娓呭崕 Simple 绱㈠紩缂哄皯閮ㄥ垎鍙戝竷鏃堕棿锛屽皾璇曚粠 ${PYPI_SIMPLE_INDEX}/${packageName}/ 琛ラ綈鎺掑簭淇℃伅`);
        try {
          const supplemental = await fetchSimpleVersions(packageName, PYPI_SIMPLE_INDEX);
          versions = mergeVersionLists(versions, supplemental);
          output.push("发布时间补齐完成，仍以清华源作为安装源");
        } catch (metadataError) {
          output.push(`鍙戝竷鏃堕棿琛ラ綈澶辫触锛屽皢鎸夊彲鐢ㄦ椂闂翠笌鐗堟湰鍙锋帓搴? ${toDetail(metadataError)}`);
        }
      }

      output.push(
        hasMissingUploadTimes(versions)
          ? `鎵惧埌 ${versions.length} 涓増鏈紝宸叉寜鍙敤鍙戝竷鏃堕棿闄嶅簭鎺掑垪锛涚己澶卞彂甯冩椂闂寸殑鐗堟湰鐢ㄧ増鏈彿琛ヤ綅`
          : `鎵惧埌 ${versions.length} 涓増鏈紝宸叉寜鍙戝竷鏃堕棿闄嶅簭鎺掑垪`,
      );
      return {
        packageName,
        sourceUrl: TUNA_SIMPLE_INDEX,
        versions,
        output,
        fetchedAt: Date.now(),
      };
    } catch (error) {
      output.push(`璇诲彇鐗堟湰鍒楄〃澶辫触: ${toDetail(error)}`);
      throw new Error(output.join("\n"));
    }
  }

  async installVersion(request: PythonPackageInstallRequest): Promise<PythonPackageInstallResult> {
    assertManagedPackage(request.packageName);
    if (!request.version.trim()) {
      throw new Error("璇烽€夋嫨瑕佸畨瑁呯殑鐗堟湰");
    }

    const targetDir = this.getOverridesRoot();
    await mkdir(targetDir, { recursive: true });

    const requirement = `${request.packageName}==${request.version.trim()}`;
    const args = [
      "-m",
      "pip",
      "install",
      "--pre",
      "--upgrade",
      "--target",
      targetDir,
      "--index-url",
      TUNA_SIMPLE_INDEX,
      "--trusted-host",
      "pypi.tuna.tsinghua.edu.cn",
      "--timeout",
      "120",
      "--retries",
      "5",
      "--no-deps",
      "--no-compile",
      "--no-warn-script-location",
      requirement,
    ];
    const output = await this.runPython(args);

    return {
      packageName: request.packageName,
      version: request.version.trim(),
      sourceUrl: TUNA_SIMPLE_INDEX,
      targetDir,
      output,
      installedAt: Date.now(),
    };
  }

  async upgradeStartupDependencies(onOutput?: PythonOutputHandler): Promise<StartupDependencyUpgradeResult> {
    if (!this.startupUpgradePromise) {
      const controller = new AbortController();
      this.startupUpgradeAbort = controller;
      this.startupUpgradePromise = this.installProjectDeclaredDependencies(controller.signal, onOutput).finally(() => {
        if (this.startupUpgradeAbort === controller) {
          this.startupUpgradeAbort = undefined;
        }
        this.startupUpgradePromise = undefined;
      });
    }
    return this.startupUpgradePromise;
  }

  cancelStartupUpgrade(): boolean {
    if (!this.startupUpgradeAbort || this.startupUpgradeAbort.signal.aborted) {
      return false;
    }

    const child = this.startupUpgradeChild;
    this.startupUpgradeAbort.abort();
    if (child?.pid) {
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
      } else {
        child.kill("SIGKILL");
      }
    }
    return true;
  }

  private async installProjectDeclaredDependencies(
    signal?: AbortSignal,
    onOutput?: PythonOutputHandler,
  ): Promise<StartupDependencyUpgradeResult> {
    const maibotRoot = join(this.paths.modulesRoot, "MaiBot");
    const requirementsPath = join(maibotRoot, "requirements.txt");
    const pyprojectPath = join(maibotRoot, "pyproject.toml");
    const pyprojectDependencies = existsSync(pyprojectPath)
      ? await this.readPyprojectDependencies(pyprojectPath).catch(() => [])
      : [];
    const sourceFile = pyprojectDependencies.length > 0
      ? pyprojectPath
      : existsSync(requirementsPath)
        ? requirementsPath
        : existsSync(pyprojectPath)
          ? pyprojectPath
          : undefined;

    if (!sourceFile) {
      throw new Error(`鏈壘鍒?MaiBot 渚濊禆澹版槑鏂囦欢: ${requirementsPath} 鎴?${pyprojectPath}`);
    }
    if (sourceFile === pyprojectPath && pyprojectDependencies.length === 0) {
      throw new Error(`MaiBot pyproject.toml 娌℃湁鍙敤鐨?[project.dependencies]: ${pyprojectPath}`);
    }

    const sourceArgs = pyprojectDependencies.length > 0 ? pyprojectDependencies : ["-r", requirementsPath];
    if (pyprojectDependencies.length > 0) {
      onOutput?.(`using pyproject dependencies (${pyprojectDependencies.length} entries)`);
    }

    const satisfied = pyprojectDependencies.length > 0
      ? await this.areDependencySpecifiersSatisfied(pyprojectDependencies)
      : await this.areRequirementsSatisfied(requirementsPath);
    if (satisfied) {
      const output = ["all declared requirements are already satisfied in Python runtime + overrides"];
      for (const line of output) {
        onOutput?.(line);
      }
      return {
        sourceFile,
        sourceUrl: TUNA_SIMPLE_INDEX,
        targetDir: this.getOverridesRoot(),
        output,
        installedAt: Date.now(),
      };
    }

    const targetDir = this.getOverridesRoot();
    await mkdir(targetDir, { recursive: true });

    const args = [
      "-m",
      "pip",
      "install",
      "--upgrade",
      "--upgrade-strategy",
      "only-if-needed",
      "--target",
      targetDir,
      "--index-url",
      TUNA_SIMPLE_INDEX,
      "--trusted-host",
      "pypi.tuna.tsinghua.edu.cn",
      "--timeout",
      "120",
      "--retries",
      "5",
      "--disable-pip-version-check",
      "--no-compile",
      "--no-warn-script-location",
      "--progress-bar",
      "off",
      ...sourceArgs,
    ];
    const output = await this.runPython(args, signal, onOutput);

    return {
      sourceFile,
      sourceUrl: TUNA_SIMPLE_INDEX,
      targetDir,
      output,
      installedAt: Date.now(),
    };
  }

  private async areRequirementsSatisfied(requirementsPath: string): Promise<boolean> {
    const script = String.raw`
import importlib.metadata as metadata
import pathlib
import re
import sys
from packaging.requirements import Requirement

path = pathlib.Path(sys.argv[1])
missing = []
for raw_line in path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or line.startswith(("-", "git+", "http://", "https://")):
        continue
    line = re.sub(r"\s+#.*$", "", line)
    try:
        requirement = Requirement(line)
    except Exception:
        missing.append(f"unparsed requirement: {line}")
        continue
    try:
        version = metadata.version(requirement.name)
    except metadata.PackageNotFoundError:
        missing.append(f"missing: {requirement.name}")
        continue
    if requirement.specifier and not requirement.specifier.contains(version, prereleases=True):
        missing.append(f"version mismatch: {requirement.name} {version} not in {requirement.specifier}")

if missing:
    print("\n".join(missing))
    raise SystemExit(1)
`;

    try {
      await this.runPython(["-c", script, requirementsPath], undefined, undefined, this.buildPythonPathEnv());
      return true;
    } catch {
      return false;
    }
  }

  private async readPyprojectDependencies(pyprojectPath: string): Promise<string[]> {
    const script = String.raw`
import json
import pathlib
import sys

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

data = tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
dependencies = data.get("project", {}).get("dependencies", [])
if not isinstance(dependencies, list):
    dependencies = []
print(json.dumps([item for item in dependencies if isinstance(item, str) and item.strip()]))
`;
    const output = await this.runPython(["-c", script, pyprojectPath]);
    const raw = output.find((line) => line.trim().startsWith("[")) ?? "[]";
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  }

  private async areDependencySpecifiersSatisfied(dependencies: string[]): Promise<boolean> {
    const script = String.raw`
import importlib.metadata as metadata
import json
import sys
from packaging.requirements import Requirement

missing = []
for line in json.loads(sys.argv[1]):
    try:
        requirement = Requirement(line)
    except Exception:
        missing.append(f"unparsed requirement: {line}")
        continue
    if requirement.marker is not None and not requirement.marker.evaluate():
        continue
    try:
        version = metadata.version(requirement.name)
    except metadata.PackageNotFoundError:
        missing.append(f"missing: {requirement.name}")
        continue
    if requirement.specifier and not requirement.specifier.contains(version, prereleases=True):
        missing.append(f"version mismatch: {requirement.name} {version} not in {requirement.specifier}")

if missing:
    print("\n".join(missing))
    raise SystemExit(1)
`;

    try {
      await this.runPython(["-c", script, JSON.stringify(dependencies)], undefined, undefined, this.buildPythonPathEnv());
      return true;
    } catch {
      return false;
    }
  }

  private runPython(
    args: string[],
    signal?: AbortSignal,
    onOutput?: PythonOutputHandler,
    extraEnv?: Record<string, string>,
  ): Promise<string[]> {
    if (onOutput) {
      return this.runPythonStreaming(args, signal, onOutput, extraEnv);
    }

    return new Promise((resolve, reject) => {
      execFile(
        this.initManager.getPythonPath(),
        args,
        {
          cwd: this.paths.installRoot,
          timeout: PIP_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          signal,
          env: {
            ...process.env,
            ...extraEnv,
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
          },
        },
        (error, stdout, stderr) => {
          const output = splitOutput(`${stdout}${stderr}`);
          if (error) {
            reject(new Error(output.join("\n") || toDetail(error)));
            return;
          }

          resolve(output);
        },
      );
    });
  }

  private runPythonStreaming(
    args: string[],
    signal: AbortSignal | undefined,
    onOutput: PythonOutputHandler,
    extraEnv?: Record<string, string>,
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const output: string[] = [];
      const child = spawn(this.initManager.getPythonPath(), args, {
        cwd: this.paths.installRoot,
        windowsHide: true,
        signal,
        env: {
          ...process.env,
          ...extraEnv,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
      });
      this.startupUpgradeChild = child;
      let settled = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error(`Python command timed out after ${Math.round(PIP_TIMEOUT_MS / 1000)}s`));
      }, PIP_TIMEOUT_MS);

      const emitLine = (line: string): void => {
        const normalized = line.trimEnd();
        if (!normalized) {
          return;
        }
        output.push(normalized);
        onOutput(normalized);
      };

      const collect = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
        const current = stream === "stdout" ? stdoutBuffer : stderrBuffer;
        const parts = `${current}${chunk.toString("utf8")}`.replace(/\r(?!\n)/gu, "\n").split(/\n/u);
        const nextBuffer = parts.pop() ?? "";
        for (const part of parts) {
          emitLine(part);
          if (/Installing collected packages/iu.test(part)) {
            emitLine("pip is writing package files; this step can be quiet for a while");
          }
        }
        if (stream === "stdout") {
          stdoutBuffer = nextBuffer;
        } else {
          stderrBuffer = nextBuffer;
        }
      };

      const flush = (): void => {
        emitLine(stdoutBuffer);
        emitLine(stderrBuffer);
        stdoutBuffer = "";
        stderrBuffer = "";
      };

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.startupUpgradeChild === child) {
          this.startupUpgradeChild = undefined;
        }
        clearTimeout(timeout);
        flush();
        if (error) {
          reject(error);
          return;
        }
        resolve(output);
      };

      child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
      child.on("error", (error) => finish(error));
      child.on("close", (code, signalName) => {
        if (code === 0) {
          finish();
          return;
        }

        const detail = output.join("\n") || `Python command exited with code ${code ?? "null"} signal ${signalName ?? "null"}`;
        finish(new Error(detail));
      });
    });
  }
}

