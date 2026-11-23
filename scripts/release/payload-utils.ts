// Shared helpers for release payload preparation scripts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Keep the base Python minimal: pip/setuptools/wheel plus packaging for
// startup dependency resolution. Never preinstall MaiBot or app dependencies.
export const PACKAGING_VERSION = "26.2";

export function parsePayloadArgs(argv: string[]): { root: string; force: boolean } {
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

export async function download(url: string, target: string): Promise<void> {
  console.log(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

export async function prepareSnowLumaAdapter(root: string, force: boolean): Promise<void> {
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
  const plugins = join(root, "modules", "MaiBot", "plugins");
  mkdirSync(plugins, { recursive: true });
  const scratch = mkdtempSync(join(plugins, ".adapter-stage-"));
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
