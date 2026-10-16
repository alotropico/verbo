import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";

vi.mock("./ollama", () => ({
  completeOllamaChat: vi.fn(),
}));

import { completeOllamaChat } from "./ollama";
import { chatPlaceholderTitle } from "../../shared/thread-title";
import { generateThreadTitle } from "./thread-title";
import { ollamaChatBody } from "./ollama-turn-stream";
import { ollamaOptions } from "./ollama-options";

const completeOllamaChatMock = vi.mocked(completeOllamaChat);

describe("generateThreadTitle", () => {
  it.each([8192, 12288])(
    "uses the foreground context capacity %i with isolated short-title input",
    async (numCtx) => {
      completeOllamaChatMock.mockResolvedValue(
        "A short title with extra words",
      );
      const configured = { ...DEFAULT_CHAT_SETTINGS, numCtx };
      const title = await generateThreadTitle(
        "thread",
        [
          { role: "user", content: "first request" },
          { role: "assistant", content: "private assistant message" },
          { role: "user", content: "later request" },
        ],
        configured,
      );
      const [messages, settings] = completeOllamaChatMock.mock.calls[0]!;
      expect(ollamaOptions(settings).num_ctx).toBe(
        ollamaChatBody([], configured).options.num_ctx,
      );
      expect(settings).toMatchObject({
        model: configured.model,
        keepAlive: configured.keepAlive,
        temperature: 0.2,
        think: false,
      });
      expect(messages).toHaveLength(2);
      expect(messages[1]?.content).toBe("first request");
      expect(title.split(" ").length).toBeLessThanOrEqual(3);
      expect(title.length).toBeLessThanOrEqual(24);
      expect(configured.think).toBe(DEFAULT_CHAT_SETTINGS.think);
    },
  );
  beforeEach(() => {
    completeOllamaChatMock.mockReset();
  });

  it("asks Ollama with a hidden system prompt and uses the suggestion", async () => {
    completeOllamaChatMock.mockResolvedValue('" Weekend trip "');
    await expect(
      generateThreadTitle(
        "__LOCALID_abc",
        [{ role: "user", content: "Plan a trip to Lisbon" }],
        DEFAULT_CHAT_SETTINGS,
      ),
    ).resolves.toBe("Weekend trip");
    expect(completeOllamaChatMock).toHaveBeenCalledOnce();
    const [messages, settings] = completeOllamaChatMock.mock.calls[0]!;
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({
      role: "user",
      content: "Plan a trip to Lisbon",
    });
    expect(settings.think).toBe(false);
  });

  it("keeps the id mark when the model returns nothing", async () => {
    completeOllamaChatMock.mockResolvedValue("   ");
    await expect(
      generateThreadTitle(
        "__LOCALID_abc",
        [{ role: "user", content: "Hi" }],
        DEFAULT_CHAT_SETTINGS,
      ),
    ).resolves.toBe(chatPlaceholderTitle("__LOCALID_abc"));
  });
});
