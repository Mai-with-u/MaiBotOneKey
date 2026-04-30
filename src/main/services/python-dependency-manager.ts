import { execFile } from "node:child_process";
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
    throw new Error(`不支持更新此 Python 依赖: ${packageName}`);
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
        throw new Error("清华 Simple 索引没有返回可解析的版本");
      }

      if (hasMissingUploadTimes(versions)) {
        output.push(`清华 Simple 索引缺少部分发布时间，尝试从 ${PYPI_SIMPLE_INDEX}/${packageName}/ 补齐排序信息`);
        try {
          const supplemental = await fetchSimpleVersions(packageName, PYPI_SIMPLE_INDEX);
          versions = mergeVersionLists(versions, supplemental);
          output.push("发布时间补齐完成，仍以清华源作为安装源");
        } catch (metadataError) {
          output.push(`发布时间补齐失败，将按可用时间与版本号排序: ${toDetail(metadataError)}`);
        }
      }

      output.push(
        hasMissingUploadTimes(versions)
          ? `找到 ${versions.length} 个版本，已按可用发布时间降序排列；缺失发布时间的版本用版本号补位`
          : `找到 ${versions.length} 个版本，已按发布时间降序排列`,
      );
      return {
        packageName,
        sourceUrl: TUNA_SIMPLE_INDEX,
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
      throw new Error("请选择要安装的版本");
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

  private runPython(args: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(
        this.initManager.getPythonPath(),
        args,
        {
          cwd: this.paths.installRoot,
          timeout: PIP_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
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
}
