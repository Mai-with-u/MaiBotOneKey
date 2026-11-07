import { createHash } from "node:crypto";
import { createWriteStream, lstatSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { runProcess } from "./runtime-file-utils";

const REPOSITORY = "NapNeko/NapCatQQ";
const ASSET_NAME = "NapCat.Shell.Windows.Node.zip";
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const NODE_RUNTIME_FILES = ["node.exe", "index.js", "config.json", "napcat/package.json"];
const EXTRACT = String.raw`
import pathlib, stat, sys, zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if sum(entry.file_size for entry in entries) > 2 * 1024 ** 3:
        raise ValueError("NapCat archive is too large")
    for entry in entries:
        parts = entry.filename.rstrip("/").split("/")
        if any(not part or part in (".", "..") or part.endswith((".", " "))
               or any(char in part for char in '\\:<>|?*"')
               or pathlib.PureWindowsPath(part).is_reserved() for part in parts):
            raise ValueError("Invalid path in NapCat archive")
        if stat.S_ISLNK(entry.external_attr >> 16):
            raise ValueError("Unexpected link in NapCat archive")
    archive.extractall(sys.argv[2])
`;

function hasFiles(root: string, files: string[]): boolean {
  return files.every((file) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile());
}

export function hasWindowsNapCat(root: string): boolean {
  if (hasFiles(root, NODE_RUNTIME_FILES)) return true;
  return hasFiles(root, ["NapCatWinBootMain.exe"]) && ["napcat", "versions"].some((directory) =>
    statSync(join(root, directory), { throwIfNoEntry: false })?.isDirectory(),
  );
}

async function downloadArchive(destination: string, request: typeof fetch): Promise<void> {
  const release = await request(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "MaiBotOneKey" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!release.ok) throw new Error(`GitHub 版本查询返回 HTTP ${release.status}`);
  const { tag_name: tag, assets } = await release.json() as {
    tag_name?: string;
    assets?: Array<{ name: string; size: number; digest?: string }>;
  };
  const asset = assets?.find(({ name }) => name === ASSET_NAME);
  if (typeof tag !== "string" || !/^\w[\w.-]*$/u.test(tag) || !asset ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD_BYTES ||
      !/^sha256:[a-f0-9]{64}$/u.test(asset.digest ?? "")) {
    throw new Error("GitHub Release 缺少可校验的 Windows NapCat 安装文件");
  }

  const signal = AbortSignal.timeout(10 * 60_000);
  const response = await request(`https://github.com/${REPOSITORY}/releases/download/${tag}/${ASSET_NAME}`, { signal });
  if (!response.ok || !response.body) throw new Error(`GitHub 文件下载返回 HTTP ${response.status}`);
  const hash = createHash("sha256");
  let received = 0;
  const verifySize = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > asset.size) return done(new Error("NapCat 文件大小超出 GitHub Release 标注值"));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const stream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  await pipeline(stream, verifySize, createWriteStream(destination, { flags: "wx" }), { signal });
  if (received !== asset.size || `sha256:${hash.digest("hex")}` !== asset.digest) {
    throw new Error("NapCat 下载文件校验失败");
  }
}

export async function installWindowsNapCat(root: string, python: string, request = fetch): Promise<void> {
  if (hasWindowsNapCat(root)) return;
  await mkdir(dirname(root), { recursive: true });
  const parent = await realpath(dirname(root));
  const target = join(parent, basename(root));
  const temp = await mkdtemp(join(parent, ".napcat-install-"));
  const staged = join(temp, "payload");
  const previous = join(temp, "previous");
  let preservePrevious = false;
  try {
    const archive = join(temp, "napcat.zip");
    try {
      await downloadArchive(archive, request);
    } catch (error) {
      throw new Error(`从 GitHub 下载 NapCat 失败，请检查网络后重试。 ${(error as Error).message}`);
    }
    await runProcess(python, ["-I", "-c", EXTRACT, archive, staged], temp, 120_000);
    if (!hasFiles(staged, NODE_RUNTIME_FILES)) throw new Error("NapCat 压缩包缺少 Windows 启动文件");
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) throw new Error("NapCat 安装位置必须是普通目录");
    if (existing) {
      // Keep files left by earlier configuration attempts. The verified archive supplies the runtime.
      await cp(target, staged, { recursive: true, force: false, verbatimSymlinks: true });
      const config = join(target, "napcat/config");
      if (lstatSync(config, { throwIfNoEntry: false })?.isDirectory()) {
        await cp(config, join(staged, "napcat/config"), { recursive: true, force: true, verbatimSymlinks: true });
      }
      await rename(target, previous);
      preservePrevious = true;
    }
    try {
      await rename(staged, target);
      preservePrevious = false;
    } catch (error) {
      if (preservePrevious) {
        await rename(previous, target).catch(() => {
          throw new Error(`NapCat 安装失败，原目录保存在 ${previous}`, { cause: error });
        });
        preservePrevious = false;
      }
      throw error;
    }
  } finally {
    if (!preservePrevious) await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
