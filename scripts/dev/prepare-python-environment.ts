import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  if (dirname(resolve(staging)) !== resolve(dirname(targetRoot))) {
    throw new Error(`Python 环境临时目录超出目标目录范围：${staging}`);
  }
  try {
    await cp(sourceRoot, staging, { recursive: true, force: true, verbatimSymlinks: true });
    for (let attempt = 0; ; attempt++) {
      if (existsSync(targetRoot)) return hasPython(targetRoot) ? "reused" : "initialize";
      try {
        await rename(staging, targetRoot);
        return "seeded";
      } catch (error) {
        if (existsSync(targetRoot)) return hasPython(targetRoot) ? "reused" : "initialize";
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 5) {
          throw error;
        }
        await delay(150 * (attempt + 1));
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 5 });
  }
}
