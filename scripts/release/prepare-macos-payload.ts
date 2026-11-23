// Prepares the macOS release payload without external hosting:
// - runtime/python: pinned python-build-standalone portable Python (pip + packaging only)
// - modules/MaiBot/plugins/snowluma-adapter: pinned upstream commit from
//   resources/snowluma-adapter-upstream.json
// Existing valid payloads are kept unless --force is passed. Use --root <dir>
// to target another checkout (useful for local verification).
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGING_VERSION, download, parsePayloadArgs, prepareSnowLumaAdapter, run, sha256 } from "./payload-utils.ts";

const PYTHON_BUILD = {
  release: "20261110",
  version: "3.12.16",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-aarch64-apple-darwin-install_only.tar.gz",
  sha256: "e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f",
};

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

const { root, force } = parsePayloadArgs(process.argv.slice(2));
if (process.platform !== "darwin") {
  console.log("macOS payload preparation is only needed on macOS; skipping");
  process.exit(0);
}
await preparePython(root, force);
await prepareSnowLumaAdapter(root, force);
console.log("macOS release payload ready");
