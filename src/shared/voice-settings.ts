import { z } from "zod";

export const VOICE_SETTINGS_EVENT = "verbo:voice-settings";

export const voiceLanguages = ["auto", "en", "es"] as const;

export type VoiceLanguage = (typeof voiceLanguages)[number];

const savedVoiceId = z.union([
  z.literal(""),
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
]);

export const voiceSettingsSchema = z
  .object({
    speechRms: z.number().min(0.005).max(0.12),
    silenceHoldMs: z.number().int().min(300).max(2500),
    minSpeechMs: z.number().int().min(100).max(1500),
    maxSegmentMs: z.number().int().min(5000).max(60_000),
    silenceSendMs: z.number().int().min(400).max(8000),
    sttLanguage: z.enum(voiceLanguages),
    speakReplies: z.boolean(),
    voiceId: savedVoiceId,
    maxSpokenChunks: z.number().int().min(1).max(4),
  })
  .strict();

export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  speechRms: 0.02,
  silenceHoldMs: 700,
  minSpeechMs: 300,
  maxSegmentMs: 20_000,
  silenceSendMs: 1_000,
  sttLanguage: "auto",
  speakReplies: true,
  voiceId: "",
  maxSpokenChunks: 4,
};

const voiceSettingKeys = Object.keys(
  DEFAULT_VOICE_SETTINGS,
) as (keyof VoiceSettings)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recoverVoiceSettings(raw: unknown): VoiceSettings {
  const parsed = voiceSettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (!isRecord(raw)) return { ...DEFAULT_VOICE_SETTINGS };
  const next = { ...DEFAULT_VOICE_SETTINGS };
  for (const key of voiceSettingKeys) {
    const candidate = { ...next, [key]: raw[key] };
    const check = voiceSettingsSchema.safeParse(candidate);
    if (check.success) Object.assign(next, { [key]: check.data[key] });
  }
  return next;
}

export function sameVoiceSettings(
  left: VoiceSettings,
  right: VoiceSettings,
): boolean {
  return voiceSettingKeys.every((key) => left[key] === right[key]);
}
