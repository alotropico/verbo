import { describe, expect, it } from "vitest";
import {
  parseVoiceBaseUrl,
  voiceSynthesizeSchema,
  voiceTranscribeSchema,
} from "./voice";

describe("voice contracts", () => {
  it("keeps the service origin on 127.0.0.1", () => {
    expect(parseVoiceBaseUrl("http://127.0.0.1:8765")).toBe(
      "http://127.0.0.1:8765",
    );
    expect(() => parseVoiceBaseUrl("http://localhost:8765")).toThrow(
      /127\.0\.0\.1/,
    );
    expect(() => parseVoiceBaseUrl("https://127.0.0.1:8765")).toThrow(
      /127\.0\.0\.1/,
    );
  });

  it("rejects a caller filesystem path", () => {
    expect(
      voiceSynthesizeSchema.safeParse({
        text: "Hello",
        path: "C:\\Windows\\System32",
      }).success,
    ).toBe(false);
    expect(
      voiceTranscribeSchema.safeParse({
        path: "C:\\secret.wav",
        audio: Uint8Array.from([1]),
      }).success,
    ).toBe(false);
    expect(
      voiceTranscribeSchema.safeParse({ audio: Uint8Array.from([1, 2]) })
        .success,
    ).toBe(true);
  });
});
