import { existsSync } from "node:fs";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const dashboardRoot = resolve(import.meta.dir, "../../modules/MaiBot/dashboard");
  if (!existsSync(resolve(dashboardRoot, "package.json"))) {
    throw new Error(`本地 Dashboard 源码不存在：${dashboardRoot}`);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log("[dev:build] 构建本地 MaiBot Dashboard…");
  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: dashboardRoot,
    env,
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await build.exited);
}

if (import.meta.main) await main();
