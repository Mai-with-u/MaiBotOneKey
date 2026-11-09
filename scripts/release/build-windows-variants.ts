import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const bundledWheels = [
  { requirement: "imageio-ffmpeg==0.8.1", file: "imageio_ffmpeg-0.8.1-py3-none-win_amd64.whl" },
  { requirement: "playwright==1.58.0", file: "playwright-1.58.0-py3-none-win_amd64.whl" },
  { requirement: "jieba==0.42.1", file: "jieba-0.42.1-py3-none-any.whl" },
];

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(command + " exited with code " + code)));
  });
}
async function buildInstaller(): Promise<void> {
  const { build, version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const buildVersion = flags.includes("--dev") ? `${version}-dev` : version;
  const channel = flags.includes("--dev") ? "dev" : "latest";
  const python = join(root, "runtime", "python", "python.exe");
  if (!existsSync(python)) throw new Error("Missing Python runtime: " + python);
  const wheels = join(root, ".codex-tmp", "python-wheels");
  const output = join(root, "release", ...(flags.includes("--dev") ? ["dev"] : []), "standard");
  const configPath = join(root, ".codex-tmp", "electron-builder-standard.json");
  const artifactName = "MaiBot-OK-" + buildVersion + "-win.exe";
  await mkdir(join(root, ".codex-tmp"), { recursive: true });
  await mkdir(join(root, "release"), { recursive: true });
  console.log("[release] Preparing bundled Python wheels");
  await run(python, [
    "-I", "-m", "pip", "--isolated", "wheel", "--no-deps", "--disable-pip-version-check",
    "--index-url", "https://pypi.org/simple", "--wheel-dir", wheels,
    ...bundledWheels.map(({ requirement }) => requirement),
  ]);
  await writeFile(configPath, JSON.stringify({
    ...build,
    extraMetadata: { ...build.extraMetadata, version: buildVersion },
    directories: { ...build.directories, output },
    extraResources: [...build.extraResources, {
      from: wheels,
      to: "runtime/python-wheels",
      filter: bundledWheels.map(({ file }) => file),
    }],
    win: { ...build.win, artifactName },
  }, null, 2));
  try {
    console.log("[release] Building Windows x64 installer");
    await run(process.execPath, [join(root, "node_modules/electron-builder/cli.js"),
      "--win", "nsis", "--x64", "--publish", "never", "--config", configPath]);
    const resources = join(output, "win-unpacked/resources");
    if (existsSync(join(resources, "modules/napcat"))) throw new Error("Windows installer includes NapCat.");
    if (existsSync(join(resources, "modules/SnowLuma"))) throw new Error("Windows installer includes the SnowLuma runtime.");
    for (const { file } of bundledWheels) {
      if (!existsSync(join(resources, "runtime", "python-wheels", file))) throw new Error("Missing bundled Python wheel: " + file);
    }
    const bundledDashboard = existsSync(join(resources, "runtime/python/Lib/site-packages/maibot_dashboard"));
    if (bundledDashboard) throw new Error("Standard Python unexpectedly includes Dashboard dependencies.");
    for (const suffix of ["", ".blockmap"]) {
      await copyFile(join(output, artifactName + suffix), join(root, "release", artifactName + suffix));
    }
    await copyFile(join(output, "latest.yml"), join(root, "release", `${channel}.yml`));
    await copyFile(join(output, "latest.yml"), join(root, "release", `${channel}-win.yml`));
  } finally {
    await rm(configPath, { force: true });
  }
}
const flags = process.argv.slice(2);
if (flags.some((flag) => !["--standard-only", "--dev"].includes(flag))) {
  throw new Error("Unsupported Windows packaging option: " + flags.join(" "));
}
await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
  join(root, "scripts/release/prepare-windows-installer.ps1")]);
await buildInstaller();

