import type { DatabaseSync } from "node:sqlite";
import type { ChatMessage } from "../../shared/chat-ipc";
import type { ContextMeters } from "../../shared/memory";
import { expandHistoryWithTurnEvents } from "../db/turn-events";
import { createMemoryStore } from "../db/memory";
import { buildTurnContext, contextTokens } from "./context-builder";
import {
  AGENT_PROFILES,
  IMMUTABLE_AGENT_INSTRUCTIONS,
} from "../agents/profiles";
import type { AgentId } from "../../shared/workflows";
import type { InferenceMeasurement } from "../../shared/inference-metrics";

function textFromStored(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as {
      content?: unknown;
    };
    if (typeof parsed.content === "string") return parsed.content;
    if (!Array.isArray(parsed.content)) return "";
    return parsed.content
      .flatMap((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return [part.text];
        }
        return [];
      })
      .join("\n");
  } catch {
    return "";
  }
}

function historyForThread(
  database: DatabaseSync,
  threadId: string | undefined,
): ChatMessage[] {
  if (!threadId) return [];
  const rows = database
    .prepare(
      `SELECT id, role, content_json FROM messages
       WHERE thread_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at ASC`,
    )
    .all(threadId) as {
    id: string;
    role: "user" | "assistant";
    content_json: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: textFromStored(row.content_json),
  }));
}

export function estimateContextMeters(input: {
  database: DatabaseSync;
  threadId?: string;
  numCtx: number;
  lastInference?: InferenceMeasurement | null;
  audience?: AgentId;
}): ContextMeters {
  const store = createMemoryStore(input.database);
  const audience = input.audience ?? "conversational";
  const usage = store.usage(audience);
  const snapshot = store.snapshot(input.threadId, audience);
  const history = expandHistoryWithTurnEvents(
    input.database,
    historyForThread(input.database, input.threadId),
  );
  const built = buildTurnContext({
    history,
    userText: "",
    toolEvents: [],
    numCtx: input.numCtx,
    memory: snapshot,
    includeUser: false,
    instructions: [
      IMMUTABLE_AGENT_INSTRUCTIONS,
      AGENT_PROFILES[audience].instructions,
      ...snapshot.alwaysGlobal,
      ...snapshot.alwaysThread,
    ].join("\n\n"),
  });
  const contextTokensUsed = built.ok
    ? contextTokens(built.messages)
    : input.numCtx;
  return {
    memoryTokens: usage.tokens,
    memoryBudget: usage.budget,
    contextTokens: contextTokensUsed,
    contextWindow: input.numCtx,
    lastInference: input.lastInference ?? null,
  };
}
