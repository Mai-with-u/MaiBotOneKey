import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readSnowLumaVersion(root: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch { return undefined; }
}
