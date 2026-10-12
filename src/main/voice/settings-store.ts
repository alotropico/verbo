import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { app } from "electron";
import {
  recoverVoiceSettings,
  voiceSettingsSchema,
  type VoiceSettings,
} from "../../shared/voice-settings";

function settingsPath(): string {
  return join(app.getPath("userData"), "voice-settings.json");
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown;
    return recoverVoiceSettings(raw);
  } catch {
    return recoverVoiceSettings(undefined);
  }
}

export function saveVoiceSettings(settings: VoiceSettings): VoiceSettings {
  const parsed = voiceSettingsSchema.parse(settings);
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(parsed, null, 2), "utf8");
  return parsed;
}
