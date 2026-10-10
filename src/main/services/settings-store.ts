import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from "../../shared/config";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import {
  recoverSettings,
  type SettingsRecovery,
} from "../../shared/settings-recovery";

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

export function loadSettingsReport(): SettingsRecovery {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown;
    return recoverSettings(raw);
  } catch {
    return { settings: { ...DEFAULT_CHAT_SETTINGS }, issues: [] };
  }
}

export function loadSettings(): ChatSettings {
  return loadSettingsReport().settings;
}

export function saveSettings(settings: ChatSettings): ChatSettings {
  const parsed = chatSettingsSchema.parse(settings);
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(parsed, null, 2), "utf8");
  return parsed;
}
