import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const preinstalledRequirements = ["jieba==0.42.1", "imageio-ffmpeg==0.8.1", "playwright==1.58.0", "Babel==2.18.0", "faiss-cpu==1.16.0"];

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
  const output = join(root, "release", ...(flags.includes("--dev") ? ["dev"] : []), "standard");
  const configPath = join(root, ".codex-tmp", "electron-builder-standard.json");
  const artifactName = "MaiBot-OK-" + buildVersion + "-win.exe";
  await mkdir(join(root, ".codex-tmp"), { recursive: true });
  await mkdir(join(root, "release"), { recursive: true });
  console.log("[release] Preparing preinstalled Python packages");
  // New environments copy this runtime; existing environments are never replaced.
  await run(python, [
    "-I", "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
    "--index-url", "https://pypi.org/simple", ...preinstalledRequirements,
  ]);
  await writeFile(configPath, JSON.stringify({
    ...build,
    extraMetadata: { ...build.extraMetadata, version: buildVersion },
    directories: { ...build.directories, output },
    win: { ...build.win, artifactName },
  }, null, 2));
  try {
    console.log("[release] Building Windows x64 installer");
    await run(process.execPath, [join(root, "node_modules/electron-builder/cli.js"),
      "--win", "nsis", "--x64", "--publish", "never", "--config", configPath]);
    const resources = join(output, "win-unpacked/resources");
    await run(join(resources, "runtime/python/python.exe"), [
      "-I", "-c", "import jieba, imageio_ffmpeg, faiss, numpy as np; from babel import Locale; from playwright.sync_api import sync_playwright; assert Locale.parse('zh_CN').language == 'zh'; vectors = np.array([[0, 0], [1, 1]], dtype='float32'); index = faiss.IndexFlatL2(2); index.add(vectors); distances, ids = index.search(vectors, 1); assert ids[:, 0].tolist() == [0, 1]; assert list(jieba.cut('测试')); assert imageio_ffmpeg.get_ffmpeg_version(); p = sync_playwright().start(); p.stop()",
    ]);
    if (existsSync(join(resources, "modules/napcat"))) throw new Error("Windows installer includes NapCat.");
    if (existsSync(join(resources, "modules/SnowLuma"))) throw new Error("Windows installer includes the SnowLuma runtime.");
    if (existsSync(join(resources, "runtime/python-wheels"))) throw new Error("Windows installer includes obsolete Python wheels.");
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

