import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import type { RuntimePaths } from "../../src/shared/contracts";
import { PythonDependencyManager } from "../../src/main/services/python-dependency-manager";

test("a timed out installer closes before fallback or environment cleanup can begin", async () => {
  const manager = new PythonDependencyManager({ installRoot: process.cwd() } as RuntimePaths);
  manager.getPythonPath = () => process.execPath;
  const output: string[] = [];
  const pending = (manager as any).runPythonStreaming(
    ["-e", "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'inherit'}); console.log('descendant:'+child.pid); console.log('dependency download started'); setInterval(() => {}, 1000)"],
    undefined, (line: string) => output.push(line), undefined, 12000,
  ) as Promise<string[]>;
  const child = (manager as any).startupUpgradeChild as ChildProcess;
  let closed = false;
  child.on("close", () => { closed = true; });
  await expect(pending).rejects.toThrow("Python command timed out");
  expect(closed).toBe(true);
  expect(output).toContain("dependency download started");
  const descendant = Number(output.find((line) => line.startsWith("descendant:"))?.split(":")[1]);
  expect(descendant).toBeGreaterThan(0);
  expect(() => process.kill(descendant, 0)).toThrow();
  expect((manager as any).startupUpgradeChild).toBeUndefined();
}, 20000);

test("cancellation waits for installer exit before rejecting", async () => {
  const manager = new PythonDependencyManager({ installRoot: process.cwd() } as RuntimePaths);
  manager.getPythonPath = () => process.execPath;
  const controller = new AbortController();
  const pending = (manager as any).runPythonStreaming(
    ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
    controller.signal, () => controller.abort(), undefined, 3000,
  ) as Promise<string[]>;
  const child = (manager as any).startupUpgradeChild as ChildProcess;
  let closed = false;
  child.on("close", () => { closed = true; });
  await expect(pending).rejects.toThrow("cancelled");
  expect(closed).toBe(true);
  expect((manager as any).startupUpgradeChild).toBeUndefined();
});

test("the last installer error is retained even without a trailing newline", async () => {
  const manager = new PythonDependencyManager({ installRoot: process.cwd() } as RuntimePaths);
  manager.getPythonPath = () => process.execPath;
  await expect((manager as any).runPythonStreaming(
    ["-e", "process.stderr.write('ERROR: ResolutionImpossible'); process.exitCode=1"],
    undefined, () => {},
  )).rejects.toThrow("ERROR: ResolutionImpossible");
});
