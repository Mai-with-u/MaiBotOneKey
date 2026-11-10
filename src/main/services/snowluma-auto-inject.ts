import { normalizeQqAccount } from "../../shared/qq-account";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Keep the generated entry beside the bundle so relative imports and migration
// workers (which use process.argv[1]) both execute the actual SnowLuma runtime.
export async function prepareSnowLumaEntry(root: string, targetUin: string): Promise<string> {
  const original = join(root, "index.mjs");
  if (!normalizeQqAccount(targetUin)) throw new Error("Target QQ must contain valid digits");
  const patched = prepareRuntime(await readFile(original, "utf8"), targetUin);
  const entry = join(root, ".maibot-target-runtime.mjs");
  // A fixed generated filename avoids accumulating files after forced stops.
  await writeFile(entry, patched, "utf8");
  return entry;
}
export function prepareRuntime(source: string, targetUin: string): string {
  const account = normalizeQqAccount(targetUin);
  if (!account) throw new Error("Target QQ must contain valid digits");
  targetUin = account;
  const autoLoad = 'const autoLoadOnDiscovery = resolveAutoLoad(runtimeConfig.hookAutoLoad);';
  const anchor = 'if (autoLoadOnDiscovery) log.info("hook auto-load enabled: every discovered QQ process will be injected");';
  const shutdown = 'shutdownStarted = true;';
  for (const marker of [autoLoad, anchor, shutdown]) {
    if (source.split(marker).length !== 2) {
      throw new Error(`Unsupported SnowLuma bundle: expected exactly one ${marker}`);
    }
  }
  const monitor = `
  const targetUin = ${JSON.stringify(targetUin)};
  let targetMonitorStopped = false;
  let targetMonitorTimer;
  const targetRetryAfter = new Map();
  async function monitorTargetAccount() {
    try {
      const processes = await hookManager.listProcesses();
      const livePids = new Set(processes.map(process => process.pid));
      for (const pid of targetRetryAfter.keys()) {
        if (!livePids.has(pid)) targetRetryAfter.delete(pid);
      }
      for (const process of processes) {
        if (targetMonitorStopped) break;
        if (process.injected || Date.now() < (targetRetryAfter.get(process.pid) ?? 0)) continue;
        try {
          const identity = await hookManager.probeProcessLoginInfo(process.pid);
          if (targetMonitorStopped) break;
          if (!identity?.identityKnown || String(identity.uin) !== targetUin) continue;
          log.info("target auto-inject: QQ=%s PID=%d", targetUin, process.pid);
          const result = await hookManager.loadProcess(process.pid);
          if (!result.injected || result.status === "error") {
            throw new Error(result.error || "injection did not complete");
          }
          targetRetryAfter.delete(process.pid);
          log.info("target auto-inject completed: QQ=%s PID=%d", targetUin, process.pid);
        } catch (error) {
          targetRetryAfter.set(process.pid, Date.now() + 30000);
          log.error("target auto-inject failed: PID=%d %s", process.pid, error.stack ?? String(error));
        }
      }
    } catch (error) {
      log.error("target account monitor failed: %s", error.stack ?? String(error));
    } finally {
      // Schedule after completion so slow probes never create overlapping scans.
      if (!targetMonitorStopped) targetMonitorTimer = setTimeout(monitorTargetAccount, 3000);
    }
  }
  log.info("target account monitor enabled: QQ=%s; global auto-injection disabled", targetUin);
  targetMonitorTimer = setTimeout(monitorTargetAccount, 3000);
`;
  return source.replace(autoLoad, 'const autoLoadOnDiscovery = false;')
    .replace(anchor, monitor)
    .replace(shutdown, `${shutdown}\n\ttargetMonitorStopped = true;\n\tclearTimeout(targetMonitorTimer);`);
}
