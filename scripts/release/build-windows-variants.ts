import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(command + " exited with code " + code)));
  });
}
async function buildVariant(variant: "standard" | "snowluma"): Promise<void> {
  const { build, version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const pythonRoot = join(root, "runtime", "python");
  if (!existsSync(join(pythonRoot, "python.exe"))) throw new Error("Missing Python runtime: " + pythonRoot);
  const output = join(root, "release", variant);
  const configPath = join(root, ".codex-tmp", "electron-builder-" + variant + ".json");
  const artifactName = "MaiBot-OK-" + version + "-win" + (variant === "snowluma" ? "-snowluma" : "") + ".exe";
  await mkdir(join(root, ".codex-tmp"), { recursive: true });
  await mkdir(join(root, "release"), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    ...build,
    directories: { ...build.directories, output },
    win: { ...build.win, artifactName, ...(variant === "snowluma" ? { extraResources: [] } : {}) },
  }, null, 2));
  try {
    console.log("[release] Building Windows x64 " + variant + " installer");
    await run(process.execPath, [join(root, "node_modules/electron-builder/cli.js"),
      "--win", "nsis", "--x64", "--publish", "never", "--config", configPath]);
    const resources = join(output, "win-unpacked/resources");
    if (variant === "snowluma" && existsSync(join(resources, "modules/napcat"))) throw new Error("SnowLuma installer includes NapCat.");
    const bundledDashboard = existsSync(join(resources, "runtime/python/Lib/site-packages/maibot_dashboard"));
    if (bundledDashboard) throw new Error("Standard Python unexpectedly includes Dashboard dependencies.");
    for (const suffix of ["", ".blockmap"]) {
      await copyFile(join(output, artifactName + suffix), join(root, "release", artifactName + suffix));
    }
    if (variant === "standard") {
      await copyFile(join(output, "latest.yml"), join(root, "release", "latest.yml"));
      await copyFile(join(output, "latest.yml"), join(root, "release", "latest-win.yml"));
    } else {
      await copyFile(join(output, "latest.yml"), join(root, "release", "latest-win-snowluma.yml"));
    }
  } finally {
    await rm(configPath, { force: true });
  }
}
const flags = process.argv.slice(2);
if (flags.some((flag) => !["--snowluma-only", "--standard-only"].includes(flag))) {
  throw new Error("Unsupported Windows packaging option: " + flags.join(" "));
}
await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
  join(root, "scripts/release/prepare-windows-installer.ps1")]);
if (flags.includes("--snowluma-only")) {
  await buildVariant("snowluma");
} else {
  await buildVariant("standard");
}

