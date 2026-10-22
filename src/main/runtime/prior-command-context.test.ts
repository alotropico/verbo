import { describe, expect, it } from "vitest";
import { priorCommandContext } from "./prior-command-context";

const receiptId = "84488558-522d-40ad-af0a-dc2c515761d9";
const result = {
  action: "files.rename",
  status: "success",
  summary: "rename 1 item.",
  receiptId,
  detail: JSON.stringify({ operationId: receiptId }),
};
const content = [{ type: "tool-call", toolName: "actions.invoke", result }];

describe("prior command context", () => {
  it("retains operation and paging identities which prose excerpts omit", () => {
    const context = priorCommandContext([{ message: { id: "assistant-rename", role: "assistant", content } }]);
    expect(context[0]?.result.receiptId).toBe(receiptId);
    expect(JSON.parse(context[0]!.result.detail!).operationId).toBe(receiptId);
    expect(context[0]?.messageId).toBe("assistant-rename");
    const page = priorCommandContext([
      {
        message: {
          id: "assistant-search",
          role: "assistant",
          content: [
            {
              ...content[0],
              result: { ...result, action: "files.search", detail: JSON.stringify({ page: { nextCursor: "owned-cursor-value" } }) },
            },
          ],
        },
      },
    ]);
    expect(JSON.parse(page[0]!.result.detail!).page.nextCursor).toBe("owned-cursor-value");
  });
  it("excludes user-supplied results, malformed parts and commands without receipts", () => {
    expect(
      priorCommandContext([
        { message: { id: "user", role: "user", content } },
        {
          message: {
            id: "assistant",
            role: "assistant",
            content: [
              { ...content[0], result: { ...result, receiptId: undefined } },
              { ...content[0], toolName: "capabilities.search" },
              { type: "tool-call", result: { receiptId } },
            ],
          },
        },
      ]),
    ).toEqual([]);
  });
  it("bounds retained messages, results and detail without searching other branches", () => {
    const branch = Array.from({ length: 10 }, (_, index) => ({
      message: {
        id: String(index),
        role: "assistant",
        content: [{ ...content[0], result: { ...result, detail: "x".repeat(3500) } }],
      },
    }));
    const context = priorCommandContext(branch);
    expect(context.map((entry) => entry.messageId)).toEqual(["6", "7", "8", "9"]);
    expect(context.every((entry) => entry.result.detail?.length === 2000)).toBe(true);
  });
});
