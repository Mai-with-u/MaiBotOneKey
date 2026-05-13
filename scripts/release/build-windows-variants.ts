import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

type Variant = "full" | "lite";
type JsonObject = Record<string, unknown>;

const root = process.cwd();
const variants: Variant[] = ["full", "lite"];

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseVariants(): Variant[] {
  const variantIndex = process.argv.indexOf("--variant");
  if (variantIndex === -1) {
    return variants;
  }

  const variant = process.argv[variantIndex + 1];
  if (variant === "full" || variant === "lite") {
    return [variant];
  }

  throw new Error("--variant must be either full or lite");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function addFilterPatterns(filter: unknown, patterns: string[]): string[] {
  const base = Array.isArray(filter) ? filter.filter((item): item is string => typeof item === "string") : ["**/*"];
  for (const pattern of patterns) {
    if (!base.includes(pattern)) {
      base.push(pattern);
    }
  }
  return base;
}

function createVariantConfig(baseConfig: JsonObject, variant: Variant): JsonObject {
  const config = cloneJson(baseConfig);
  const win = isObject(config.win) ? config.win : {};

  config.win = {
    ...win,
    artifactName: `\${productName}-\${version}-win-\${arch}-${variant}.\${ext}`,
  };

  if (variant === "lite") {
    config.extraResources = Array.isArray(config.extraResources)
      ? config.extraResources.flatMap((item) => {
          if (!isObject(item) || item.from !== "runtime") {
            return [item];
          }
          if (!existsSync(join(root, "runtime"))) {
            return [];
          }

          return [{
            ...item,
            filter: addFilterPatterns(item.filter, ["!git", "!git/**"]),
          }];
        })
      : config.extraResources;
  }

  return config;
}

function hasEmbeddedGit(): boolean {
  return [
    join(root, "runtime", "git", "bin", "git.exe"),
    join(root, "runtime", "git", "cmd", "git.exe"),
    join(root, "runtime", "git", "git.exe"),
    join(root, "runtime", "git", "bin", "git"),
  ].some((path) => existsSync(path));
}

function hasEmbeddedPython(): boolean {
  return [
    join(root, "runtime", "python", "python.exe"),
    join(root, "runtime", "python", "bin", "python.exe"),
    join(root, "runtime", "python", "python"),
    join(root, "runtime", "python", "bin", "python3"),
  ].some((path) => existsSync(path));
}

function electronBuilderInvocation(): { command: string; argsPrefix: string[] } {
  return {
    command: process.execPath,
    argsPrefix: [join(root, "node_modules", "electron-builder", "cli.js")],
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function renameLatestMetadata(variant: Variant): Promise<void> {
  const latestPath = join(root, "release", "latest.yml");
  if (!existsSync(latestPath)) {
    return;
  }

  const variantPath = join(root, "release", `latest-${variant}.yml`);
  await rm(variantPath, { force: true });
  await rename(latestPath, variantPath);
}

async function readBuildConfig(): Promise<JsonObject> {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { build?: unknown };
  if (!isObject(packageJson.build)) {
    throw new Error("package.json is missing a build config");
  }
  return packageJson.build;
}

async function main(): Promise<void> {
  const requestedVariants = parseVariants();
  if (requestedVariants.includes("full") && !hasEmbeddedGit()) {
    throw new Error("Cannot build the full installer because runtime/git is missing.");
  }
  if (!hasEmbeddedPython()) {
    throw new Error("Cannot build the installer because runtime/python is missing.");
  }

  const buildConfig = await readBuildConfig();
  const tempDir = join(root, "tmp", "release");
  await mkdir(tempDir, { recursive: true });

  try {
    for (const variant of requestedVariants) {
      const configPath = join(tempDir, `electron-builder-${variant}.json`);
      await writeFile(configPath, `${JSON.stringify(createVariantConfig(buildConfig, variant), null, 2)}\n`, "utf8");

      console.log(`[release] Building Windows x64 installer: ${variant}`);
      const builder = electronBuilderInvocation();
      try {
        await run(builder.command, [...builder.argsPrefix, "--config", configPath, "--win", "nsis", "--x64"]);
        await renameLatestMetadata(variant);
      } finally {
        await rm(configPath, { force: true });
      }
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

await main();
