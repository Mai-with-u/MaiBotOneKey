import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const registryPath = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem";
const providerPath = registryPath.replace("HKLM", "Registry::HKEY_LOCAL_MACHINE");

export async function windowsLongPathsEnabled(): Promise<boolean> {
  const { stdout } = await execute("reg.exe", ["query", registryPath, "/v", "LongPathsEnabled"], { windowsHide: true });
  return /LongPathsEnabled\s+REG_DWORD\s+0x1\b/iu.test(stdout);
}

/** Called only after the user accepts the repair dialog. Windows owns the UAC prompt. */
export async function enableWindowsLongPaths(): Promise<void> {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const repair = Buffer.from(`$ErrorActionPreference = 'Stop'
try {
  Set-ItemProperty -LiteralPath '${providerPath}' -Name LongPathsEnabled -Type DWord -Value 1
  if ((Get-ItemPropertyValue -LiteralPath '${providerPath}' -Name LongPathsEnabled) -ne 1) { exit 1 }
  exit 0
} catch { exit 1 }`, "utf16le").toString("base64");
  const elevate = Buffer.from(`$ErrorActionPreference = 'Stop'
try {
  $repairProcess = Start-Process -FilePath '${powershell.replaceAll("'", "''")}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${repair}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $repairProcess.ExitCode
} catch { exit 2 }`, "utf16le").toString("base64");
  await execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", elevate], { windowsHide: true });
  if (!await windowsLongPathsEnabled()) throw new Error("Windows 长路径设置验证失败");
}
