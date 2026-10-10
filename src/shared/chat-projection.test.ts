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
});
