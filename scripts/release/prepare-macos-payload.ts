// Prepares the macOS release payload without external hosting:
// - runtime/python: pinned python-build-standalone portable Python (pip + packaging only)
// - modules/MaiBot/plugins/snowluma-adapter: pinned upstream commit from
//   resources/snowluma-adapter-upstream.json
// Existing valid payloads are kept unless --force is passed. Use --root <dir>
// to target another checkout (useful for local verification).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PYTHON_BUILD = {
  release: "20261110",
  version: "3.12.16",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-aarch64-apple-darwin-install_only.tar.gz",
  sha256: "e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f",
};
// Keep the base Python minimal: pip/setuptools/wheel plus packaging for
// startup dependency resolution. Never preinstall MaiBot or app dependencies.
const PACKAGING_VERSION = "26.2";

function parseArgs(argv: string[]): { root: string; force: boolean } {
  let root = process.cwd();
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--force") force = true;
    else if (argv[i] === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root requires a directory");
      root = resolve(value);
      i += 1;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { root, force };
}

async function download(url: string, target: string): Promise<void> {
  console.log(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  writeFileSync(target, body);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function pythonWorks(python: string): boolean {
  if (!existsSync(python)) return false;
  try {
    const version = run(python, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"]);
    const [major, minor] = version.split(".").map(Number);
    return major === 3 && minor >= 12;
  } catch {
    return false;
  }
}

async function preparePython(root: string, force: boolean): Promise<void> {
  const pythonRoot = join(root, "runtime", "python");
  const python = join(pythonRoot, "bin", "python3.12");
  if (!force && pythonWorks(python)) {
    try {
      run(python, ["-c", "import packaging"]);
      console.log(`runtime/python already valid (${run(python, ["--version"])}), keeping it`);
      return;
    } catch {
      console.log("runtime/python exists but packaging is missing; repairing");
    }
  } else {
    const scratch = mkdtempSync(join(tmpdir(), "maibot-python-"));
    try {
      const archive = join(scratch, "python.tar.gz");
      await download(PYTHON_BUILD.url, archive);
      const actual = sha256(archive);
      if (actual !== PYTHON_BUILD.sha256) {
        throw new Error(`Python payload SHA-256 mismatch. Expected ${PYTHON_BUILD.sha256}, got ${actual}.`);
      }
      run("tar", ["-xzf", archive, "-C", scratch]);
      const extracted = join(scratch, "python");
      if (!existsSync(join(extracted, "bin", "python3.12"))) {
        throw new Error("Python archive layout changed: expected python/bin/python3.12");
      }
      mkdirSync(join(root, "runtime"), { recursive: true });
      rmSync(pythonRoot, { recursive: true, force: true });
      renameSync(extracted, pythonRoot);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  run(python, ["-m", "pip", "install", "--no-warn-script-location", `packaging==${PACKAGING_VERSION}`]);
  run(python, ["-c", "import packaging"]);
  console.log(`runtime/python ready: ${run(python, ["--version"])}`);
}

async function prepareSnowLumaAdapter(root: string, force: boolean): Promise<void> {
  const upstream = JSON.parse(readFileSync(join(root, "resources", "snowluma-adapter-upstream.json"), "utf8")) as {
    repository: string;
    commit: string;
    version: string;
  };
  const target = join(root, "modules", "MaiBot", "plugins", "snowluma-adapter");
  if (!force && existsSync(join(target, "_manifest.json"))) {
    console.log("snowluma-adapter already present, keeping it");
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), "maibot-adapter-"));
  try {
    const archive = join(scratch, "adapter.tar.gz");
    await download(`${upstream.repository}/archive/${upstream.commit}.tar.gz`, archive);
    run("tar", ["-xzf", archive, "-C", scratch]);
    const extracted = join(scratch, `MaiBot-SnowLuma-Adapter-${upstream.commit}`);
    if (!existsSync(join(extracted, "_manifest.json"))) {
      throw new Error("snowluma-adapter archive layout changed: expected _manifest.json at its root");
    }
    mkdirSync(join(root, "modules", "MaiBot", "plugins"), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(extracted, target);
    console.log(`snowluma-adapter ready: ${upstream.version} (${upstream.commit.slice(0, 12)})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const { root, force } = parseArgs(process.argv.slice(2));
if (process.platform !== "darwin") {
  console.log("macOS payload preparation is only needed on macOS; skipping");
  process.exit(0);
}
await preparePython(root, force);
await prepareSnowLumaAdapter(root, force);
console.log("macOS release payload ready");
