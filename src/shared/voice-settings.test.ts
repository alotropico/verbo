import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_SETTINGS,
  recoverVoiceSettings,
  sameVoiceSettings,
  voiceSettingsSchema,
} from "./voice-settings";

describe("voice settings", () => {
  it("keeps a valid file and drops one bad field", () => {
    expect(recoverVoiceSettings(DEFAULT_VOICE_SETTINGS)).toEqual(
      DEFAULT_VOICE_SETTINGS,
    );
    expect(
      recoverVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        silenceSendMs: 50,
        speakReplies: false,
      }),
    ).toEqual({ ...DEFAULT_VOICE_SETTINGS, speakReplies: false });
    expect(recoverVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it("rejects a language outside English, Spanish, and auto", () => {
    expect(
      voiceSettingsSchema.safeParse({
        ...DEFAULT_VOICE_SETTINGS,
        sttLanguage: "fr",
      }).success,
    ).toBe(false);
    expect(
      sameVoiceSettings(DEFAULT_VOICE_SETTINGS, {
        ...DEFAULT_VOICE_SETTINGS,
        voiceId: "en_US-ljspeech-medium",
      }),
    ).toBe(false);
  });
});
