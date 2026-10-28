import { existsSync, unlinkSync } from "node:fs";
import { DEV_RESUME_INSTANCE_ENV } from "../../src/shared/development-restart";

/** Electron-vite exits with Electron, so restart the entire session, including Vite. */
export async function runDevelopmentSession(
  launch: (env: NodeJS.ProcessEnv) => Promise<number>,
  env: NodeJS.ProcessEnv,
  restartFile: string,
  stopped: () => boolean,
): Promise<number> {
  let nextEnv = { ...env };
  for (;;) {
    const code = await launch(nextEnv);
    if (stopped() || !existsSync(restartFile)) return code;
    unlinkSync(restartFile);
    if (code !== 0) return code;
    console.log("[dev] 切换实例：重新启动页面服务和 Electron…");
    nextEnv = { ...nextEnv, [DEV_RESUME_INSTANCE_ENV]: "1" };
  }
}
