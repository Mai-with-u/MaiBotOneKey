import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type {
  ManagedPythonPackage,
  ManagedPythonPackageName,
  PythonOverridesState,
  PythonPackageSourceOption,
  PythonPackageSourcePreset,
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
const ALIYUN_SIMPLE_INDEX = "https://mirrors.aliyun.com/pypi/simple";
const PYTHON_SOURCE_FILE = "python-dependency-source.json";
const PIP_INDEXES: Array<PythonPackageSourceOption & { trustedHost?: string }> = [
  { preset: "tuna", label: "清华源", url: TUNA_SIMPLE_INDEX, trustedHost: "pypi.tuna.tsinghua.edu.cn" },
  { preset: "pypi", label: "官方 PyPI", url: PYPI_SIMPLE_INDEX },
  { preset: "aliyun", label: "阿里源", url: ALIYUN_SIMPLE_INDEX, trustedHost: "mirrors.aliyun.com" },
] as const;
const MANAGED_PACKAGES: ManagedPythonPackage[] = [
  { name: "maibot-dashboard", label: "MaiBot Dashboard" },
  { name: "maim-message", label: "Maim Message" },
];
const PYTHON_OVERLAY_TARGET_ENV = "MAIBOT_PYTHON_OVERLAY_TARGET";
const REQUEST_TIMEOUT_MS = 60_000;
const PIP_TIMEOUT_MS = 10 * 60 * 1000;
const STARTUP_UPGRADE_IDLE_TIMEOUT_MS = 10_000;
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

interface UnsatisfiedDependency {
  requirement: string;
  reason: string;
}

interface PipInstallAttemptResult {
  output: string[];
  sourceUrl: string;
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

function assertManagedPackage(packageName: ManagedPythonPackageName): void {
  if (!MANAGED_PACKAGES.some((item) => item.name === packageName)) {
    throw new Error(`Updating this Python dependency is not supported: ${packageName}`);
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

function packageImportName(name: string): string {
  return normalizeProjectName(name).replace(/-/gu, "_");
}

function packageNameFromRequirement(requirement: string): string | undefined {
  return requirement.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/u)?.[1];
}

async function readRequirementsFile(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  return text
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/u, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("-") && !/^git\+|^https?:\/\//iu.test(line));
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
    return this.paths.pythonOverridesRoot;
  }

  getSourcePreset(): PythonPackageSourcePreset {
    try {
      const raw = JSON.parse(readFileSync(this.sourceConfigPath(), "utf8")) as { preset?: unknown };
      return this.normalizeSourcePreset(raw.preset);
    } catch {
      return "tuna";
    }
  }

  async saveSourcePreset(preset: PythonPackageSourcePreset): Promise<PythonOverridesState> {
    const nextPreset = this.normalizeSourcePreset(preset);
    const path = this.sourceConfigPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ version: 1, preset: nextPreset, updatedAt: Date.now() }, null, 2)}\n`,
      "utf8",
    );
    return this.getState();
  }

  getState(): PythonOverridesState {
    const sourcePreset = this.getSourcePreset();
    return {
      root: this.getOverridesRoot(),
      sourcePreset,
      sourceUrl: this.getPrimaryIndex().url,
      sourceOptions: PIP_INDEXES.map(({ preset, label, url }) => ({ preset, label, url })),
      packages: MANAGED_PACKAGES,
    };
  }

  buildPythonPathEnv(baseEnv: Record<string, string | undefined> = process.env): Record<string, string> {
    const overridesRoot = this.getOverridesRoot();
    return {
      PYTHONPATH: [overridesRoot, baseEnv.PYTHONPATH].filter(Boolean).join(delimiter),
      [PYTHON_OVERLAY_TARGET_ENV]: overridesRoot,
    };
  }

  async listVersions(packageName: ManagedPythonPackageName): Promise<PythonPackageVersionList> {
    assertManagedPackage(packageName);
    const primaryIndex = this.getPrimaryIndex();
    const primaryUrl = `${primaryIndex.url}/${packageName}/`;
    const output = [`GET ${primaryUrl}`];

    try {
      let versions = await fetchSimpleVersions(packageName, primaryIndex.url);
      output.push(`从 ${primaryIndex.label} Simple 索引解析到 ${versions.length} 个版本`);
      if (versions.length === 0) {
        throw new Error(`${primaryIndex.label} Simple 索引没有返回可解析的版本`);
      }

      if (hasMissingUploadTimes(versions)) {
        output.push(`清华 Simple 索引缺少部分发布时间，尝试从 ${PYPI_SIMPLE_INDEX}/${packageName}/ 补齐排序信息`);
        try {
          const supplemental = await fetchSimpleVersions(packageName, PYPI_SIMPLE_INDEX);
          versions = mergeVersionLists(versions, supplemental);
          output.push("发布时间补齐完成，仍以清华源作为安装源");
        } catch (metadataError) {
          output.push(`Release time backfill failed; sorting by available time and version: ${toDetail(metadataError)}`);
        }
      }

      output.push(
        hasMissingUploadTimes(versions)
          ? `Found ${versions.length} versions, sorted by available release time descending; versions without release time use version number as fallback`
          : `Found ${versions.length} versions, sorted by available release time descending`,
      );
      return {
        packageName,
        sourceUrl: primaryIndex.url,
        versions,
        output,
        fetchedAt: Date.now(),
      };
    } catch (error) {
      output.push(`读取版本列表失败: ${toDetail(error)}`);
      throw new Error(output.join("\n"));
    }
  }

  async installVersion(request: PythonPackageInstallRequest): Promise<PythonPackageInstallResult> {
    assertManagedPackage(request.packageName);
    if (!request.version.trim()) {
      throw new Error("Please select a version to install");
    }

    const targetDir = this.getOverridesRoot();
    await mkdir(targetDir, { recursive: true });
    await this.removeOverlayPackage(request.packageName, targetDir);

    const requirement = `${request.packageName}==${request.version.trim()}`;
    const baseArgs = [
      "-m",
      "pip",
      "install",
      "--pre",
      "--upgrade",
      "--target",
      targetDir,
      "--timeout",
      "120",
      "--retries",
      "5",
      "--no-deps",
      "--no-compile",
      "--no-warn-script-location",
    ];
    const result = await this.runPipInstallWithFallback(baseArgs, [requirement]);

    return {
      packageName: request.packageName,
      version: request.version.trim(),
      sourceUrl: result.sourceUrl,
      targetDir,
      output: result.output,
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

  async waitForStartupUpgradeIdle(timeoutMs = STARTUP_UPGRADE_IDLE_TIMEOUT_MS): Promise<void> {
    const currentUpgrade = this.startupUpgradePromise;
    if (!currentUpgrade) {
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        currentUpgrade.catch(() => undefined).then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("Timed out waiting for Python dependency install to stop"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async installProjectDeclaredDependencies(
    signal?: AbortSignal,
    onOutput?: PythonOutputHandler,
  ): Promise<StartupDependencyUpgradeResult> {
    const maibotRoot = this.paths.maibotRoot;
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
      throw new Error(`MaiBot dependency declaration not found: ${requirementsPath} or ${pyprojectPath}`);
    }
    if (sourceFile === pyprojectPath && pyprojectDependencies.length === 0) {
      throw new Error(`MaiBot pyproject.toml has no usable [project.dependencies]: ${pyprojectPath}`);
    }

    if (pyprojectDependencies.length > 0) {
      onOutput?.(`using pyproject dependencies (${pyprojectDependencies.length} entries)`);
    }

    const sourceDependencies = pyprojectDependencies.length > 0
      ? pyprojectDependencies
      : await readRequirementsFile(requirementsPath);
    let unsatisfied: UnsatisfiedDependency[];
    try {
      unsatisfied = pyprojectDependencies.length > 0
        ? await this.getUnsatisfiedDependencySpecifiers(pyprojectDependencies)
        : await this.getUnsatisfiedRequirements(requirementsPath);
    } catch (error) {
      onOutput?.(`dependency probe failed; installing declared dependencies: ${toDetail(error)}`);
      unsatisfied = sourceDependencies.map((requirement) => ({
        requirement,
        reason: "probe failed; install declared dependency",
      }));
    }
    if (unsatisfied.length === 0) {
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
    for (const item of unsatisfied) {
      onOutput?.(`dependency needs install: ${item.reason}`);
    }

    const targetDir = this.getOverridesRoot();
    await mkdir(targetDir, { recursive: true });
    const sourceArgs = unsatisfied.map((item) => item.requirement);
    await this.removeOverlayPackages(sourceArgs, targetDir);

    const baseArgs = [
      "-m",
      "pip",
      "install",
      "--upgrade",
      "--upgrade-strategy",
      "only-if-needed",
      "--target",
      targetDir,
      "--timeout",
      "120",
      "--retries",
      "5",
      "--disable-pip-version-check",
      "--no-compile",
      "--no-warn-script-location",
      "--progress-bar",
      "off",
    ];
    const result = await this.runPipInstallWithFallback(
      baseArgs,
      sourceArgs,
      signal,
      onOutput,
      this.buildPythonPathEnv(),
    );

    return {
      sourceFile,
      sourceUrl: result.sourceUrl,
      targetDir,
      output: result.output,
      installedAt: Date.now(),
    };
  }

  private async removeOverlayPackages(requirements: string[], targetDir = this.getOverridesRoot()): Promise<void> {
    const packageNames = requirements
      .map(packageNameFromRequirement)
      .filter((name): name is string => Boolean(name));

    await Promise.all(
      Array.from(new Set(packageNames.map(normalizeProjectName))).map((name) => this.removeOverlayPackage(name, targetDir)),
    );
  }

  private async removeOverlayPackage(packageName: string, targetDir = this.getOverridesRoot()): Promise<void> {
    const normalizedName = normalizeProjectName(packageName);
    const importName = packageImportName(packageName);
    let entries;
    try {
      entries = await readdir(targetDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => {
          const normalizedEntryName = normalizeProjectName(entry.name);
          const importEntryName = entry.name.toLowerCase().replace(/[-.]+/gu, "_");
          return (
            importEntryName === importName
            || (normalizedEntryName.startsWith(`${normalizedName}-`) && normalizedEntryName.endsWith("-dist-info"))
            || (normalizedEntryName.startsWith(`${normalizedName}-`) && normalizedEntryName.endsWith("-egg-info"))
          );
        })
        .map((entry) => rm(join(targetDir, entry.name), { recursive: true, force: true })),
    );
  }

  private async getUnsatisfiedRequirements(requirementsPath: string): Promise<UnsatisfiedDependency[]> {
    const script = String.raw`
import importlib.metadata as metadata
import json
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
        missing.append({"requirement": line, "reason": f"unparsed requirement: {line}"})
        continue
    if requirement.marker is not None and not requirement.marker.evaluate():
        continue
    try:
        version = metadata.version(requirement.name)
    except metadata.PackageNotFoundError:
        missing.append({"requirement": line, "reason": f"missing: {requirement.name}"})
        continue
    if requirement.specifier and not requirement.specifier.contains(version, prereleases=True):
        missing.append({"requirement": line, "reason": f"version mismatch: {requirement.name} {version} not in {requirement.specifier}"})

print(json.dumps(missing, ensure_ascii=False))
`;

    try {
      const output = await this.runPython(["-c", script, requirementsPath], undefined, undefined, this.buildPythonPathEnv());
      return this.parseUnsatisfiedDependencies(output);
    } catch (error) {
      throw new Error(`检查 MaiBot requirements.txt 失败: ${toDetail(error)}`);
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

  private async getUnsatisfiedDependencySpecifiers(dependencies: string[]): Promise<UnsatisfiedDependency[]> {
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
        missing.append({"requirement": line, "reason": f"unparsed requirement: {line}"})
        continue
    if requirement.marker is not None and not requirement.marker.evaluate():
        continue
    try:
        version = metadata.version(requirement.name)
    except metadata.PackageNotFoundError:
        missing.append({"requirement": line, "reason": f"missing: {requirement.name}"})
        continue
    if requirement.specifier and not requirement.specifier.contains(version, prereleases=True):
        missing.append({"requirement": line, "reason": f"version mismatch: {requirement.name} {version} not in {requirement.specifier}"})

print(json.dumps(missing, ensure_ascii=False))
`;

    try {
      const output = await this.runPython(["-c", script, JSON.stringify(dependencies)], undefined, undefined, this.buildPythonPathEnv());
      return this.parseUnsatisfiedDependencies(output);
    } catch (error) {
      throw new Error(`检查 MaiBot pyproject.toml 依赖失败: ${toDetail(error)}`);
    }
  }

  private parseUnsatisfiedDependencies(output: string[]): UnsatisfiedDependency[] {
    const raw = output.find((line) => line.trim().startsWith("[")) ?? "[]";
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item): UnsatisfiedDependency[] => {
      if (
        typeof item === "object"
        && item !== null
        && "requirement" in item
        && "reason" in item
        && typeof item.requirement === "string"
        && typeof item.reason === "string"
        && item.requirement.trim()
      ) {
        return [{ requirement: item.requirement, reason: item.reason }];
      }

      return [];
    });
  }

  private async runPipInstallWithFallback(
    baseArgs: string[],
    requirements: string[],
    signal?: AbortSignal,
    onOutput?: PythonOutputHandler,
    extraEnv?: Record<string, string>,
  ): Promise<PipInstallAttemptResult> {
    const failures: string[] = [];

    for (const index of this.getPipIndexes()) {
      if (signal?.aborted) {
        throw new Error("Python dependency install was cancelled");
      }

      const args = [
        ...baseArgs,
        "--index-url",
        index.url,
        ...(index.trustedHost ? ["--trusted-host", index.trustedHost] : []),
        ...requirements,
      ];
      onOutput?.(`pip install using ${index.label}: ${index.url}`);

      try {
        const output = await this.runPython(args, signal, onOutput, extraEnv);
        return {
          output,
          sourceUrl: index.url,
        };
      } catch (error) {
        const detail = toDetail(error);
        failures.push(`[${index.label}] ${detail}`);
        onOutput?.(`pip install failed with ${index.label}; ${this.nextIndexHint(index.url)}`);
      }
    }

    throw new Error(`All Python package indexes failed:\n${failures.join("\n\n")}`);
  }

  private nextIndexHint(failedUrl: string): string {
    const indexes = this.getPipIndexes();
    const currentIndex = indexes.findIndex((item) => item.url === failedUrl);
    const next = indexes[currentIndex + 1];
    return next ? `retrying with ${next.label}` : "no fallback index remains";
  }

  private sourceConfigPath(): string {
    return join(this.paths.userDataRoot, PYTHON_SOURCE_FILE);
  }

  private normalizeSourcePreset(value: unknown): PythonPackageSourcePreset {
    return value === "pypi" || value === "aliyun" || value === "tuna" ? value : "tuna";
  }

  private getPrimaryIndex(): typeof PIP_INDEXES[number] {
    const preset = this.getSourcePreset();
    return PIP_INDEXES.find((index) => index.preset === preset) ?? PIP_INDEXES[0];
  }

  private getPipIndexes(): typeof PIP_INDEXES {
    const primary = this.getPrimaryIndex();
    return [primary, ...PIP_INDEXES.filter((index) => index.preset !== primary.preset)] as typeof PIP_INDEXES;
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

