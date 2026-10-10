import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import { fetchOllamaStatus } from "../services/ollama";
import { streamOllamaTurn } from "../services/ollama-turn-stream";
import { toOllamaMessages } from "./ollama-wire";
import { createRequestGate } from "./request-gate";
import { runTurn } from "./turn";

const live = process.env.VERBO_LIVE_OLLAMA === "1";

describe.skipIf(!live)("live Qwen tool turn", () => {
  it("discovers, describes, and invokes environment.platform", async () => {
    const status = await fetchOllamaStatus(3000);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.models).toContain(DEFAULT_CHAT_SETTINGS.model);

    const outcome = await runTurn({
      userText:
        'Use only the three tools. Call capabilities.list with {"path":"environment"}. Then capabilities.describe with {"ids":["environment.platform"]}. Then actions.invoke with {"name":"environment.platform","args":{}}. Reply with the platform from the invoke result.',
      history: [],
      numCtx: 8192,
      context: { actor: "model", threadId: "live-thread" },
      gate: createRequestGate(),
      model: (messages, hooks) =>
        streamOllamaTurn(
          toOllamaMessages(messages),
          { ...DEFAULT_CHAT_SETTINGS, think: false, temperature: 0.2 },
          hooks.signal ?? AbortSignal.timeout(120_000),
          hooks.onText,
        ),
    });

    expect(outcome.stop).toBe("completed");
    expect(outcome.results.map((result) => result.action)).toEqual([
      "capabilities.list",
      "capabilities.describe",
      "environment.platform",
    ]);
    expect(outcome.results[2]?.status).toBe("success");
    expect(outcome.results[2]?.detail).toContain(`"platform":"${platform()}"`);
    expect(outcome.content.toLowerCase()).toContain(platform());
  }, 180_000);
});
