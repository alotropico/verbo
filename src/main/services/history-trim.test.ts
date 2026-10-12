import { describe, expect, it } from "vitest";
import { trimMessagesForContext } from "./history-trim";

describe("trimMessagesForContext", () => {
  it("keeps recent messages within budget", () => {
    const messages = [
      { role: "user" as const, content: "a".repeat(400) },
      { role: "assistant" as const, content: "b".repeat(400) },
      { role: "user" as const, content: "latest" },
    ];
    const { messages: kept, removedCount } = trimMessagesForContext(
      messages,
      120,
    );
    expect(removedCount).toBeGreaterThan(0);
    expect(kept.at(-1)?.content).toBe("latest");
  });
});
