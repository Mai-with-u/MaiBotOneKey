import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

const root = process.cwd();
const target = join(root, "release-assets", "python-overrides");
const tunaIndex = "https://pypi.tuna.tsinghua.edu.cn/simple";

function pythonPath(): string {
  const candidates = [
    join(root, "runtime", "python", "python.exe"),
    join(root, "runtime", "python", "bin", "python.exe"),
    join(root, "runtime", "python", "python"),
    join(root, "runtime", "python", "bin", "python3"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error("Cannot find bundled Python in runtime/python.");
  }
  return path;
}

function run(command: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        ...env,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      process.stdout.write(chunk);
      output.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk);
      output.push(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output.join(""));
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function readMaiBotDependencies(python: string): Promise<string[]> {
  const pyprojectPath = join(root, "modules", "MaiBot", "pyproject.toml");
  const requirementsPath = join(root, "modules", "MaiBot", "requirements.txt");
  if (existsSync(pyprojectPath)) {
    const script = String.raw`
import json
import pathlib
import sys
import tomllib

data = tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
deps = data.get("project", {}).get("dependencies", [])
print(json.dumps([item for item in deps if isinstance(item, str) and item.strip()], ensure_ascii=False))
`;
    const output = await run(python, ["-c", script, pyprojectPath]);
    const line = output.split(/\r?\n/u).find((item) => item.trim().startsWith("["));
    const parsed = JSON.parse(line ?? "[]") as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }

  if (!existsSync(requirementsPath)) {
    throw new Error(`Cannot find MaiBot dependency file: ${pyprojectPath} or ${requirementsPath}`);
  }

  const content = await readFile(requirementsPath, "utf8");
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => !line.startsWith("-") && !line.startsWith("git+") && !/^https?:\/\//iu.test(line))
    .map((line) => line.replace(/\s+#.*$/u, "").trim())
    .filter(Boolean);
}

async function prepareEmptyTarget(): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, ".keep"), "", "utf8");
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "basic";
  await prepareEmptyTarget();
  if (mode === "basic") {
    console.log("[release] Prepared empty python-overrides for basic installer");
    return;
  }
  if (mode !== "full") {
    throw new Error(`Unknown python-overrides mode: ${mode}`);
  }

  const python = pythonPath();
  const dependencies = Array.from(new Set([
    ...(await readMaiBotDependencies(python)),
    "maibot-dashboard",
    "maim-message",
  ]));
  if (dependencies.length === 0) {
    throw new Error("No dependencies resolved for full python-overrides build.");
  }

  await mkdir(dirname(target), { recursive: true });
  console.log(`[release] Installing ${dependencies.length} dependency specifier(s) into ${target}`);
  await run(python, [
    "-m",
    "pip",
    "install",
    "--upgrade",
    "--upgrade-strategy",
    "only-if-needed",
    "--target",
    target,
    "--timeout",
    "120",
    "--retries",
    "5",
    "--disable-pip-version-check",
    "--no-compile",
    "--no-warn-script-location",
    "--progress-bar",
    "off",
    "--index-url",
    tunaIndex,
    "--trusted-host",
    "pypi.tuna.tsinghua.edu.cn",
    ...dependencies,
  ], {
    PYTHONPATH: target,
  });
  await rm(join(target, ".keep"), { force: true });
}

await main();
