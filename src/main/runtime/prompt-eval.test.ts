import { describe, expect, it, vi } from "vitest";
import {
  createInferenceMeasurements,
  inferenceMeasurements,
} from "./prompt-eval";
import { createRequestGate } from "./request-gate";
import { runTurn } from "./turn";
import { createRegistry } from "../capabilities/registry";
import type { InferenceSource } from "../../shared/inference-metrics";

const source: InferenceSource = {
  threadId: "a",
  turnId: "turn-a",
  invocationId: "invoke-a",
  agentId: "conversational",
  work: "foreground",
  model: "configured",
  numCtx: 8192,
};

describe("invocation measurements", () => {
  it("isolates chats, routing and late titles, preserving actual model and units", () => {
    const store = createInferenceMeasurements();
    const a = store.begin(source);
    a.start();
    a.complete({
      done: true,
      model: "actual",
      prompt_eval_count: 123,
      eval_count: 9,
      load_duration: 10,
      prompt_eval_duration: 20,
      eval_duration: 30,
      total_duration: 60,
    });
    a.finish();
    const b = store.begin({
      ...source,
      threadId: "b",
      invocationId: "invoke-b",
    });
    b.start();
    b.complete({ done: true, prompt_eval_count: 456 });
    b.finish();
    const routing = store.begin({ ...source, agentId: "decision" });
    routing.start();
    routing.complete({ done: true, prompt_eval_count: 12 });
    routing.finish();
    const title = store.begin({
      ...source,
      agentId: "title",
      work: "background",
    });
    title.start();
    title.complete({ done: true, prompt_eval_count: 42 });
    title.finish();
    expect(store.latest("a", "conversational")).toMatchObject({
      ...source,
      model: "actual",
      status: "completed",
      promptTokens: 123,
      generatedTokens: 9,
      loadDurationNs: 10,
      promptEvalDurationNs: 20,
      evalDurationNs: 30,
      totalDurationNs: 60,
    });
    expect(store.latest("b", "conversational")?.promptTokens).toBe(456);
    expect(store.latest("a", "decision")?.promptTokens).toBe(12);
    expect(store.latest(undefined, "conversational")).toBeNull();
  });

  it("selects the latest submitted call even when an earlier request finishes late", () => {
    const store = createInferenceMeasurements();
    const old = store.begin(source);
    const current = store.begin({ ...source, invocationId: "new" });
    current.start();
    current.complete({ done: true });
    current.finish();
    old.start();
    old.complete({ done: true, prompt_eval_count: 100 });
    old.finish();
    expect(store.latest("a", "conversational")).toMatchObject({
      invocationId: "new",
      status: "completed",
    });
    expect(store.latest("a", "conversational")?.promptTokens).toBeUndefined();
  });

  it("retains cancellation, failures, missing statistics and bounded retention", () => {
    const store = createInferenceMeasurements(3);
    store.begin(source).finish();
    store.begin(source).finish(new Error("failed"));
    store.begin(source).finish(undefined, true);
    expect(store.list().map((record) => record.status)).toEqual([
      "incomplete",
      "failed",
      "cancelled",
    ]);
    store.begin(source).finish();
    expect(store.list()).toHaveLength(3);
    expect(store.latest("a", "conversational")?.promptTokens).toBeUndefined();
  });

  it("measures queue wait separately and records gate cancellation without executing", async () => {
    const gate = createRequestGate();
    let release!: () => void;
    const blocker = gate.schedule(
      0,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const signal = new AbortController();
    const model = vi.fn(async () => []);
    const pending = runTurn({
      userText: "hello",
      history: [],
      numCtx: 8192,
      instructions: "reply",
      context: { actor: "model", threadId: "queued" },
      registry: createRegistry([]),
      gate,
      signal: signal.signal,
      model,
      inferenceSource: { ...source, threadId: "queued" },
    });
    signal.abort();
    expect((await pending).stop).toBe("cancelled");
    expect(model).not.toHaveBeenCalled();
    expect(
      inferenceMeasurements.latest("queued", "conversational"),
    ).toMatchObject({ status: "cancelled" });
    release();
    await blocker;
    await runTurn({
      userText: "hello",
      history: [],
      numCtx: 8192,
      instructions: "reply",
      context: { actor: "model", threadId: "timed" },
      registry: createRegistry([]),
      gate,
      inferenceSource: { ...source, threadId: "timed" },
      model: async (_messages, hooks) => {
        const chunk = {
          done: true,
          prompt_eval_count: 15,
          message: { content: "hello" },
        };
        hooks.onCompletion?.(chunk);
        return [chunk];
      },
    });
    expect(
      inferenceMeasurements.latest("timed", "conversational"),
    ).toMatchObject({
      status: "completed",
      promptTokens: 15,
      queueWaitMs: expect.any(Number),
      wallTimeMs: expect.any(Number),
    });
  });
});
