import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveGitPath } from "../../src/main/services/git-runtime";
import { InitManager } from "../../src/main/services/init-manager";
import { ServiceManager } from "../../src/main/services/service-manager";
import type { RuntimePaths } from "../../src/shared/contracts";

const bundled = resolve("runtime/git");
const systemGit = Bun.which("git");
const nativeTest = test.skipIf(process.platform !== "win32" || !existsSync(join(bundled, "cmd/git.exe")));

nativeTest("MaiBot gets bundled Git with no system Git and ignores a stale custom Git setting", async () => {
  const root = await mkdtemp(join(tmpdir(), "onekey-git-"));
  const originalEnv = process.env;
  let services: ServiceManager | undefined;
  try {
    process.env = { ...originalEnv, PATH: "" };
    delete process.env.Path;
    const runtimeRoot = join(root, "runtime");
    await mkdir(join(runtimeRoot, "python"), { recursive: true });
    await symlink(bundled, join(runtimeRoot, "git"), "junction");
    await writeFile(join(runtimeRoot, "python/python.exe"), "fixture interpreter");
    await writeFile(join(root, "bot.py"), "# source fixture");
    await writeFile(join(root, "runtime-paths.json"), JSON.stringify({ paths: { git: "Z:/missing/git.exe" } }));
    const paths = { maibotDevMode: "source", installRoot: root, userDataRoot: root, maibotRoot: root,
      runtimeRoot, bundledModulesRoot: root, napcatRoot: root, snowlumaRoot: root, logsRoot: root } as RuntimePaths;
    const init = new InitManager(paths);
    init.assertAgreementsConfirmed = async () => {};
    init.getAgreementEnvVars = async () => ({});
    const git = await init.getGitPath();
    expect(git).toBe(join(runtimeRoot, "git/cmd/git.exe"));
    let started = false;
    const pty = Object.assign(new EventEmitter(), {
      list: () => [], kill() {},
      start(request: { id: string; env: Record<string, string> }) {
        expect(request.env.GIT_PYTHON_GIT_EXECUTABLE).toBe(git);
        // The real child process must find Git using only the injected PATH.
        const child = Bun.spawnSync([process.env.ComSpec ?? "cmd.exe", "/d", "/c", "git --version"], {
          env: { ...process.env, ...request.env }, stdout: "pipe", stderr: "pipe",
        });
        expect(child.exitCode).toBe(0);
        expect(child.stdout.toString()).toStartWith("git version ");
        started = true;
        return { id: request.id, pid: 123 };
      },
    });
    services = new ServiceManager(paths, init, { append() {}, getServiceLogPath: () => join(root, "test.log") } as any, pty as any);
    (services as any).assertPortsFree = async () => {};
    (services as any).waitUntilReady = async () => {};
    await services.start("maibot");
    expect(started).toBe(true);
    expect(process.env.PATH).toBe("");
  } finally {
    services?.dispose();
    process.env = originalEnv;
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!systemGit)("broken or absent bundled Git falls back to an executable system Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "onekey-git-fallback-"));
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, PATH: dirname(systemGit!) };
    delete process.env.Path;
    const executable = process.platform === "win32" ? "cmd/git.exe" : "bin/git";
    await mkdir(dirname(join(root, "git", executable)), { recursive: true });
    await writeFile(join(root, "git", executable), "broken executable");
    expect(await resolveGitPath(root)).toBe(systemGit!);
    expect(await resolveGitPath(join(root, "absent-runtime"))).toBe(systemGit!);
  } finally {
    process.env = originalEnv;
    await rm(root, { recursive: true, force: true });
  }
});

nativeTest("MinGit clones and fetches without system Git on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "onekey-mingit-clone-"));
  const git = join(bundled, "cmd/git.exe");
  const source = join(root, "source");
  const clone = join(root, "clone");
  const env = { ...process.env, PATH: join(bundled, "cmd") };
  delete env.Path;
  const run = (...args: string[]) => {
    const child = Bun.spawnSync([git, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  try {
    run("init", "--initial-branch=main", source);
    const commit = () => run("-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--allow-empty", "-m", "fixture");
    commit();
    run("clone", source, clone);
    commit();
    run("-C", clone, "fetch", "origin");
    expect(run("-C", clone, "rev-parse", "origin/main")).toBe(run("-C", source, "rev-parse", "HEAD"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
