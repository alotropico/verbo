import type { ActionResult } from "./action-contract";
import type { ChatEvent, ChatToolCall, ChatTurnStop } from "./chat-ipc";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export type ProjectedPart =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      argsText: string;
      args: JsonObject;
      result?: ActionResult;
      isError?: boolean;
    };

export type ChatProjection = {
  parts: ProjectedPart[];
  openText: string;
  summary?: string;
};

export function emptyChatProjection(): ChatProjection {
  return { parts: [], openText: "" };
}

export function visibleProjection(state: ChatProjection): ProjectedPart[] {
  const parts = [...state.parts];
  if (state.openText) parts.push({ type: "text", text: state.openText });
  if (state.summary) parts.push({ type: "text", text: state.summary });
  return parts;
}

function argsRecord(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function toolPart(call: ChatToolCall, result?: ActionResult): ProjectedPart {
  const args = argsRecord(call.arguments);
  return {
    type: "tool-call",
    toolCallId: call.id,
    toolName: call.name,
    args,
    argsText: JSON.stringify(args),
    ...(result
      ? {
          result,
          isError: result.status === "error" || result.status === "denied",
        }
      : {}),
  };
}

function flushText(state: ChatProjection, fallback: string): ProjectedPart[] {
  const text = state.openText || fallback;
  if (!text) return state.parts;
  return [...state.parts, { type: "text", text }];
}

const visibleStops = new Set<ChatTurnStop>([
  "limit",
  "capacity",
  "no_progress",
  "cancelled",
]);

export function projectChatEvent(
  state: ChatProjection,
  event: ChatEvent,
): ChatProjection {
  if (event.type === "delta") {
    return { ...state, openText: event.text };
  }
  if (event.type === "tools") {
    return {
      ...state,
      openText: "",
      parts: [
        ...flushText(state, event.content),
        ...event.calls.map((call) => toolPart(call)),
      ],
    };
  }
  if (event.type === "tool_result" || event.type === "approval") {
    const parts = state.parts.map((part) =>
      part.type === "tool-call" && part.toolCallId === event.toolCallId
        ? toolPart(
            { id: event.toolCallId, name: event.name, arguments: event.args },
            event.result,
          )
        : part,
    );
    const matched = parts.some(
      (part) =>
        part.type === "tool-call" && part.toolCallId === event.toolCallId,
    );
    return {
      ...state,
      parts: matched
        ? parts
        : [
            ...parts,
            toolPart(
              {
                id: event.toolCallId,
                name: event.name,
                arguments: event.args,
              },
              event.result,
            ),
          ],
    };
  }
  if (event.type === "turn_status") {
    return {
      ...state,
      openText: state.openText,
      summary:
        event.summary && visibleStops.has(event.stop)
          ? event.summary
          : undefined,
    };
  }
  return state;
}
