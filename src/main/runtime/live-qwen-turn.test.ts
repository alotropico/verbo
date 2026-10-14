import { platform } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import { fetchOllamaStatus } from "../services/ollama";
import { streamOllamaTurn } from "../services/ollama-turn-stream";
import { toOllamaMessages } from "./ollama-wire";
import { createRequestGate } from "./request-gate";
import { runTurn } from "./turn";
import { createModuleRegistry } from "../capabilities/modules";
import { webBindings, webModule } from "../capabilities/web";
import { StdioBrowserClient } from "../web/browser-client";
import { DEFAULT_WEB_SETTINGS } from "../../shared/web-contracts";

const live = process.env.VERBO_LIVE_OLLAMA === "1";

describe.skipIf(!live)("live Qwen tool turn", () => {
  it.skipIf(process.env.VERBO_LIVE_WEB !== "1")(
    "continues once from the actual browser search terminal receipt",
    async () => {
      const browser = new StdioBrowserClient(
        DEFAULT_WEB_SETTINGS,
        resolve("out/main/browser-runtime.js"),
      );
      const registry = createModuleRegistry([webModule], {
        handlers: webBindings(undefined, browser),
        processes: {},
        aggregators: {},
      });
      const events: string[] = [];
      try {
        const page = await browser.readRenderedPage(
          "https://example.com/",
          1000,
          AbortSignal.timeout(15000),
        );
        expect(page.title).toBe("Example Domain");
        expect(page.text.trim()).not.toBe("");
        const outcome = await runTurn({
          userText:
            'Call actions.invoke exactly once with {"name":"web.search","args":{"query":"TypeScript official documentation","limit":2}}. Do not retry or call another command. After the terminal receipt, explain its actual status. If it failed, say the search failed; do not invent results.',
          history: [],
          numCtx: 8192,
          registry,
          context: { actor: "model", threadId: "live-web-thread" },
          gate: createRequestGate(),
          onUpdate: (update) => {
            events.push(update.type);
          },
          model: (messages, hooks) =>
            streamOllamaTurn(
              toOllamaMessages(messages),
              { ...DEFAULT_CHAT_SETTINGS, think: false, temperature: 0.2 },
              hooks.signal ?? AbortSignal.timeout(120000),
              hooks.onText,
            ),
        });
        expect(outcome.stop).toBe("completed");
        const searches = outcome.results.filter(
          (result) => result.action === "web.search",
        );
        expect(searches).toHaveLength(1);
        expect(["success", "error"]).toContain(searches[0]!.status);
        expect(searches[0]!.data).toHaveProperty("attempts");
        expect(outcome.content.trim()).not.toBe("");
        const terminal = events.indexOf("tool_result");
        expect(terminal).toBeGreaterThanOrEqual(0);
        expect(events.indexOf("text")).toBeGreaterThan(terminal);
        if (searches[0]!.status === "error")
          expect(outcome.content.toLowerCase()).toMatch(
            /fail|unable|unavailable|blocked|could not/,
          );
        console.info(
          "Live browser receipt",
          JSON.stringify({
            status: searches[0]!.status,
            code: searches[0]!.code,
            events,
          }),
        );
      } finally {
        await browser.close();
      }
    },
    180000,
  );
  it("discovers, describes, and invokes environment.platform", async () => {
    const status = await fetchOllamaStatus(3000);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.models).toContain(DEFAULT_CHAT_SETTINGS.model);

    const outcome = await runTurn({
      userText:
        'Use the registered tools. Call capabilities.list with {"path":"environment"}. Then capabilities.describe with {"ids":["environment.platform"]}. Then actions.invoke with {"name":"environment.platform","args":{}}. Reply with the platform from the invoke result.',
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
