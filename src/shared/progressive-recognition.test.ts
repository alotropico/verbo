import { describe, expect, it } from "vitest";
import { ProgressiveRecognition } from "./progressive-recognition";
import { silenceSendDecision } from "./voice-draft";
import type { VoiceTextResult } from "./voice";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
const snapshot = (
  sequence: number,
  final = false,
): { id: string; sequence: number; final: boolean; audio: Uint8Array } => ({
  id: "utterance",
  sequence,
  final,
  audio: new Uint8Array([sequence]),
});

describe("progressive speech recognition", () => {
  it("settles discarded audio and updates pending state when its final snapshot arrives", () => {
    const settled: string[] = [];
    const pending: boolean[] = [];
    const recognition = new ProgressiveRecognition({
      transcribe: async () => {
        throw new Error("Discarded audio must not be decoded.");
      },
      preview: () => {},
      commit: async () => {},
      error: () => {},
      pending: (value) => {
        pending.push(value);
      },
      settled: (id) => {
        settled.push(id);
      },
    });
    recognition.enqueue({ ...snapshot(1), audio: new Uint8Array() });
    recognition.enqueue(snapshot(2, true));
    expect(settled).toEqual(["utterance"]);
    expect(pending.at(-1)).toBe(false);
    expect(recognition.pending).toBe(false);
  });
  it("replaces provisional text, coalesces pending prefixes and commits only the final once", async () => {
    const first = deferred<VoiceTextResult>();
    const visited: number[] = [];
    const previews: string[] = [];
    const committed: string[] = [];
    const recognition = new ProgressiveRecognition({
      transcribe: async (audio) => {
        visited.push(audio[0]!);
        return audio[0] === 1
          ? first.promise
          : { ok: true, text: `text ${audio[0]}`, language: "en" };
      },
      preview: (_id, text) => {
        previews.push(text);
      },
      commit: async (_id, text) => {
        committed.push(text);
      },
      error: () => {},
      pending: () => {},
    });
    recognition.enqueue(snapshot(1));
    recognition.enqueue(snapshot(2));
    recognition.enqueue(snapshot(3));
    expect(visited).toEqual([1]);
    expect(recognition.pending).toBe(true);
    first.resolve({ ok: true, text: "provisional", language: "en" });
    await settle();
    expect(visited).toEqual([1, 3]);
    expect(previews).toEqual(["provisional", "text 3"]);
    expect(committed).toEqual([]);
    recognition.enqueue(snapshot(4, true));
    await settle();
    recognition.enqueue(snapshot(5, true));
    await settle();
    expect(committed).toEqual(["text 4"]);
    expect(recognition.pending).toBe(false);
  });
  it("stop, thread changes and discarded blips invalidate late results", async () => {
    for (const mode of ["stop", "discard"] as const) {
      const waiting = deferred<VoiceTextResult>();
      const committed: string[] = [];
      const previews: string[] = [];
      const recognition = new ProgressiveRecognition({
        transcribe: () => waiting.promise,
        preview: (_id, text) => previews.push(text),
        commit: async (_id, text) => {
          committed.push(text);
        },
        error: () => {},
        pending: () => {},
      });
      recognition.enqueue(snapshot(1, true));
      if (mode === "stop") recognition.stop();
      else recognition.discard("utterance");
      waiting.resolve({ ok: true, text: "late text", language: "en" });
      await settle();
      expect(previews).toEqual([]);
      expect(committed).toEqual([]);
      expect(recognition.pending).toBe(false);
    }
  });
  it("allows a final after an incomplete prefix fails, and settles a blank final without sending its preview", async () => {
    const commits: string[] = [];
    const errors: string[] = [];
    const settled: string[] = [];
    const recognition = new ProgressiveRecognition({
      transcribe: async (audio) =>
        audio[0] === 1
          ? { ok: false, code: "decode", detail: "Incomplete prefix" }
          : { ok: true, text: "", language: "en" },
      preview: () => {},
      commit: async (_id, text) => {
        commits.push(text);
      },
      error: (text) => errors.push(text),
      pending: () => {},
      settled: (id) => settled.push(id),
    });
    recognition.enqueue(snapshot(1));
    await settle();
    recognition.enqueue(snapshot(2, true));
    await settle();
    expect(errors).toEqual([]);
    expect(commits).toEqual([]);
    expect(settled).toEqual(["utterance"]);
    expect(recognition.pending).toBe(false);
  });
  it("holds silence submission during recognition, speech, queue holds and editing", () => {
    const ready = {
      quietForMs: 30_000,
      editing: false,
      modelRunning: false,
      hasDraft: true,
    };
    expect(silenceSendDecision(ready)).toBe("send");
    for (const gate of [
      "recognitionPending",
      "hearing",
      "queueHeld",
      "editing",
    ] as const)
      expect(silenceSendDecision({ ...ready, [gate]: true })).toBe("hold");
  });
});
