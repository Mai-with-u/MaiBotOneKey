import { readdir, stat } from "node:fs/promises";
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

const root = process.cwd();

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
      dirContaining("modules/napcatframework/versions", [join("resources", "app", "package.json")]),
    ],
  },
  {
    label: "Windows app icon",
    required: false,
    candidates: [file("resources/icon.ico")],
  },
];

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

  console.log("Windows release payload looks complete.");
}

await main();
