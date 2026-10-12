import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";

vi.mock("./ollama", () => ({
  completeOllamaChat: vi.fn(),
}));

import { completeOllamaChat } from "./ollama";
import { chatPlaceholderTitle } from "../../shared/thread-title";
import { generateThreadTitle } from "./thread-title";

const completeOllamaChatMock = vi.mocked(completeOllamaChat);

describe("generateThreadTitle", () => {
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
