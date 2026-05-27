import { nativeImage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppIconId, AppIconOption, AppIconSettings, RuntimePaths } from "../../shared/contracts";

const APP_ICON_SETTINGS_FILE = "app-icon-settings.json";
const DEFAULT_APP_ICON_ID: AppIconId = "sprout";

const APP_ICON_OPTIONS = [
  {
    id: "soft",
    label: "圆角头像",
    description: "使用新的柔和圆角麦麦头像。",
    fileName: "soft.png",
  },
  {
    id: "sprout",
    label: "小芽头像",
    description: "使用带小芽和圆滚滚脸型的麦麦头像。",
    fileName: "sprout.png",
  },
  {
    id: "bean",
    label: "橙团小芽",
    description: "使用更近景、更圆润的橙团小芽头像。",
    fileName: "bean.png",
  },
] as const satisfies readonly (AppIconOption & { fileName: string })[];

interface StoredAppIconSettingsFile {
  version: 1;
  selectedIconId?: AppIconId;
}

function normalizeAppIconId(value: unknown): AppIconId {
  return APP_ICON_OPTIONS.some((option) => option.id === value) ? (value as AppIconId) : DEFAULT_APP_ICON_ID;
}

export class AppIconManager {
  private selectedIconId: AppIconId;
  private readonly settingsPath: string;
  private readonly iconRoot: string;
  private readonly fallbackIconPath: string;

  constructor(paths: RuntimePaths, packaged: boolean) {
    this.settingsPath = join(paths.userDataRoot, APP_ICON_SETTINGS_FILE);
    this.iconRoot = packaged ? join(process.resourcesPath, "app-icons") : join(paths.installRoot, "resources", "app-icons");
    this.fallbackIconPath = packaged ? join(process.resourcesPath, "icon.png") : join(paths.installRoot, "resources", "icon.png");
    this.selectedIconId = this.readSelectedIconId();
  }

  getSettings(): AppIconSettings {
    return {
      selectedIconId: this.selectedIconId,
      options: APP_ICON_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        previewUrl: this.previewUrl(option.id),
      })),
    };
  }

  createIcon(): Electron.NativeImage {
    const icon = nativeImage.createFromPath(this.iconPath(this.selectedIconId));
    return icon.isEmpty() ? nativeImage.createFromPath(this.fallbackIconPath) : icon;
  }

  async select(iconId: AppIconId): Promise<AppIconSettings> {
    this.selectedIconId = normalizeAppIconId(iconId);
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(
      this.settingsPath,
      `${JSON.stringify({ version: 1, selectedIconId: this.selectedIconId } satisfies StoredAppIconSettingsFile, null, 2)}\n`,
      "utf8",
    );
    return this.getSettings();
  }

  reset(): AppIconSettings {
    this.selectedIconId = DEFAULT_APP_ICON_ID;
    return this.getSettings();
  }

  getIconPath(iconId: AppIconId): string {
    return this.iconPath(normalizeAppIconId(iconId));
  }

  private readSelectedIconId(): AppIconId {
    if (!existsSync(this.settingsPath)) {
      return DEFAULT_APP_ICON_ID;
    }

    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as StoredAppIconSettingsFile;
      return normalizeAppIconId(raw.selectedIconId);
    } catch {
      return DEFAULT_APP_ICON_ID;
    }
  }

  private iconPath(iconId: AppIconId): string {
    const option = APP_ICON_OPTIONS.find((candidate) => candidate.id === iconId) ?? APP_ICON_OPTIONS[0];
    const optionPath = join(this.iconRoot, option.fileName);
    return existsSync(optionPath) ? optionPath : this.fallbackIconPath;
  }

  private previewUrl(iconId: AppIconId): string | undefined {
    try {
      return `data:image/png;base64,${readFileSync(this.iconPath(iconId)).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

}
