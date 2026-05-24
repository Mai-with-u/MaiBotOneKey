import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildMaiBotPluginBlueprintFiles,
  defaultMaiBotPluginFolderName,
  sanitizeMaiBotPluginFolderName,
  validateMaiBotPluginBlueprint,
} from "../../shared/plugin-blueprint";
import type {
  MaiBotPluginBlueprint,
  MaiBotPluginBuilderLibraryDeleteResult,
  MaiBotPluginBuilderLibraryItem,
  MaiBotPluginBuilderLibraryListResult,
  MaiBotPluginBuilderLibraryLoadResult,
  MaiBotPluginBuilderLibrarySaveResult,
} from "../../shared/contracts";

const BLUEPRINT_FILE_NAME = ".maibot-onekey-blueprint.json";

interface StoredBuilderBlueprint {
  version: 1;
  createdAt: number;
  updatedAt: number;
  blueprint: MaiBotPluginBlueprint;
}

export class PluginBuilderLibrary {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  getRoot(): string {
    return this.root;
  }

  async list(): Promise<MaiBotPluginBuilderLibraryListResult> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const plugins: MaiBotPluginBuilderLibraryItem[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const pluginPath = this.safeLibraryPath(entry.name);
      const stored = await this.readStoredBlueprint(pluginPath).catch(() => null);
      if (!stored) {
        continue;
      }
      plugins.push(await this.createItem(pluginPath, stored));
    }

    plugins.sort((left, right) => right.updatedAt - left.updatedAt);
    return { root: this.root, plugins };
  }

  async save(blueprint: MaiBotPluginBlueprint, overwrite = true): Promise<MaiBotPluginBuilderLibrarySaveResult> {
    const errors = validateMaiBotPluginBlueprint(blueprint);
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }

    const pluginId = blueprint.manifest.pluginId.trim();
    const folderName = sanitizeMaiBotPluginFolderName(
      blueprint.manifest.folderName ?? defaultMaiBotPluginFolderName(pluginId),
      pluginId,
    );
    const pluginPath = this.safeLibraryPath(folderName);
    const existed = await pathExists(pluginPath);
    if (existed && !overwrite) {
      throw new Error("Builder plugin already exists. Enable overwrite to update it.");
    }

    const now = Date.now();
    const previous = existed ? await this.readStoredBlueprint(pluginPath).catch(() => null) : null;
    if (existed) {
      await rm(pluginPath, { recursive: true, force: true });
    }
    await mkdir(pluginPath, { recursive: true });

    const normalizedBlueprint: MaiBotPluginBlueprint = {
      ...blueprint,
      manifest: {
        ...blueprint.manifest,
        pluginId,
        folderName,
      },
    };
    const files = buildMaiBotPluginBlueprintFiles(normalizedBlueprint);
    const stored: StoredBuilderBlueprint = {
      version: 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      blueprint: normalizedBlueprint,
    };

    await writeFile(
      this.blueprintPath(pluginPath),
      `${JSON.stringify(stored, null, 2)}\n`,
      "utf8",
    );
    for (const file of files) {
      const targetPath = resolve(pluginPath, file.relativePath);
      if (!isPathInsideOrSame(pluginPath, targetPath)) {
        throw new Error(`Refusing to write outside builder plugin directory: ${file.relativePath}`);
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content, "utf8");
    }

    return {
      item: await this.createItem(pluginPath, stored),
      files,
      overwritten: existed,
      savedAt: now,
    };
  }

  async load(pluginId: string): Promise<MaiBotPluginBuilderLibraryLoadResult> {
    const pluginPath = await this.resolveLibraryPluginPath(pluginId);
    const stored = await this.readStoredBlueprint(pluginPath);
    return {
      item: await this.createItem(pluginPath, stored),
      blueprint: stored.blueprint,
      files: buildMaiBotPluginBlueprintFiles(stored.blueprint),
    };
  }

  async delete(pluginId: string): Promise<MaiBotPluginBuilderLibraryDeleteResult> {
    const pluginPath = await this.resolveLibraryPluginPath(pluginId);
    const stored = await this.readStoredBlueprint(pluginPath);
    await rm(pluginPath, { recursive: true, force: true });
    return {
      pluginId: stored.blueprint.manifest.pluginId,
      path: pluginPath,
      deletedAt: Date.now(),
    };
  }

  private async resolveLibraryPluginPath(pluginId: string): Promise<string> {
    const list = await this.list();
    const item = list.plugins.find((plugin) =>
      plugin.pluginId === pluginId || plugin.folderName === pluginId
    );
    if (!item) {
      throw new Error(`Builder plugin not found: ${pluginId}`);
    }
    return this.safeLibraryPath(item.folderName);
  }

  private async createItem(
    pluginPath: string,
    stored: StoredBuilderBlueprint,
  ): Promise<MaiBotPluginBuilderLibraryItem> {
    const manifest = stored.blueprint.manifest;
    const folderName = pluginPath.split(/[\\/]+/u).at(-1) ?? defaultMaiBotPluginFolderName(manifest.pluginId);
    const files = buildMaiBotPluginBlueprintFiles(stored.blueprint);
    const pluginStat = await stat(pluginPath).catch(() => undefined);
    return {
      pluginId: manifest.pluginId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      folderName,
      path: pluginPath,
      blueprintPath: this.blueprintPath(pluginPath),
      updatedAt: stored.updatedAt || pluginStat?.mtimeMs || Date.now(),
      createdAt: stored.createdAt,
      fileCount: files.length,
    };
  }

  private async readStoredBlueprint(pluginPath: string): Promise<StoredBuilderBlueprint> {
    const raw = JSON.parse(await readFile(this.blueprintPath(pluginPath), "utf8")) as Partial<StoredBuilderBlueprint>;
    if (raw.version !== 1 || !raw.blueprint?.manifest?.pluginId) {
      throw new Error("Invalid builder plugin blueprint.");
    }
    return {
      version: 1,
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
      blueprint: raw.blueprint,
    };
  }

  private blueprintPath(pluginPath: string): string {
    return resolve(pluginPath, BLUEPRINT_FILE_NAME);
  }

  private safeLibraryPath(folderName: string): string {
    const targetPath = resolve(this.root, folderName);
    if (!isPathInsideOrSame(this.root, targetPath) || targetPath === this.root) {
      throw new Error("Invalid builder plugin path.");
    }
    return targetPath;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isPathInsideOrSame(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return !diff || (diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff));
}
