import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";

export function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function samePath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

export function sameOrInsidePath(parent: string, child: string): boolean {
  if (samePath(parent, child)) {
    return true;
  }
  const diff = relative(resolve(parent), resolve(child));
  return Boolean(diff) && diff !== ".." && !diff.startsWith(`..${sep}`);
}

export function runProcess(file: string, args: string[], cwd: string, timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (error) {
          reject(new Error(output || error.message));
          return;
        }

        resolve(output);
      },
    );
  });
}

export async function runWithoutAsar<T>(operation: () => Promise<T>): Promise<T> {
  const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
  const previousNoAsar = electronProcess.noAsar;
  electronProcess.noAsar = true;

  try {
    return await operation();
  } finally {
    electronProcess.noAsar = previousNoAsar;
  }
}
