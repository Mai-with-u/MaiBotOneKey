import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const child = Bun.spawn([process.execPath, join(root, "scripts/dev/start-dev.ts"), "--mode", "pypi", ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, MAIBOT_ONEKEY_DEV_INSTANCES: "1" },
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
process.exit(await child.exited);
