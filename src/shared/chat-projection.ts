import type { ActionResult } from "./action-contract";
import { classifyActionResult, evaluateRecordedParts } from "./execution-trace";
import type {
  ExecutionTrace,
  RecordedPart,
  TraceClock,
} from "./execution-trace";
import type { ChatEvent, ChatToolCall, ChatTurnStop } from "./chat-ipc";
import type { BackendNotice } from "./backend-notice";
import type { WorkflowAttribution } from "./workflows";

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
      attribution?: WorkflowAttribution;
    }
  | { type: "data"; name: "execution-trace"; data: ExecutionTrace };

export type ChatProjection = {
  appliedDeliveryIds?: string[];
  parts: ProjectedPart[];
  openText: string;
  summary?: string;
  clock?: TraceClock;
  trace?: ExecutionTrace;
  traceLocked?: boolean;
};

export function emptyChatProjection(): ChatProjection {
  return { parts: [], openText: "" };
}

export function visibleProjection(state: ChatProjection): ProjectedPart[] {
  const parts = [...state.parts];
  if (state.openText) parts.push({ type: "text", text: state.openText });
  if (state.summary) parts.push({ type: "text", text: state.summary });
  if (
    state.trace &&
    !parts.some(
      (part) => part.type === "data" && part.name === "execution-trace",
    )
  )
    parts.push({ type: "data", name: "execution-trace", data: state.trace });
  return parts;
}

function argsRecord(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function toolPart(
  call: ChatToolCall,
  result?: ActionResult,
  attribution?: WorkflowAttribution,
): ProjectedPart {
  const args = argsRecord(call.arguments);
  const classified = result ? classifyActionResult(result) : undefined;
  return {
    type: "tool-call",
    toolCallId: call.id,
    toolName: call.name,
    args,
    argsText: JSON.stringify(args),
    ...(attribution ? { attribution } : {}),
    ...(result && classified
      ? {
          result,
          isError: classified.severity === "error",
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

function reduceChatEvent(
  state: ChatProjection,
  event: ChatEvent,
): ChatProjection {
  if (event.deliveryId) {
    if (state.appliedDeliveryIds?.includes(event.deliveryId)) return state;
    return reduceChatEvent(
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
        ...event.calls.map((call) =>
          toolPart(call, undefined, event.attribution),
        ),
      ],
    };
  }
  if (event.type === "tool_result" || event.type === "approval") {
    const parts = state.parts.map((part) =>
      part.type === "tool-call" && part.toolCallId === event.toolCallId
        ? toolPart(
            { id: event.toolCallId, name: event.name, arguments: event.args },
            event.result,
            event.attribution ?? part.attribution,
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
              event.attribution,
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

function clockFrom(
  state: ChatProjection,
  event: ChatEvent,
): TraceClock | undefined {
  if (event.type === "turn_status") {
    const prior = state.clock ?? {};
    const terminal = event.stop !== "paused";
    return {
      ...prior,
      stop: event.stop,
      ...(terminal && prior.resultReadyAt === undefined
        ? { resultReadyAt: Date.now(), reporting: false }
        : {}),
    };
  }
  if (event.type !== "trace_clock") return state.clock;
  const prior = state.clock ?? {};
  return {
    ...prior,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.workStartedAt !== undefined
      ? { workStartedAt: event.workStartedAt }
      : {}),
    ...(event.approvalDeltaMs
      ? { approvalWaitMs: (prior.approvalWaitMs ?? 0) + event.approvalDeltaMs }
      : {}),
    ...(event.reporting !== undefined ? { reporting: event.reporting } : {}),
    ...(event.resultReadyAt !== undefined
      ? { resultReadyAt: event.resultReadyAt }
      : {}),
    ...(event.stop ? { stop: event.stop } : {}),
  };
}

/** Projects one event and refreshes the shared trace. Locked snapshots stay put. */
export function projectChatEvent(
  state: ChatProjection,
  event: ChatEvent,
): ChatProjection {
  if (event.type === "execution_trace")
    return { ...state, trace: event.trace, traceLocked: true };
  const clock = clockFrom(state, event);
  const seeded = clock ? { ...state, clock } : state;
  const reduced =
    event.type === "trace_clock" ? seeded : reduceChatEvent(seeded, event);
  const progressRetired =
    event.type === "trace_clock" && event.resultReadyAt !== undefined
      ? reduced.parts.filter(
          (part) =>
            !(
              part.type === "data" &&
              part.name === "backend-notice" &&
              part.data.code === "command_progress"
            ),
        )
      : reduced.parts;
  const next = {
    ...reduced,
    parts: progressRetired,
    ...(clock ? { clock } : {}),
  };
  if (next.traceLocked) return next;
  return {
    ...next,
    trace: evaluateRecordedParts({
      turnId: next.clock?.turnId ?? "live",
      clock: next.clock,
      parts: next.parts.flatMap((part): RecordedPart[] => {
        if (part.type === "tool-call") {
          return [
            {
              type: "tool-call" as const,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              ...(part.result ? { result: part.result } : {}),
              ...(part.attribution ? { attribution: part.attribution } : {}),
            },
          ];
        }
        if (part.type === "data" && part.name !== "execution-trace")
          return [{ type: "data" as const, name: part.name, data: part.data }];
        if (part.type === "text")
          return [{ type: "text" as const, text: part.text }];
        return [];
      }),
    }),
  };
}
