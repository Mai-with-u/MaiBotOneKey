import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FloatingMascotMode, LauncherChatPageMode, LauncherUiSettings, RuntimePaths } from "../../shared/contracts";

const LAUNCHER_UI_SETTINGS_FILE = "launcher-ui-settings.json";

export class LauncherUiSettingsManager {
  private readonly settingsPath: string;
  private cache: LauncherUiSettings;

  constructor(paths: RuntimePaths) {
    this.settingsPath = join(paths.userDataRoot, LAUNCHER_UI_SETTINGS_FILE);
    this.cache = this.read();
  }

  getSettings(): LauncherUiSettings {
    return { ...this.cache };
  }

  async saveSettings(settings: LauncherUiSettings): Promise<LauncherUiSettings> {
    const normalized = normalizeLauncherUiSettings(settings);
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(
      this.settingsPath,
      `${JSON.stringify({ version: 1, ...normalized }, null, 2)}\n`,
      "utf8",
    );
    this.cache = normalized;
    return this.getSettings();
  }

  async resetSettings(): Promise<LauncherUiSettings> {
    this.cache = defaultLauncherUiSettings();
    return this.getSettings();
  }

  private read(): LauncherUiSettings {
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<LauncherUiSettings>;
      return normalizeLauncherUiSettings(raw);
    } catch {
      return defaultLauncherUiSettings();
    }
  }
}

function defaultLauncherUiSettings(): LauncherUiSettings {
  return {
    chatPageMode: "webui",
    floatingMascotMode: "maibot",
  };
}

function normalizeChatPageMode(value: unknown): LauncherChatPageMode {
  return value === "native" ? "native" : "webui";
}

function normalizeFloatingMascotMode(value: unknown): FloatingMascotMode {
  return value === "codex-pet" ? "codex-pet" : "maibot";
}

function normalizeCodexPetId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]{1,80}$/u.test(trimmed) ? trimmed : undefined;
}

function normalizeLauncherUiSettings(value: Partial<LauncherUiSettings>): LauncherUiSettings {
  return {
    chatPageMode: normalizeChatPageMode(value.chatPageMode),
    floatingMascotMode: normalizeFloatingMascotMode(value.floatingMascotMode),
    floatingCodexPetId: normalizeCodexPetId(value.floatingCodexPetId),
  };
}
