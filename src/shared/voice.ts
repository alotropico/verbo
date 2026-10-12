import { z } from "zod";

export const VOICE_IDENTITY = "verbo-voice";
export const VOICE_API_VERSION = "1";
export const DEFAULT_VOICE_BASE_URL = "http://127.0.0.1:8765";
export const MAX_VOICE_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_VOICE_TEXT_CHARS = 2000;

export type EngineReadiness = {
  ready: boolean;
  detail: string;
};

export type VoiceInfo = {
  id: string;
  language: string;
};

export type VoiceStatus =
  | {
      ok: true;
      identity: typeof VOICE_IDENTITY;
      apiVersion: typeof VOICE_API_VERSION;
      stt: EngineReadiness;
      tts: EngineReadiness;
      voices: VoiceInfo[];
    }
  | {
      ok: false;
      code: "offline" | "unauthorized" | "incompatible";
      detail: string;
    };

export type VoiceFailure = {
  ok: false;
  code: string;
  detail: string;
};

export type VoiceTextResult =
  { ok: true; text: string; language: string } | VoiceFailure;

export type VoiceAudioResult = { ok: true; audio: Uint8Array } | VoiceFailure;

export type VoiceSynthInput = {
  text: string;
  voiceId?: string;
};

const voiceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);

export const voiceTranscribeSchema = z
  .object({
    audio: z
      .instanceof(Uint8Array)
      .refine(
        (value) =>
          value.byteLength > 0 && value.byteLength <= MAX_VOICE_AUDIO_BYTES,
        "Audio must be 1 byte to 8 MB.",
      ),
    language: z.enum(["en", "es"]).optional(),
  })
  .strict();

export const voiceSynthesizeSchema = z
  .object({
    text: z.string().min(1).max(MAX_VOICE_TEXT_CHARS),
    voiceId: voiceIdSchema.optional(),
  })
  .strict();

export function parseVoiceBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Voice URL is invalid.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Voice URL must be http://127.0.0.1:<port>.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Voice URL must be an origin only.");
  }
  return url.origin;
}
