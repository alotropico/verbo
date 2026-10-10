import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChatMessage } from "../../shared/chat-ipc";
import type { ContextMessage } from "../runtime/context-builder";

const toolCallSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(128),
  arguments: z.unknown(),
});

const assistantToolsPayload = z
  .object({
    content: z.string(),
    toolCalls: z.array(toolCallSchema).max(20),
  })
  .strict();

const toolResultPayload = z
  .object({
    toolName: z.string().min(1).max(128),
    content: z.string(),
  })
  .strict();

const assistantTextPayload = z
  .object({
    content: z.string(),
  })
  .strict();

export type TurnEventKind =
  "assistant_tools" | "tool_result" | "assistant_text";

export type TurnEventRecord = {
  id: string;
  threadId: string;
  messageId: string;
  turnId: string;
  seq: number;
  kind: TurnEventKind;
  payload: unknown;
};

type StoredEvent = {
  seq: number;
  kind: TurnEventKind;
  payload: unknown;
};

type EventRow = {
  seq: number;
  kind: string;
  payload_json: string;
};

export function recordTurnEvent(
  database: DatabaseSync,
  event: TurnEventRecord,
): void {
  const payload = parsePayload(event.kind, event.payload);
  database
    .prepare(
      `INSERT INTO turn_events
        (id, thread_id, message_id, turn_id, seq, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      event.id,
      event.threadId,
      event.messageId,
      event.turnId,
      event.seq,
      event.kind,
      JSON.stringify(payload),
      Date.now(),
    );
}

export function loadTurnEvents(
  database: DatabaseSync,
  messageId: string,
): StoredEvent[] {
  const rows = database
    .prepare(
      `SELECT seq, kind, payload_json
       FROM turn_events WHERE message_id = ? ORDER BY seq ASC`,
    )
    .all(messageId) as EventRow[];
  const events: StoredEvent[] = [];
  for (const row of rows) {
    if (!isKind(row.kind)) continue;
    const parsed = safePayload(row.kind, JSON.parse(row.payload_json));
    if (!parsed) continue;
    events.push({ seq: row.seq, kind: row.kind, payload: parsed });
  }
  return events;
}

function eventsToContext(events: readonly StoredEvent[]): ContextMessage[] {
  const messages: ContextMessage[] = [];
  for (const event of events) {
    if (event.kind === "assistant_tools") {
      const payload = assistantToolsPayload.parse(event.payload);
      messages.push({
        role: "assistant",
        content: payload.content,
        toolCalls: payload.toolCalls,
      });
      continue;
    }
    if (event.kind === "tool_result") {
      const payload = toolResultPayload.parse(event.payload);
      messages.push({
        role: "tool",
        toolName: payload.toolName,
        content: payload.content,
      });
      continue;
    }
    const payload = assistantTextPayload.parse(event.payload);
    if (!payload.content) continue;
    messages.push({ role: "assistant", content: payload.content });
  }
  return messages;
}

export function expandHistoryWithTurnEvents(
  database: DatabaseSync,
  messages: readonly ChatMessage[],
): ContextMessage[] {
  const expanded: ContextMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.id) {
      expanded.push({ role: message.role, content: message.content });
      continue;
    }
    const events = loadTurnEvents(database, message.id);
    if (events.length === 0) {
      expanded.push({ role: "assistant", content: message.content });
      continue;
    }
    expanded.push(...eventsToContext(events));
  }
  return expanded;
}

function isKind(value: string): value is TurnEventKind {
  return (
    value === "assistant_tools" ||
    value === "tool_result" ||
    value === "assistant_text"
  );
}

function parsePayload(kind: TurnEventKind, payload: unknown): unknown {
  if (kind === "assistant_tools") return assistantToolsPayload.parse(payload);
  if (kind === "tool_result") return toolResultPayload.parse(payload);
  return assistantTextPayload.parse(payload);
}

function safePayload(kind: TurnEventKind, payload: unknown): unknown {
  const schema =
    kind === "assistant_tools"
      ? assistantToolsPayload
      : kind === "tool_result"
        ? toolResultPayload
        : assistantTextPayload;
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
