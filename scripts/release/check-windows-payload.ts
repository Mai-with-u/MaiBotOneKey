import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";

type PathKind = "file" | "dir";

type Candidate = {
  path: string;
  kind: PathKind;
  contains?: string[];
};

type Requirement = {
  label: string;
  required: boolean;
  candidates: Candidate[];
};

type JsonRecord = Record<string, unknown>;

const root = process.cwd();
const pythonBootstrapPackages = new Set([
  "pip",
  "pip.dist-info",
  "setuptools",
  "setuptools.dist-info",
  "wheel",
  "wheel.dist-info",
  "pkg_resources",
  "_distutils_hack",
  "distutils-precedence.pth",
]);
const pythonBootstrapScripts = new Set([
  "pip.exe",
  "pip3.exe",
  "pip3.12.exe",
  "__pycache__",
]);

function file(path: string): Candidate {
  return { path: join(root, path), kind: "file" };
}

function dir(path: string): Candidate {
  return { path: join(root, path), kind: "dir" };
}

function dirContaining(path: string, contains: string[]): Candidate {
  return { path: join(root, path), kind: "dir", contains };
}

const requirements: Requirement[] = [
  {
    label: "runtime directory",
    required: true,
    candidates: [dir("runtime")],
  },
  {
    label: "portable Python directory",
    required: true,
    candidates: [dir("runtime/python")],
  },
  {
    label: "portable Python executable",
    required: true,
    candidates: [file("runtime/python/python.exe"), file("runtime/python/bin/python.exe")],
  },
  {
    label: "portable Python standard library",
    required: true,
    candidates: [dir("runtime/python/Lib"), dir("runtime/python/lib")],
  },
  {
    label: "portable Python extension modules",
    required: true,
    candidates: [dir("runtime/python/DLLs")],
  },
  {
    label: "portable Python pip command",
    required: true,
    candidates: [file("runtime/python/Scripts/pip.exe"), file("runtime/python/bin/pip")],
  },
  {
    label: "portable Python pip package",
    required: true,
    candidates: [dir("runtime/python/Lib/site-packages/pip"), dir("runtime/python/lib/site-packages/pip")],
  },
  {
    label: "embedded Git directory",
    required: true,
    candidates: [dir("runtime/git")],
  },
  {
    label: "embedded Git executable",
    required: true,
    candidates: [file("runtime/git/bin/git.exe"), file("runtime/git/cmd/git.exe"), file("runtime/git/git.exe")],
  },
  {
    label: "OpenCode CLI executable",
    required: true,
    candidates: [file("runtime/opencode/opencode.exe")],
  },
  {
    label: "OpenCode plugin instruction resource",
    required: true,
    candidates: [file("resources/opencode/plugin_code.md")],
  },
  {
    label: "modules directory",
    required: true,
    candidates: [dir("modules")],
  },
  {
    label: "MaiBot module",
    required: true,
    candidates: [dir("modules/MaiBot")],
  },
  {
    label: "MaiBot entry",
    required: true,
    candidates: [file("modules/MaiBot/bot.py")],
  },
  {
    label: "MaiBot napcat-adapter plugin",
    required: true,
    candidates: [dir("modules/MaiBot/plugins/napcat-adapter")],
  },
  {
    label: "MaiBot snowluma-adapter plugin",
    required: true,
    candidates: [dir("modules/MaiBot/plugins/snowluma-adapter")],
  },
  {
    label: "MaiBot snowluma-adapter entry",
    required: true,
    candidates: [file("modules/MaiBot/plugins/snowluma-adapter/plugin.py")],
  },
  {
    label: "NapCat module",
    required: true,
    candidates: [dir("modules/napcat")],
  },
  {
    label: "NapCat Windows runtime",
    required: true,
    candidates: [file("modules/napcat/node.exe"), file("modules/napcat/NapCatWinBootMain.exe")],
  },
  {
    label: "SnowLuma module",
    required: true,
    candidates: [dir("modules/SnowLuma")],
  },
  {
    label: "SnowLuma entry",
    required: true,
    candidates: [file("modules/SnowLuma/index.mjs")],
  },
  {
    label: "SnowLuma Windows runtime",
    required: true,
    candidates: [file("modules/SnowLuma/node.exe")],
  },
  {
    label: "SnowLuma native binding",
    required: true,
    candidates: [
      file("modules/SnowLuma/native/snowluma-win32-x64.node"),
      file("modules/SnowLuma/native/snowluma-win32-x64.dll"),
    ],
  },
  {
    label: "node-pty Windows pty binding",
    required: true,
    candidates: [file("node_modules/node-pty/prebuilds/win32-x64/pty.node")],
  },
  {
    label: "node-pty Windows conpty binding",
    required: true,
    candidates: [file("node_modules/node-pty/prebuilds/win32-x64/conpty.node")],
  },
  {
    label: "node-pty Windows console-list binding",
    required: true,
    candidates: [file("node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node")],
  },
  {
    label: "NapCat version resources",
    required: true,
    candidates: [
      file("modules/napcat/napcat/package.json"),
      dirContaining("modules/napcat/versions", [join("resources", "app", "package.json")]),
    ],
  },
  {
    label: "Windows app icon",
    required: false,
    candidates: [file("resources/icon.ico")],
  },
];

