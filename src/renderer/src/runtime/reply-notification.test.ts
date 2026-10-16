import { afterEach, describe, expect, it, vi } from "vitest";
import { playReplyNotification } from "./reply-notification";

afterEach(() => vi.unstubAllGlobals());

describe("reply notification sound", () => {
  it("plays a quiet 180 ms tone with soft edges and releases the audio device", async () => {
    const tone = {
      type: "",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: undefined as (() => void) | undefined,
    };
    const volume = {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 1;
        destination = {};
        resume = async (): Promise<void> => {};
        createOscillator = (): typeof tone => tone;
        createGain = (): typeof volume => volume;
        close = close;
      },
    );
    await playReplyNotification();
    expect(tone.type).toBe("sine");
    expect(tone.frequency.setValueAtTime).toHaveBeenCalledWith(660, 1);
    expect(volume.gain.linearRampToValueAtTime.mock.calls).toEqual([
      [0.025, 1.015],
      [0, 1.18],
    ]);
    expect(tone.stop).toHaveBeenCalledWith(1.18);
    expect(tone.connect).toHaveBeenCalledWith(volume);
    tone.onended?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("tolerates an unavailable audio device", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("No audio device");
        }
      },
    );
    await expect(playReplyNotification()).resolves.toBeUndefined();
  });

  it("closes the context when playback cannot start", async () => {
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        resume = async (): Promise<void> => {
          throw new Error("Playback unavailable");
        };
        close = close;
      },
    );
    await expect(playReplyNotification()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
