import { expect, spyOn, test } from "bun:test";
import { PythonDependencyManager } from "../../src/main/services/python-dependency-manager";
import type { RuntimePaths } from "../../src/shared/contracts";

test("core installation defers dependencies, then resolves core and plugin requirements together", async () => {
  const python = new PythonDependencyManager({} as RuntimePaths);
  const phases: string[] = [];
  const install = spyOn(python as any, "installRequirementsIntoEnvironment")
    .mockResolvedValueOnce({ sourceUrl: "core-index", output: ["core"] })
    .mockResolvedValueOnce({ sourceUrl: "dependencies-index", output: ["dependencies"] });
  const result = await python.installMaiBot("1.3.8", ["plugin-requirements.txt"], undefined, undefined, "constraints.txt", (phase) => phases.push(phase));
  expect(phases).toEqual(["core", "dependencies"]);
  expect(install.mock.calls[0][0]).toContain("--no-deps");
  expect(install.mock.calls[1][0]).not.toContain("--no-deps");
  expect(install.mock.calls[1][1]).toEqual(["maibot==1.3.8", "--constraint", "constraints.txt", "-r", "plugin-requirements.txt"]);
  expect(result.sourceUrl).toBe("core-index");
});

test("failed core installation does not advance to dependency installation", async () => {
  const python = new PythonDependencyManager({} as RuntimePaths);
  const phases: string[] = [];
  const install = spyOn(python as any, "installRequirementsIntoEnvironment").mockRejectedValue(new Error("core download failed"));
  await expect(python.installMaiBot("1.3.8", [], undefined, undefined, undefined, (phase) => phases.push(phase))).rejects.toThrow("core download failed");
  expect(phases).toEqual(["core"]);
  expect(install).toHaveBeenCalledTimes(1);
});
