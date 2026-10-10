import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from "./config";
import { chatSettingsSchema } from "./storage-ipc";

export const CONTEXT_PRESETS = [
  2048, 4096, 8192, 16384, 32768, 65536, 131072,
] as const;

export type SettingsRecovery = {
  settings: ChatSettings;
  issues: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recoverSettings(raw: unknown): SettingsRecovery {
  const parsed = chatSettingsSchema.safeParse(raw);
  if (parsed.success) return { settings: parsed.data, issues: [] };
  if (!isRecord(raw)) {
    return {
      settings: { ...DEFAULT_CHAT_SETTINGS },
      issues: [
        "Settings file was not an object. Other saved fields could not be read.",
      ],
    };
  }

  const issues: string[] = [];
  const model =
    typeof raw.model === "string" && raw.model.trim()
      ? raw.model
      : DEFAULT_CHAT_SETTINGS.model;
  if (
    model === DEFAULT_CHAT_SETTINGS.model &&
    raw.model !== DEFAULT_CHAT_SETTINGS.model
  ) {
    issues.push(
      "Saved model was missing. The default model is shown until you save another.",
    );
  }
  const think =
    typeof raw.think === "boolean" ? raw.think : DEFAULT_CHAT_SETTINGS.think;
  if (typeof raw.think !== "boolean")
    issues.push(
      "Saved thinking value was invalid and was left at the default.",
    );
  const temperature =
    typeof raw.temperature === "number" &&
    raw.temperature >= 0 &&
    raw.temperature <= 2
      ? raw.temperature
      : DEFAULT_CHAT_SETTINGS.temperature;
  if (
    temperature === DEFAULT_CHAT_SETTINGS.temperature &&
    raw.temperature !== DEFAULT_CHAT_SETTINGS.temperature
  ) {
    issues.push("Saved temperature was outside 0–2. Other settings were kept.");
  }
  const numCtx =
    typeof raw.numCtx === "number" &&
    Number.isInteger(raw.numCtx) &&
    raw.numCtx >= 512 &&
    raw.numCtx <= 131072
      ? raw.numCtx
      : DEFAULT_CHAT_SETTINGS.numCtx;
  if (
    numCtx === DEFAULT_CHAT_SETTINGS.numCtx &&
    raw.numCtx !== DEFAULT_CHAT_SETTINGS.numCtx
  ) {
    issues.push("Saved context size was invalid. Other settings were kept.");
  }
  const keepAlive =
    typeof raw.keepAlive === "string" && raw.keepAlive.trim()
      ? raw.keepAlive
      : DEFAULT_CHAT_SETTINGS.keepAlive;

  return { settings: { model, think, temperature, numCtx, keepAlive }, issues };
}

export function contextChoices(
  current: number,
): { value: string; label: string }[] {
  const presets = CONTEXT_PRESETS.map((value) => ({
    value: String(value),
    label: value >= 1024 ? `${value / 1024}K (${value})` : String(value),
  }));
  if (CONTEXT_PRESETS.some((value) => value === current)) return presets;
  return [{ value: String(current), label: `${current} (saved)` }, ...presets];
}

export function legacyTemperatureNotice(temperature: number): string | null {
  if (temperature <= 1) return null;
  return `Saved temperature is ${temperature}. This control stops at 1. Saving stores the slider value and leaves every other setting in place.`;
}

export function sliderTemperature(temperature: number): number {
  const clamped = Math.min(1, Math.max(0, temperature));
  return Math.round(clamped * 10) / 10;
}
