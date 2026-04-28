import { app } from "electron";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";

function resolveInstallRoot(): string {
  return app.isPackaged ? dirname(process.execPath) : process.cwd();
}

function resolvePayloadRoot(installRoot: string): string {
  return app.isPackaged ? process.resourcesPath : installRoot;
}

function createInstallScope(installRoot: string): string {
  return createHash("sha256").update(installRoot).digest("hex").slice(0, 12);
}

export function configureRuntimePaths(): RuntimePaths {
  const installRoot = resolveInstallRoot();
  const payloadRoot = resolvePayloadRoot(installRoot);
  const installScope = createInstallScope(installRoot);
  const userDataRoot = join(app.getPath("appData"), "MaiBotOneKeyDesktop", installScope);

  app.setPath("userData", userDataRoot);

  return {
    installRoot,
    userDataRoot,
    modulesRoot: join(payloadRoot, "modules"),
    runtimeRoot: join(payloadRoot, "runtime"),
    logsRoot: join(userDataRoot, "logs"),
  };
}
