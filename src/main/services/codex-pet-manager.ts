import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { CodexPetOption, CodexPetSettings } from "../../shared/contracts";

const CODEX_PET_ASSET_SCHEME = "maibot-codex-pet";
const CODEX_PET_SPRITESHEET_HOST = "spritesheet";
const DEFAULT_SPRITESHEET_PATH = "spritesheet.webp";
const SUPPORTED_SPRITESHEET_EXTENSIONS = new Set([".png", ".webp"]);

interface CodexPetManifest {
  id?: unknown;
  displayName?: unknown;
  description?: unknown;
  spritesheetPath?: unknown;
}

interface CodexPetRecord extends CodexPetOption {
  directory: string;
  spritesheetPath: string;
}

export class CodexPetManager {
  private readonly petsRoot: string;
  private cache: CodexPetRecord[] | null = null;
  private cacheReadAt = 0;

  constructor() {
    const codexHome = typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim()
      ? process.env.CODEX_HOME.trim()
      : join(homedir(), ".codex");
    this.petsRoot = resolve(codexHome, "pets");
  }

  async getSettings(): Promise<CodexPetSettings> {
    const pets = await this.listPets();
    return {
      options: pets.map(({ directory, spritesheetPath, ...option }) => option),
    };
  }

  async resolveSpritesheetAsset(url: string): Promise<string | null> {
    const id = this.petIdFromAssetUrl(url);
    if (!id) {
      return null;
    }

    const pets = await this.listPets();
    return pets.find((pet) => pet.id === id)?.spritesheetPath ?? null;
  }

  private async listPets(): Promise<CodexPetRecord[]> {
    const now = Date.now();
    if (this.cache && now - this.cacheReadAt < 5000) {
      return this.cache;
    }

    const pets = await this.scanPets();
    this.cache = pets;
    this.cacheReadAt = now;
    return pets;
  }

  private async scanPets(): Promise<CodexPetRecord[]> {
    if (!existsSync(this.petsRoot)) {
      return [];
    }

    const entries = await readdir(this.petsRoot, { withFileTypes: true }).catch(() => []);
    const pets = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readPet(join(this.petsRoot, entry.name), entry.name)),
    );

    return pets
      .filter((pet): pet is CodexPetRecord => pet !== null)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-Hans-CN"));
  }

  private async readPet(directory: string, directoryName: string): Promise<CodexPetRecord | null> {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "pet.json"), "utf8")) as CodexPetManifest;
      const id = normalizePetId(manifest.id) ?? normalizePetId(directoryName);
      if (!id) {
        return null;
      }

      const rawSpritesheetPath =
        typeof manifest.spritesheetPath === "string" && manifest.spritesheetPath.trim()
          ? manifest.spritesheetPath.trim()
          : DEFAULT_SPRITESHEET_PATH;
      const spritesheetPath = resolve(directory, rawSpritesheetPath);
      if (!isPathInside(directory, spritesheetPath) || !SUPPORTED_SPRITESHEET_EXTENSIONS.has(extname(spritesheetPath).toLowerCase())) {
        return null;
      }

      const fileStat = await stat(spritesheetPath);
      if (!fileStat.isFile()) {
        return null;
      }

      return {
        id,
        displayName: typeof manifest.displayName === "string" && manifest.displayName.trim()
          ? manifest.displayName.trim()
          : id,
        description: typeof manifest.description === "string" && manifest.description.trim()
          ? manifest.description.trim()
          : undefined,
        spritesheetUrl: `${CODEX_PET_ASSET_SCHEME}://${CODEX_PET_SPRITESHEET_HOST}/${encodeURIComponent(id)}`,
        directory,
        spritesheetPath,
      };
    } catch {
      return null;
    }
  }

  private petIdFromAssetUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== `${CODEX_PET_ASSET_SCHEME}:` || parsed.hostname !== CODEX_PET_SPRITESHEET_HOST) {
        return null;
      }
      return normalizePetId(decodeURIComponent(parsed.pathname.replace(/^\/+/u, ""))) ?? null;
    } catch {
      return null;
    }
  }
}

export { CODEX_PET_ASSET_SCHEME };

function normalizePetId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]{1,80}$/u.test(trimmed) ? trimmed : undefined;
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
