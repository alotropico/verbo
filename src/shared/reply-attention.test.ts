import { describe, expect, it } from "vitest";
import type { ActionResult } from "./action-contract";
import type { ChatEvent, ChatTurnStop } from "./chat-ipc";
import { evaluateTrace } from "./execution-trace";
import { replyAttention } from "./reply-attention";

const end = (stop: ChatTurnStop = "completed"): ChatEvent[] => [{ type: "turn_status", stop }, { type: "done" }];
const result = (status: ActionResult["status"], id = "call"): ChatEvent => ({
  type: status === "requires_confirmation" ? "approval" : "tool_result",
  toolCallId: id,
  name: "actions.invoke",
  args: {},
  result: { action: "files.move", status, summary: status },
});
describe("taskbar reply outcome", () => {
  it("waits for a terminal response before showing success", () => {
    expect(replyAttention([{ type: "delta", text: "Working" }])).toBeUndefined();
    expect(replyAttention([{ type: "done" }])).toBeUndefined();
    expect(replyAttention(end())).toBe("success");
  });
  it.each(["failed", "cancelled"] as const)("uses red for %s", (stop) => {
    expect(replyAttention([result("requires_confirmation"), ...end(stop)])).toBe("error");
  });
  it.each(["limit", "capacity", "no_progress"] as const)("uses yellow for %s", (stop) => {
    expect(replyAttention(end(stop))).toBe("partial");
  });
  it("signals approval immediately and clears it when resolved", () => {
    expect(replyAttention([result("requires_confirmation")])).toBe("question");
    expect(replyAttention([result("requires_confirmation"), result("success")])).toBeUndefined();
    expect(replyAttention([result("requires_confirmation"), result("success"), ...end()])).toBe("success");
  });
  it("uses blue for a clarification even when transport completed", () => {
    expect(replyAttention([{ type: "input_required" }, ...end()])).toBe("question");
    expect(
      replyAttention([
        {
          type: "execution",
          execution: {
            id: "execution",
            workflowId: "commander",
            definitionVersion: 1,
            revision: 1,
            status: "awaiting_input",
            branchAnchorId: null,
            currentStepId: null,
          },
        },
        ...end(),
      ]),
    ).toBe("question");
  });
  it("uses the verified partial outcome rather than completed transport", () => {
    const trace = evaluateTrace({
      turnId: "turn",
      workflow: { executionId: "workflow", workflowId: "commander", status: "failed" },
      stages: [
        {
          id: "workflow",
          kind: "workflow",
          label: "Commands",
          order: 0,
          state: "failed",
          workflowId: "commander",
          executionId: "workflow",
        },
      ],
      calls: [
        {
          id: "call",
          parentId: "workflow",
          toolName: "actions.invoke",
          order: 1,
          result: { action: "files.move", status: "partial", summary: "Some files moved" },
        },
      ],
      clock: { stop: "completed", resultReadyAt: 1 },
    });
    expect(replyAttention([{ type: "execution_trace", trace }, ...end()])).toBe("partial");
  });
  it("uses red for failed workflows whose readable reply completed", () => {
    expect(
      replyAttention([
        {
          type: "execution",
          execution: {
            id: "execution",
            workflowId: "commander",
            definitionVersion: 1,
            revision: 1,
            status: "failed",
            branchAnchorId: null,
            currentStepId: null,
          },
        },
        ...end(),
      ]),
    ).toBe("error");
  });
  it("distinguishes mixed work from total command failure", () => {
    expect(replyAttention([result("success", "one"), result("error", "two"), ...end()])).toBe("partial");
    expect(replyAttention([result("error"), ...end()])).toBe("error");
    expect(replyAttention([result("partial"), ...end()])).toBe("partial");
  });
  it("reports saving failures immediately and permits a successful save retry", () => {
    const identity = { turnId: "turn", threadId: "chat", assistantMessageId: "reply" };
    const failed: ChatEvent = { type: "finalization", ...identity, state: "failed" };
    expect(replyAttention([failed])).toBe("error");
    expect(replyAttention([failed, { type: "finalization", ...identity, state: "saved" }, ...end()])).toBe("success");
  });
});
