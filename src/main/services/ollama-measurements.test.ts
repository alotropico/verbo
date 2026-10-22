import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import {
  createInferenceMeasurements,
  inferenceMeasurements,
} from "../runtime/prompt-eval";
import { ollamaRequestGate } from "../runtime/ollama-gate";
import { streamOllamaTurn, ollamaChatBody } from "./ollama-turn-stream";
import { generateThreadTitle } from "./thread-title";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Ollama payloads and completion measurements", () => {
  it("captures actual title/foreground payloads from a frozen snapshot through the background gate", async () => {
    const payloads: ReturnType<typeof ollamaChatBody>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        payloads.push(JSON.parse(init.body));
        return Response.json({
          done: true,
          model: "actual",
          prompt_eval_count: 33,
          message: { content: "Short title" },
        });
      }),
    );
    let release!: () => void;
    const blocking = ollamaRequestGate.schedule(
      0,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const settings = { ...DEFAULT_CHAT_SETTINGS, numCtx: 12288 };
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const expected = ollamaChatBody([], settings);
    const pending = generateThreadTitle(
      "payload-chat",
      [{ role: "user", content: "one input" }],
      settings,
    );
    const queued = inferenceMeasurements.list().at(-1)!;
    expect(queued).toMatchObject({
      status: "queued",
      agentId: "title",
      work: "background",
    });
    expect(payloads).toHaveLength(0);
    expect(timeout).not.toHaveBeenCalled();
    settings.numCtx = 4096;
    release();
    await blocking;
    await expect(pending).resolves.toBe("Short title");
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(payloads[0]).toMatchObject({
      model: expected.model,
      keep_alive: expected.keep_alive,
      stream: false,
      think: false,
      options: { num_ctx: expected.options.num_ctx, temperature: 0.2 },
    });
    expect(inferenceMeasurements.list().at(-1)).toMatchObject({
      requestId: queued.requestId,
      status: "completed",
      model: "actual",
      promptTokens: 33,
    });
  });

  it.each([true, false])(
    "attributes final stream metrics when present: %s",
    async (metrics) => {
      const final = {
        done: true,
        model: "actual",
        ...(metrics
          ? { prompt_eval_count: 44, eval_count: 7, load_duration: 13 }
          : {}),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `${JSON.stringify({ message: { content: "reply" } })}\n${JSON.stringify(final)}\n`,
                    ),
                  );
                  controller.close();
                },
              }),
            ),
        ),
      );
      const store = createInferenceMeasurements();
      const record = store.begin({
        threadId: "a",
        invocationId: "one",
        agentId: "writer",
        model: "configured",
        numCtx: 8192,
        work: "foreground",
      });
      record.start();
      await streamOllamaTurn(
        [],
        DEFAULT_CHAT_SETTINGS,
        new AbortController().signal,
        () => undefined,
        { onCompletion: record.complete },
      );
      record.finish();
      expect(store.latest("a", "writer")).toMatchObject({
        status: "completed",
        model: "actual",
      });
      expect(store.latest("a", "writer")?.promptTokens).toBe(
        metrics ? 44 : undefined,
      );
    },
  );

  it("resets its inactivity deadline as chunks arrive and aborts when the stream stalls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(
                  enc.encode(`${JSON.stringify({ message: { content: "part1" } })}\n`),
                );
                await new Promise((r) => setTimeout(r, 25));
                controller.enqueue(
                  enc.encode(`${JSON.stringify({ message: { content: "part2" } })}\n`),
                );
                await new Promise((r) => setTimeout(r, 25));
                controller.enqueue(enc.encode(`${JSON.stringify({ done: true })}\n`));
                controller.close();
              },
            }),
          ),
      ),
    );
    let text = "";
    await expect(
      streamOllamaTurn(
        [],
        DEFAULT_CHAT_SETTINGS,
        new AbortController().signal,
        (snapshot) => {
          text = snapshot;
        },
        { deadlineMs: 40 },
      ),
    ).resolves.toBeDefined();
    expect(text).toBe("part1part2");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(
                  enc.encode(`${JSON.stringify({ message: { content: "part1" } })}\n`),
                );
                await new Promise((r) => setTimeout(r, 70));
                controller.enqueue(enc.encode(`${JSON.stringify({ done: true })}\n`));
                controller.close();
              },
            }),
          ),
      ),
    );
    await expect(
      streamOllamaTurn(
        [],
        DEFAULT_CHAT_SETTINGS,
        new AbortController().signal,
        () => undefined,
        { deadlineMs: 30 },
      ),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Ollama stream stalled.",
    });
  });
});
