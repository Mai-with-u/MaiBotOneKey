import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";

interface LockPayload {
  pid: number;
  installRoot: string;
  startedAt: number;
}

export interface InstallInstanceLock {
  acquired: boolean;
  lockPath: string;
  existing?: LockPayload;
  release: () => void;
}

function readLockPayload(lockPath: string): LockPayload | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockPayload;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function acquireInstallInstanceLock(paths: RuntimePaths): InstallInstanceLock {
  mkdirSync(paths.userDataRoot, { recursive: true });
  const lockPath = join(paths.userDataRoot, "instance.lock");
  const payload: LockPayload = {
    pid: process.pid,
    installRoot: paths.installRoot,
    startedAt: Date.now(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
      return {
        acquired: true,
        lockPath,
        release: () => {
          const current = readLockPayload(lockPath);
          if (current?.pid === process.pid) {
            try {
              unlinkSync(lockPath);
            } catch {
              // The lock is best-effort; if it is already gone, shutdown can continue.
            }
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      const existing = readLockPayload(lockPath);
      if (isProcessAlive(existing?.pid)) {
        return {
          acquired: false,
          lockPath,
          existing,
          release: () => undefined,
        };
      }

      if (existsSync(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          return {
            acquired: false,
            lockPath,
            existing,
            release: () => undefined,
          };
        }
      }
    }
  }

  return {
    acquired: false,
    lockPath,
    existing: readLockPayload(lockPath),
    release: () => undefined,
  };
}
