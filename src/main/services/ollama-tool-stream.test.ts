import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateOllamaToolStream } from "./ollama-tool-stream";

const sample = JSON.parse(
  readFileSync(
    new URL("./fixtures/ollama-qwen-tool-stream.json", import.meta.url),
    "utf8",
  ),
) as {
  listCall: unknown[];
  multiCall: unknown[];
  thinkingFragments: unknown[];
  followUp: { observedReply: string };
};

describe("Ollama 0.40.2 Qwen tool streams", () => {
  it("aggregates a complete tool call and the done metadata", () => {
    const aggregated = aggregateOllamaToolStream(sample.listCall);
    expect(aggregated.toolCalls).toEqual([
      {
        index: 0,
        id: "call_y5qvu2kx",
        name: "capabilities.list",
        arguments: { path: "files" },
      },
    ]);
    expect(aggregated.done).toBe(true);
    expect(aggregated.promptEvalCount).toBe(344);
    expect(aggregated.evalCount).toBe(26);
    expect(aggregated.doneReason).toBe("stop");
  });

  it("keeps multi-call order by function index", () => {
    const aggregated = aggregateOllamaToolStream(sample.multiCall);
    expect(aggregated.toolCalls.map((call) => call.name)).toEqual([
      "capabilities.list",
      "capabilities.describe",
    ]);
    expect(aggregated.toolCalls.map((call) => call.index)).toEqual([0, 1]);
  });

  it("concatenates thinking separately from content and joins split argument strings", () => {
    const thinking = aggregateOllamaToolStream(sample.thinkingFragments);
    expect(thinking.thinking).toBe("Thinking Process");
    expect(thinking.content).toBe("");

    const split = aggregateOllamaToolStream([
      {
        message: {
          content: "Hel",
          tool_calls: [
            {
              id: "call_split",
              function: {
                index: 0,
                name: "capabilities.list",
                arguments: '{"pa',
              },
            },
          ],
        },
      },
      { parseError: true, raw: "{" },
      {
        message: {
          content: "lo",
          tool_calls: [{ function: { index: 0, arguments: 'th":"files"}' } }],
        },
      },
    ]);
    expect(split.content).toBe("Hello");
    expect(split.malformed).toBe(1);
    expect(split.toolCalls[0]?.arguments).toEqual({ path: "files" });
    expect(sample.followUp.observedReply).toContain("files.list");
  });
});
