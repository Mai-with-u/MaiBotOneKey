import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();

function hasEmbeddedGit(): boolean {
  return [
    join(root, "runtime", "git", "bin", "git.exe"),
    join(root, "runtime", "git", "cmd", "git.exe"),
    join(root, "runtime", "git", "git.exe"),
    join(root, "runtime", "git", "bin", "git"),
  ].some((path) => existsSync(path));
}

function hasEmbeddedPython(): boolean {
  return [
    join(root, "runtime", "python", "python.exe"),
    join(root, "runtime", "python", "bin", "python.exe"),
    join(root, "runtime", "python", "python"),
    join(root, "runtime", "python", "bin", "python3"),
  ].some((path) => existsSync(path));
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  if (!hasEmbeddedGit()) {
    throw new Error("Cannot build the standard installer because runtime/git is missing.");
  }
  if (!hasEmbeddedPython()) {
    throw new Error("Cannot build the standard installer because runtime/python is missing.");
  }

  await buildWindowsInstaller();
}

async function buildWindowsInstaller(): Promise<void> {
  console.log("[release] Building Windows x64 installer without bundled Python dependencies");
  await run(process.execPath, [
    join(root, "node_modules", "electron-builder", "cli.js"),
    "--win",
    "nsis",
    "--x64",
    "--config.win.artifactName=MaiBot-OK-${version}-win.${ext}",
  ]);

  await copyLatestMetadata();
}

async function copyLatestMetadata(): Promise<void> {
  const releaseRoot = join(root, "release");
  await mkdir(releaseRoot, { recursive: true });
  const source = join(releaseRoot, "latest.yml");
  if (existsSync(source)) {
    await copyFile(source, join(releaseRoot, "latest-win.yml"));
  }
}

await main();
