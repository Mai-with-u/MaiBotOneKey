import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";

type PathKind = "file" | "dir";

type Candidate = {
  path: string;
  kind: PathKind;
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

const requirements: Requirement[] = [
  {
    label: "runtime directory",
    required: true,
    candidates: [dir("runtime")],
  },
  {
    label: "embedded Python",
    required: true,
    candidates: [file("runtime/python31211/bin/python.exe"), file("runtime/python31211/python.exe")],
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
    label: "NapCat module",
    required: true,
    candidates: [dir("modules/napcat")],
  },
  {
    label: "NapCat Windows launcher",
    required: true,
    candidates: [file("modules/napcat/NapCatWinBootMain.exe")],
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
    required: false,
    candidates: [dir("modules/napcat/versions"), dir("modules/napcatframework/versions")],
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
    return candidate.kind === "dir" ? info.isDirectory() : info.isFile();
  } catch {
    return false;
  }
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
