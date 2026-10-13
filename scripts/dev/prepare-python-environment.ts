import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

function hasPython(root: string): boolean {
  return ["python.exe", "Scripts/python.exe", "bin/python", "bin/python3", "bin/python.exe"]
    .some((executable) => existsSync(join(root, executable)));
}

/** Seed only once. Configuration resets and subsequent launches never replace installed packages. */
export async function prepareDevPythonEnvironment(
  sourceRoot: string,
  targetRoot: string,
): Promise<"reused" | "seeded" | "initialize"> {
  if (hasPython(targetRoot)) return "reused";
  // Leave partial environments to the normal environment manager, which can repair them.
  if (existsSync(targetRoot) || !hasPython(sourceRoot)) return "initialize";
  await mkdir(dirname(targetRoot), { recursive: true });
  const staging = await mkdtemp(`${targetRoot}.seed-`);
  try {
    await cp(sourceRoot, staging, { recursive: true, force: true, verbatimSymlinks: true });
    await rename(staging, targetRoot);
    return "seeded";
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
