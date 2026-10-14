import { describe, expect, it } from "vitest";
import type { ActionResult } from "./action-contract";
import {
  emptyChatProjection,
  projectChatEvent,
  visibleProjection,
} from "./chat-projection";

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
    expect(visibleProjection(state)).toEqual([
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
    const visible = visibleProjection(state);
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
    expect(visibleProjection(state).at(-1)).toEqual({
      type: "text",
      text: "Ollama finished without a written reply.",
    });
  });
});
