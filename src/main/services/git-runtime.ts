import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { runProcess } from "./runtime-file-utils";

export async function resolveGitPath(runtimeRoot: string): Promise<string | undefined> {
  const windows = process.platform === "win32";
  const executable = windows ? "git.exe" : "git";
  const candidates = [
    join(runtimeRoot, "git", windows ? "cmd" : "bin", executable),
    ...(process.env.PATH ?? process.env.Path ?? "").split(delimiter)
      .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
      .filter(Boolean).map((entry) => join(entry, executable)),
    ...(windows
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"],
          process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]
          .filter((root): root is string => Boolean(root)).map((root) => join(root, "Git", "cmd", executable))
      : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]),
  ];
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate) || /[\\/]Microsoft[\\/]WindowsApps[\\/]git\.exe$/iu.test(candidate)) continue;
    try {
      if (/^git version /u.test(await runProcess(candidate, ["--version"], process.cwd(), 3000))) return candidate;
    } catch {
      // A broken bundled executable falls back to system Git.
    }
  }
  return undefined;
}
