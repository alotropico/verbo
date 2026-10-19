import { describe, expect, it } from "vitest";
import type { ActionResult } from "./action-contract";
import {
  emptyChatProjection,
  projectChatEvent,
  visibleProjection,
  type ProjectedPart,
} from "./chat-projection";

function withoutTrace(parts: ProjectedPart[]): ProjectedPart[] {
  return parts.filter(
    (part) => !(part.type === "data" && part.name === "execution-trace"),
  );
}

const listed: ActionResult = {
  action: "capabilities.list",
  status: "success",
  summary: "Listed environment.",
};

describe("chat projection", () => {
  it("keeps backend progress distinct, updates it in place and avoids repeating a terminal notice as model text", () => {
    let state = emptyChatProjection();
    const notice = {
      id: "progress:call",
      origin: "backend" as const,
      severity: "info" as const,
      message: "Searching Google",
      code: "command_progress",
    };
    state = projectChatEvent(state, { type: "backend_notice", notice });
    state = projectChatEvent(state, {
      type: "backend_notice",
      notice: { ...notice, message: "Searching DuckDuckGo" },
    });
    expect(state.parts).toHaveLength(1);
    expect(state.parts[0]).toMatchObject({
      type: "data",
      name: "backend-notice",
      data: { message: "Searching DuckDuckGo" },
    });
    state = projectChatEvent(state, {
      type: "backend_notice",
      notice: {
        ...notice,
        id: "turn:limit",
        severity: "error",
        message: "Turn limit reached",
        code: "turn_limit",
      },
    });
    state = projectChatEvent(state, {
      type: "turn_status",
      stop: "limit",
      summary: "Turn limit reached",
    });
    expect(
      visibleProjection(state).filter((part) => part.type === "text"),
    ).toEqual([]);
  });
  it("keeps earlier text and a settled tool when the next round streams", () => {
    let state = emptyChatProjection();
    state = projectChatEvent(state, { type: "delta", text: "Checking" });
    state = projectChatEvent(state, {
      type: "delta",
      text: "Checking the platform",
    });
    state = projectChatEvent(state, {
      type: "tools",
      content: "Checking the platform",
      calls: [
        {
          id: "call-1",
          name: "capabilities.list",
          arguments: { path: "environment" },
        },
      ],
    });
    state = projectChatEvent(state, {
      type: "tool_result",
      toolCallId: "call-1",
      name: "capabilities.list",
      args: { path: "environment" },
      result: listed,
    });
    state = projectChatEvent(state, { type: "delta", text: "Windows." });
    expect(withoutTrace(visibleProjection(state))).toEqual([
      { type: "text", text: "Checking the platform" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "capabilities.list",
        args: { path: "environment" },
        argsText: JSON.stringify({ path: "environment" }),
        result: listed,
        isError: false,
      },
      { type: "text", text: "Windows." },
    ]);
  });

  it("shows a limit summary and does not leave the tool pending", () => {
    let state = emptyChatProjection();
    state = projectChatEvent(state, {
      type: "tool_result",
      toolCallId: "call-1",
      name: "capabilities.list",
      args: {},
      result: listed,
    });
    state = projectChatEvent(state, {
      type: "turn_status",
      stop: "limit",
      summary: "The turn reached the tool request limit.",
    });
    const visible = withoutTrace(visibleProjection(state));
    expect(visible[0]).toMatchObject({
      type: "tool-call",
      result: listed,
    });
    expect(visible.at(-1)).toEqual({
      type: "text",
      text: "The turn reached the tool request limit.",
    });
  });

  it("shows a completed summary when the model wrote nothing", () => {
    let state = emptyChatProjection();
    state = projectChatEvent(state, {
      type: "tools",
      content: "",
      calls: [
        {
          id: "call-1",
          name: "capabilities.list",
          arguments: {},
        },
      ],
    });
    state = projectChatEvent(state, {
      type: "turn_status",
      stop: "completed",
      summary: "Ollama finished without a written reply.",
    });
    expect(withoutTrace(visibleProjection(state)).at(-1)).toEqual({
      type: "text",
      text: "Ollama finished without a written reply.",
    });
  });

  it("keeps the written result visible when saving fails", () => {
    let state = projectChatEvent(emptyChatProjection(), {
      type: "trace_clock",
      turnId: "turn-1",
      workStartedAt: 1_000,
    });
    state = projectChatEvent(state, {
      type: "delta",
      text: "The file stayed put.",
    });
    state = projectChatEvent(state, {
      type: "trace_clock",
      resultReadyAt: 4_000,
      stop: "completed",
      reporting: false,
    });
    state = projectChatEvent(state, {
      type: "finalization",
      turnId: "turn-1",
      threadId: "thread",
      assistantMessageId: "assistant",
      state: "failed",
      message: "The message could not be saved.",
    });
    const visible = visibleProjection(state);
    expect(
      visible.some(
        (part) => part.type === "text" && part.text === "The file stayed put.",
      ),
    ).toBe(true);
    expect(visible).toContainEqual(
      expect.objectContaining({
        type: "data",
        name: "execution-trace",
        data: expect.objectContaining({ readiness: "ready" }),
      }),
    );
    expect(visible).toContainEqual(
      expect.objectContaining({ type: "data", name: "finalization" }),
    );
    expect(state.trace?.summary.workMs).toBe(3_000);
  });

  it("excludes approval wait from work time and releases a cancellation", () => {
    const started = Date.now() - 1_000;
    let state = projectChatEvent(emptyChatProjection(), {
      type: "trace_clock",
      workStartedAt: started,
      approvalDeltaMs: 40,
    });
    expect(state.trace?.readiness).toBe("working");
    state = projectChatEvent(state, {
      type: "trace_clock",
      reporting: true,
    });
    expect(state.trace?.readiness).toBe("reporting");
    state = projectChatEvent(state, {
      type: "turn_status",
      stop: "cancelled",
      summary: "You stopped this reply.",
    });
    expect(state.trace?.readiness).toBe("ready");
    expect(state.trace?.summary.waitMs).toBe(40);
    expect(state.trace?.summary.workMs).toBe(
      (state.trace?.timing.resultReadyAt ?? started) - started - 40,
    );
  });
});
