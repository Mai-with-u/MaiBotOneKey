import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mergeProcessEnvironment } from "../../../src/main/process-environment";

const python = resolve("runtime/python/python.exe");
const gitDirectory = resolve("runtime/git/cmd");

test.skipIf(process.platform !== "win32" || !existsSync(python))(
  "MaiBot Python finds bundled Git when inherited Path has different casing",
  () => {
    for (const [baseKey, overrideKey] of [["Path", "PATH"], ["PATH", "Path"]]) {
      const base = { ...process.env };
      for (const key of Object.keys(base)) if (key.toUpperCase() === "PATH") delete base[key];
      base[baseKey] = "C:\\missing-system-git";
      const env = mergeProcessEnvironment(base, { [overrideKey]: gitDirectory });
      expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toHaveLength(1);
      const child = Bun.spawnSync([python, "-I", "-c",
        "import shutil, subprocess; assert shutil.which('git'); print(subprocess.check_output(['git', '--version'], text=True).strip())"],
      { env, stdout: "pipe", stderr: "pipe" });
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toStartWith("git version ");
      expect(base[baseKey]).toBe("C:\\missing-system-git");
    }
  },
);

test("POSIX keeps environment names case-sensitive", () => {
  expect(mergeProcessEnvironment({ Path: "original" }, { PATH: "override" }, "linux"))
    .toEqual({ Path: "original", PATH: "override" });
});