const requiredModuleResourceExclusions = [
  "!MaiBot/config/**",
  "!MaiBot/data/**",
  "!MaiBot/logs/**",
  "!MaiBot/plugins/**",
];

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function checkModuleResourceFilter(): Promise<string[]> {
  const packageJson = asRecord(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  const build = asRecord(packageJson?.build);
  const extraResources = Array.isArray(build?.extraResources) ? build.extraResources : [];
  const modulesResource = extraResources
    .map(asRecord)
    .find((resource) => resource?.from === "modules" && resource.to === "modules");
  const filter = new Set(stringArray(modulesResource?.filter));
  return requiredModuleResourceExclusions.filter((entry) => !filter.has(entry));
}

async function matches(candidate: Candidate): Promise<boolean> {
  try {
    const info = await stat(candidate.path);
    if (candidate.kind === "file") {
      return info.isFile();
    }
    if (!info.isDirectory()) {
      return false;
    }
    if (!candidate.contains?.length) {
      return true;
    }
    return directoryHasAny(candidate.path, candidate.contains);
  } catch {
    return false;
  }
}

async function directoryHasAny(directory: string, relativePaths: string[]): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const relativePath of relativePaths) {
      try {
        const info = await stat(join(directory, entry.name, relativePath));
        if (info.isFile()) {
          return true;
        }
      } catch {
        // Try the next known NapCat layout.
      }
    }
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizePythonPackageEntry(name: string): string {
  return name
    .replace(/-\d.+(?:\.dist-info|\.egg-info)$/iu, ".dist-info")
    .replace(/[-_]+/gu, "-")
    .toLowerCase();
}

async function findPythonSitePackages(): Promise<string | undefined> {
  const candidates = [
    join(root, "runtime", "python", "Lib", "site-packages"),
    join(root, "runtime", "python", "lib", "site-packages"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function checkLeanPythonRuntime(): Promise<string[]> {
  const sitePackages = await findPythonSitePackages();
  if (!sitePackages) {
    return [];
  }

  const entries = await readdir(sitePackages, { withFileTypes: true });
  return entries
    .map((entry) => entry.name)
    .filter((name) => name !== "__pycache__")
    .filter((name) => !pythonBootstrapPackages.has(normalizePythonPackageEntry(name)))
    .sort((left, right) => left.localeCompare(right, "en-US", { numeric: true, sensitivity: "base" }));
}

async function checkLeanPythonScripts(): Promise<string[]> {
  const scriptsPath = join(root, "runtime", "python", "Scripts");
  if (!(await pathExists(scriptsPath))) {
    return [];
  }

  const entries = await readdir(scriptsPath, { withFileTypes: true });
  return entries
    .map((entry) => entry.name)
    .filter((name) => !pythonBootstrapScripts.has(name))
    .sort((left, right) => left.localeCompare(right, "en-US", { numeric: true, sensitivity: "base" }));
}

function describeCandidates(candidates: Candidate[]): string {
  return candidates.map((candidate) => relative(root, candidate.path)).join(" or ");
}

async function main(): Promise<void> {
  const failures: Requirement[] = [];

  console.log("Checking Windows release payload...");

  for (const requirement of requirements) {
    const matched = [];
    for (const candidate of requirement.candidates) {
      if (await matches(candidate)) {
        matched.push(candidate);
      }
    }

    if (matched.length > 0) {
      console.log(`[ok] ${requirement.label}: ${relative(root, matched[0].path)}`);
      continue;
    }

    const prefix = requirement.required ? "[missing]" : "[warn]";
    console.log(`${prefix} ${requirement.label}: ${describeCandidates(requirement.candidates)}`);

    if (requirement.required) {
      failures.push(requirement);
    }
  }

  if (failures.length > 0) {
    console.log("");
    console.log(`Release payload is incomplete (${failures.length} required item(s) missing).`);
    console.log("Put runtime/ and modules/ in the repository root before running bun run release:win.");
    process.exitCode = 1;
    return;
  }

  const missingModuleResourceExclusions = await checkModuleResourceFilter();
  if (missingModuleResourceExclusions.length > 0) {
    console.log("");
    console.log("[missing] modules extraResources filter should exclude runtime MaiBot state.");
    console.log("Do not package local MaiBot config/data/logs or user plugins into the installer.");
    for (const entry of missingModuleResourceExclusions) {
      console.log(`  - ${entry}`);
    }
    process.exitCode = 1;
    return;
  }

  const bundledPythonPackages = await checkLeanPythonRuntime();
  const bundledPythonScripts = await checkLeanPythonScripts();
  if (bundledPythonPackages.length > 0 || bundledPythonScripts.length > 0) {
    console.log("");
    console.log("[missing] portable Python should not contain application dependencies.");
    console.log("Keep runtime/python lean: only Python itself plus pip/setuptools/wheel are allowed.");
    console.log("Install MaiBot/dashboard dependencies into python-overrides at first run instead.");
    if (bundledPythonPackages.length > 0) {
      console.log(`Unexpected site-packages entries (${bundledPythonPackages.length}):`);
      for (const name of bundledPythonPackages.slice(0, 30)) {
        console.log(`  - ${name}`);
      }
      if (bundledPythonPackages.length > 30) {
        console.log(`  ... and ${bundledPythonPackages.length - 30} more`);
      }
    }
    if (bundledPythonScripts.length > 0) {
      console.log(`Unexpected Scripts entries (${bundledPythonScripts.length}):`);
      for (const name of bundledPythonScripts.slice(0, 30)) {
        console.log(`  - ${name}`);
      }
      if (bundledPythonScripts.length > 30) {
        console.log(`  ... and ${bundledPythonScripts.length - 30} more`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log("Windows standard release payload looks complete.");
}

await main();
