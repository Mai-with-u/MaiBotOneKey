import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OpenCodeSettings, RuntimePaths } from "../../shared/contracts";

const OPENCODE_SETTINGS_FILE = "opencode-settings.json";

export class OpenCodeSettingsManager {
  private readonly settingsPath: string;
  private cache: OpenCodeSettings;

  constructor(paths: RuntimePaths) {
    this.settingsPath = join(paths.userDataRoot, OPENCODE_SETTINGS_FILE);
    this.cache = this.read();
  }

  getSettings(): OpenCodeSettings {
    return { ...this.cache };
  }

  async saveSettings(settings: OpenCodeSettings): Promise<OpenCodeSettings> {
    const normalized = normalizeOpenCodeSettings(settings);
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    this.cache = normalized;
    return this.getSettings();
  }

  async resetSettings(): Promise<OpenCodeSettings> {
    this.cache = defaultOpenCodeSettings();
    return this.getSettings();
  }

  private read(): OpenCodeSettings {
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<OpenCodeSettings>;
      return normalizeOpenCodeSettings(raw);
    } catch {
      return defaultOpenCodeSettings();
    }
  }
}

function defaultOpenCodeSettings(): OpenCodeSettings {
  return {
    useBundledPluginInstructions: true,
  };
}

function normalizeOpenCodeSettings(value: Partial<OpenCodeSettings>): OpenCodeSettings {
  return {
    useBundledPluginInstructions: value.useBundledPluginInstructions !== false,
  };
}
