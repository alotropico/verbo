import { describe, expect, it } from "vitest";
import { buildTurnContext, type ContextMessage } from "./context-builder";
import { toOllamaMessages } from "./ollama-wire";

describe("history-aware reference assembly", () => {
  const history: ContextMessage[] = [
    { messageId: "old", role: "user", content: "x".repeat(1000) },
    { messageId: "one", role: "user", content: "identical text" },
    { messageId: "two", role: "assistant", content: "identical text" },
  ];
  const refs = history.map((message) => ({
    messageId: message.messageId,
    excerpt: message.content.slice(0, 20),
  }));
  const renderUserText = (kept: readonly ContextMessage[]): string =>
    JSON.stringify({
      request: "current request",
      attachments: ["attachment"],
      explicitReferences: ["identical text"],
      contentRefs: refs.filter(
        (ref) => !kept.some((message) => message.messageId === ref.messageId),
      ),
    });

  it.each([8192, 460, 300])(
    "deduplicates by final history identity with a %i context",
    (numCtx) => {
      const built = buildTurnContext({
        history,
        renderUserText,
        userText: "",
        instructions: "reply",
        numCtx,
        toolEvents: [],
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const retained = built.messages.slice(1, -1);
      const request = JSON.parse(built.messages.at(-1)!.content);
      for (const ref of refs)
        expect(
          request.contentRefs.some(
            (item: typeof ref) => item.messageId === ref.messageId,
          ),
        ).toBe(
          !retained.some((message) => message.messageId === ref.messageId),
        );
      expect(
        retained.filter((message) => message.content === "identical text"),
      ).toHaveLength(2);
      expect(request.attachments).toEqual(["attachment"]);
      expect(request.explicitReferences).toEqual(["identical text"]);
      expect(request.request).toBe("current request");
      expect(JSON.stringify(toOllamaMessages(built.messages))).not.toContain(
        '"messageId":"one"',
      );
      expect(built.removedCount).toBe(numCtx === 300 ? 1 : 0);
    },
  );

  it("keeps specialized excerpts with empty history", () => {
    const built = buildTurnContext({
      history: [],
      renderUserText,
      userText: "",
      instructions: "write",
      numCtx: 8192,
      toolEvents: [],
    });
    expect(built.ok).toBe(true);
    if (built.ok)
      expect(JSON.parse(built.messages.at(-1)!.content).contentRefs).toEqual(
        refs,
      );
  });
});
