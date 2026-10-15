import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts";

export const MAIBOT_DEPLOYMENT_FILE = ".onekey-deployment.json";
/** Provenance of bundled offline agreements; does not select the installed Core version. */
export const MAIBOT_BUNDLED_AGREEMENTS_VERSION = "1.3.8";
export interface MaiBotEnvironment {
  mode: "pypi";
  generation: string;
  packageVersion: string;
}
export interface MaiBotDeployment extends MaiBotEnvironment {
  schema: 1;
  installedAt: number;
  sourceUrl: string;
  previous?: MaiBotEnvironment | { mode: "source" };
  snapshot?: string;
}

export function deploymentFile(root: string): string { return join(root, MAIBOT_DEPLOYMENT_FILE); }
export function validGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/u.test(value);
}
export function readMaiBotDeployment(root: string): MaiBotDeployment | undefined {
  const path = deploymentFile(root);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as MaiBotDeployment;
    if (value.schema !== 1 || value.mode !== "pypi" || !validGeneration(value.generation)
      || typeof value.packageVersion !== "string" || !value.packageVersion.trim()
      || typeof value.sourceUrl !== "string" || !Number.isFinite(value.installedAt)
      || (value.snapshot !== undefined && !validGeneration(value.snapshot))
      || (value.previous !== undefined && value.previous.mode !== "source" &&
        (value.previous.mode !== "pypi" || !validGeneration(value.previous.generation) || typeof value.previous.packageVersion !== "string" || !value.previous.packageVersion.trim()))) {
      throw new Error("部署记录字段不完整");
    }
    return value;
  } catch (error) { throw new Error(`MaiBot 部署记录无效：${path}：${String(error)}`); }
}
export function isMaiBotPackageMode(paths: RuntimePaths): boolean {
  if (paths.maibotDevMode) return paths.maibotDevMode === "pypi";
  return Boolean(readMaiBotDeployment(paths.maibotRoot)) || !existsSync(join(paths.maibotRoot, "bot.py"));
}
export function maiBotEnvironmentRoot(root: string, generation: string): string {
  if (!validGeneration(generation)) throw new Error("无效的 Python 环境标识");
  return join(root, ".onekey", "environments", generation);
}
export function activePythonEnvironmentRoot(paths: RuntimePaths): string {
  if (paths.maibotDevMode === "source") return paths.pythonEnvRoot;
  const deployment = readMaiBotDeployment(paths.maibotRoot);
  return deployment ? maiBotEnvironmentRoot(paths.maibotRoot, deployment.generation) : paths.pythonEnvRoot;
}
