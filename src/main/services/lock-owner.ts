import { execFileSync } from "node:child_process";
import { join } from "node:path";

// A PID alone is not an identity: Windows can reuse it after a crash or reboot.
export function isLockOwnerAlive(owner: { pid?: number; startedAt?: number } | undefined): boolean {
  const pid = owner?.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform === "win32" && Number.isFinite(owner?.startedAt)) {
    try {
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`],
      { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const processStartedAt = Number(result.trim());
      if (Number.isFinite(processStartedAt) && processStartedAt > owner!.startedAt!) return false;
    } catch {
      // Access denied or unavailable process metadata must not steal a live lock.
    }
  }
  return true;
}
