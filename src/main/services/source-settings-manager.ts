import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ManagedSourceEntry, RuntimePaths, SourceSettings, SourceSettingsUpdate } from "../../shared/contracts";

const SOURCE_SETTINGS_FILE = "source-settings.json";

const DEFAULT_SOURCE_SETTINGS: SourceSettings = {
  python: [
    {
      id: "tuna",
      label: "清华源",
      url: "https://pypi.tuna.tsinghua.edu.cn/simple",
      trustedHost: "pypi.tuna.tsinghua.edu.cn",
      builtIn: true,
    },
    {
      id: "aliyun",
      label: "阿里源",
      url: "https://mirrors.aliyun.com/pypi/simple",
      trustedHost: "mirrors.aliyun.com",
      builtIn: true,
    },
    { id: "pypi", label: "官方 PyPI", url: "https://pypi.org/simple", builtIn: true },
  ],
};

export class SourceSettingsManager {
  private readonly settingsPath: string;

  constructor(paths: RuntimePaths) {
    this.settingsPath = join(paths.userDataRoot, SOURCE_SETTINGS_FILE);
  }

  getSettings(): SourceSettings {
    return this.normalizeSettings(this.readStoredSettings());
  }

  getDefaultSettings(): SourceSettings {
    return cloneSettings(DEFAULT_SOURCE_SETTINGS);
  }

  async saveSettings(update: SourceSettingsUpdate): Promise<SourceSettings> {
    const next = this.normalizeSettings(update);
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(
      this.settingsPath,
      `${JSON.stringify({ version: 1, updatedAt: Date.now(), ...next }, null, 2)}\n`,
      "utf8",
    );
    return next;
  }

  async resetSettings(): Promise<SourceSettings> {
    return this.saveSettings(this.getDefaultSettings());
  }

  getPythonSources(): ManagedSourceEntry[] {
    return this.getSettings().python;
  }

  private readStoredSettings(): SourceSettingsUpdate | undefined {
    if (!existsSync(this.settingsPath)) {
      return undefined;
    }

    try {
      return JSON.parse(readFileSync(this.settingsPath, "utf8")) as SourceSettingsUpdate;
    } catch {
      return undefined;
    }
  }

  private normalizeSettings(update?: SourceSettingsUpdate): SourceSettings {
    return {
      python: normalizeEntries(update?.python, DEFAULT_SOURCE_SETTINGS.python),
    };
  }
}

function cloneSettings(settings: SourceSettings): SourceSettings {
  return {
    python: settings.python.map((entry) => ({ ...entry })),
  };
}

function normalizeEntries(rawEntries: ManagedSourceEntry[] | undefined, defaults: ManagedSourceEntry[]): ManagedSourceEntry[] {
  const source = Array.isArray(rawEntries) && rawEntries.length > 0 ? rawEntries : defaults;
  const entries: ManagedSourceEntry[] = [];
  const seen = new Set<string>();

  for (const entry of source) {
    const id = sanitizeId(entry.id || entry.label || entry.url);
    const label = entry.label?.trim();
    const url = entry.url?.trim() ?? "";
    if (!id || !label || !url || seen.has(id)) {
      continue;
    }
    seen.add(id);
    entries.push({
      id,
      label,
      url,
      trustedHost: entry.trustedHost?.trim() || undefined,
      builtIn: defaults.some((item) => item.id === id) || entry.builtIn === true,
    });
  }

  return entries.length > 0 ? entries : defaults;
}

function sanitizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}
