import { describe, expect, it } from "vitest";
import { allowsMicrophoneCheck, allowsMicrophoneRequest } from "./microphone";

describe("microphone permission", () => {
  it("allows audio only", () => {
    expect(allowsMicrophoneRequest("media", ["audio"])).toBe(true);
    expect(allowsMicrophoneRequest("media", ["audio", "video"])).toBe(false);
    expect(allowsMicrophoneRequest("media", [])).toBe(false);
    expect(allowsMicrophoneRequest("display-capture", ["audio"])).toBe(false);
    expect(allowsMicrophoneCheck("media", "audio")).toBe(true);
    expect(allowsMicrophoneCheck("media", "video")).toBe(false);
    expect(allowsMicrophoneCheck("media", "unknown")).toBe(false);
    expect(allowsMicrophoneCheck("geolocation", "audio")).toBe(false);
  });
});
