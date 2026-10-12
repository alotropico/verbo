import { describe, expect, it } from "vitest";
import {
  assistantPlainText,
  joinSpeech,
  silenceSendDecision,
  speechChunks,
  spokenText,
  voiceStatusLine,
} from "./voice-draft";
import { idleLevelClock, signalRms, stepLevel } from "./voice-audio";

describe("voice draft policy", () => {
  it("joins speech and splits playback without dropping the tail marker", () => {
    expect(joinSpeech(" alpha ", "beta")).toBe("alpha beta");
    const chunks = speechChunks(`${"word ".repeat(900)}END`, 2_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(chunks[0]?.length).toBeLessThanOrEqual(2_000);
  });

  it("names listening, pause, and a kept draft", () => {
    expect(
      voiceStatusLine({
        active: true,
        capture: "listening",
        paused: false,
        speaking: false,
        error: null,
        hasDraft: false,
        modelRunning: true,
      }),
    ).toBe("Listening. Model working.");
    expect(
      voiceStatusLine({
        active: true,
        capture: "listening",
        paused: true,
        speaking: true,
        error: null,
        hasDraft: false,
        modelRunning: false,
      }),
    ).toBe("Speaking. Microphone paused.");
    expect(
      voiceStatusLine({
        active: false,
        capture: "idle",
        paused: true,
        speaking: true,
        error: null,
        hasDraft: false,
        modelRunning: true,
      }),
    ).toBe("Speaking.");
    expect(
      voiceStatusLine({
        active: false,
        capture: "idle",
        paused: false,
        speaking: false,
        error: null,
        hasDraft: true,
        modelRunning: false,
      }),
    ).toBe("Voice draft kept.");
    expect(
      assistantPlainText({
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "reasoning", text: "hidden" },
        ],
      }),
    ).toBe("Hello");
  });

  it("sends a quiet draft only when the model is idle", () => {
    expect(
      silenceSendDecision({
        quietForMs: 400,
        editing: false,
        modelRunning: false,
        hasDraft: true,
      }),
    ).toBe("wait");
    expect(
      silenceSendDecision({
        quietForMs: 1_000,
        editing: false,
        modelRunning: true,
        hasDraft: true,
      }),
    ).toBe("hold");
    expect(
      silenceSendDecision({
        quietForMs: 1_000,
        editing: true,
        modelRunning: false,
        hasDraft: true,
      }),
    ).toBe("hold");
    expect(
      silenceSendDecision({
        quietForMs: null,
        editing: false,
        modelRunning: false,
        hasDraft: true,
      }),
    ).toBe("hold");
    expect(
      silenceSendDecision({
        quietForMs: 1_000,
        editing: false,
        modelRunning: false,
        hasDraft: true,
      }),
    ).toBe("send");
    expect(
      silenceSendDecision({
        quietForMs: 400,
        editing: false,
        modelRunning: false,
        hasDraft: true,
        silenceSendMs: 400,
      }),
    ).toBe("send");
    expect(speechChunks("one two three", 2_000, 1)).toEqual(["one two three."]);
    expect(
      spokenText("**Hello** 😀\n- first item\n1. second, still here."),
    ).toBe("Hello.\nfirst item.\nsecond, still here.");
  });
});

describe("voice capture clock", () => {
  it("emits after silence, discards a blip, and discards audio when paused", () => {
    let clock = idleLevelClock();
    const started = stepLevel(clock, {
      rms: 0.05,
      deltaMs: 100,
      paused: false,
    });
    expect(started.start).toBe(true);
    clock = started.clock;
    const held = stepLevel(clock, { rms: 0.05, deltaMs: 400, paused: false });
    clock = held.clock;
    const emitted = stepLevel(clock, { rms: 0, deltaMs: 700, paused: false });
    expect(emitted.finish).toBe("emit");

    const blip = stepLevel(idleLevelClock(), {
      rms: 0.05,
      deltaMs: 50,
      paused: false,
    });
    expect(
      stepLevel(blip.clock, { rms: 0, deltaMs: 700, paused: false }).finish,
    ).toBe("discard");

    const speaking = stepLevel(idleLevelClock(), {
      rms: 0.05,
      deltaMs: 200,
      paused: false,
    });
    expect(
      stepLevel(speaking.clock, { rms: 0.05, deltaMs: 10, paused: true })
        .finish,
    ).toBe("discard");
    expect(signalRms(new Float32Array([0, 0.5, 0]))).toBeGreaterThan(0);

    const quietRoom = stepLevel(
      idleLevelClock(),
      { rms: 0.03, deltaMs: 100, paused: false },
      {
        speechRms: 0.05,
        silenceHoldMs: 700,
        minSpeechMs: 300,
        maxSegmentMs: 20_000,
      },
    );
    expect(quietRoom.start).toBe(false);
  });
});
