import type { ActionResult } from "./action-contract";
import type { ChatEvent, ChatToolCall, ChatTurnStop } from "./chat-ipc";
import type { BackendNotice } from "./backend-notice";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export type ProjectedPart =
  | {
      type: "data";
      name: "routing-stage";
      data: Extract<ChatEvent, { type: "routing_stage" }>["stage"];
    }
  | {
      type: "data";
      name: "workflow-stage";
      data: Extract<ChatEvent, { type: "stage" }>["stage"];
    }
  | {
      type: "data";
      name: "workflow-execution";
      data: Extract<ChatEvent, { type: "execution" }>["execution"];
    }
  | {
      type: "data";
      name: "finalization";
      data: Extract<ChatEvent, { type: "finalization" }>;
    }
  | { type: "data"; name: "backend-notice"; data: BackendNotice }
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
  appliedDeliveryIds?: string[];
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
  if (event.deliveryId) {
    if (state.appliedDeliveryIds?.includes(event.deliveryId)) return state;
    return projectChatEvent(
      {
        ...state,
        appliedDeliveryIds: [
          ...(state.appliedDeliveryIds ?? []).slice(-1999),
          event.deliveryId,
        ],
      },
      { ...event, deliveryId: undefined },
    );
  }
  if (event.type === "stage") {
    const key = event.stage.attribution.stepRunId;
    const prior = state.parts.findIndex(
      (part) =>
        part.type === "data" &&
        part.name === "workflow-stage" &&
        part.data.attribution.stepRunId === key,
    );
    const next: ProjectedPart = {
      type: "data",
      name: "workflow-stage",
      data: event.stage,
    };
    return {
      ...state,
      parts:
        prior < 0
          ? [...state.parts, next]
          : state.parts.map((part, index) => (index === prior ? next : part)),
    };
  }
  if (event.type === "routing_stage") {
    const index = state.parts.findIndex(
      (part) =>
        part.type === "data" &&
        part.name === "routing-stage" &&
        part.data.invocationId === event.stage.invocationId,
    );
    const next: ProjectedPart = {
      type: "data",
      name: "routing-stage",
      data: event.stage,
    };
    return {
      ...state,
      parts:
        index < 0
          ? [...state.parts, next]
          : state.parts.map((part, at) => (at === index ? next : part)),
    };
  }
  if (event.type === "execution") {
    return {
      ...state,
      parts: [
        ...state.parts.filter(
          (part) =>
            !(
              part.type === "data" &&
              part.name === "workflow-execution" &&
              part.data.id === event.execution.id
            ),
        ),
        { type: "data", name: "workflow-execution", data: event.execution },
      ],
    };
  }
  if (event.type === "finalization") {
    const parts = state.parts.filter(
      (part) => !(part.type === "data" && part.name === "finalization"),
    );
    return {
      ...state,
      parts:
        event.state === "failed"
          ? [...parts, { type: "data", name: "finalization", data: event }]
          : parts,
    };
  }
  if (event.type === "backend_notice") {
    const next: ProjectedPart = {
      type: "data",
      name: "backend-notice",
      data: event.notice,
    };
    const exists = state.parts.some(
      (part) =>
        part.type === "data" &&
        part.name === "backend-notice" &&
        part.data.id === event.notice.id,
    );
    return {
      ...state,
      parts: exists
        ? state.parts.map((part) =>
            part.type === "data" &&
            part.name === "backend-notice" &&
            part.data.id === event.notice.id
              ? next
              : part,
          )
        : [...state.parts, next],
    };
  }
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
        event.summary &&
        !state.parts.some(
          (part) =>
            part.type === "data" &&
            part.name === "backend-notice" &&
            part.data.code === `turn_${event.stop}`,
        ) &&
        (visibleStops.has(event.stop) || event.stop === "completed")
          ? event.summary
          : undefined,
    };
  }
  return state;
}
