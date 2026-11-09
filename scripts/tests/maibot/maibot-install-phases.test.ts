import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonDependencyManager } from "../../../src/main/services/python-dependency-manager";
import type { RuntimePaths } from "../../../src/shared/contracts";

test("core installation defers dependencies, then resolves only core requirements", async () => {
  const python = new PythonDependencyManager({} as RuntimePaths);
  const phases: string[] = [];
  const install = spyOn(python as any, "installRequirementsIntoEnvironment")
    .mockResolvedValueOnce({ sourceUrl: "core-index", output: ["core"] })
    .mockResolvedValueOnce({ sourceUrl: "dependencies-index", output: ["dependencies"] });
  const result = await python.installMaiBot("1.3.8", undefined, undefined, "constraints.txt", (phase) => phases.push(phase));
  expect(phases).toEqual(["core", "dependencies"]);
  expect(install.mock.calls[0][0]).toContain("--no-deps");
  expect(install.mock.calls[1][0]).not.toContain("--no-deps");
  expect(install.mock.calls[1][1]).toEqual(["maibot==1.3.8", "--constraint", "constraints.txt"]);
  expect(result.sourceUrl).toBe("core-index");
});

test("failed core installation does not advance to dependency installation", async () => {
  const python = new PythonDependencyManager({} as RuntimePaths);
  const phases: string[] = [];
  const install = spyOn(python as any, "installRequirementsIntoEnvironment").mockRejectedValue(new Error("core download failed"));
  await expect(python.installMaiBot("1.3.8", undefined, undefined, undefined, (phase) => phases.push(phase))).rejects.toThrow("core download failed");
  expect(phases).toEqual(["core"]);
  expect(install).toHaveBeenCalledTimes(1);
});

test("new environments seed compatible bundled wheels before resolving remaining dependencies", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "onekey-wheels-"));
  try {
    const python = new PythonDependencyManager({ runtimeRoot } as RuntimePaths);
    const internals = python as any;
    const calls: string[] = [];
    spyOn(internals, "installRequirementsIntoEnvironment").mockImplementation(async (args: string[]) => {
      calls.push(args.includes("--no-deps") ? "core" : "dependencies");
      return { sourceUrl: "mirror", output: [] };
    });
    const wheels = join(runtimeRoot, "python-wheels");
    await mkdir(wheels);
    const run = spyOn(internals, "runPython").mockImplementation(async (args: string[]) => {
      if (args.includes("-c")) {
        calls.push("select");
        return ["jieba==0.42.1"];
      }
      calls.push("local");
      return [];
    });
    await python.installMaiBot("1.4.4");
    expect(calls).toEqual(["core", "select", "local", "dependencies"]);
    expect(run.mock.calls[1][0]).toContain("--no-index");
    expect(run.mock.calls[1][0].slice(-4)).toEqual(["--no-deps", "--find-links", wheels, "jieba==0.42.1"]);

    calls.length = 0;
    await python.installMaiBot("1.4.4", undefined, undefined, "constraints.txt");
    expect(calls).toEqual(["core", "dependencies"]);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
