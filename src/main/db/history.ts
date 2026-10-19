import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type HistoryItem = {
  message: {
    id: string;
    role: string;
    content: unknown;
    [key: string]: unknown;
  };
  parentId: string | null;
};

export type ThreadHistory = {
  messages: HistoryItem[];
  headId: string | null;
};

type MessageRow = {
  id: string;
  parent_id: string | null;
  role: string;
  content_json: string;
  created_at: number;
};

function messageId(message: unknown): string | null {
  if (typeof message !== "object" || message === null || !("id" in message))
    return null;
  const id = (message as { id: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function assertTurnThread(
  database: DatabaseSync,
  threadId: string,
  parentId?: string,
): void {
  const thread = database
    .prepare(`SELECT id FROM threads WHERE id = ?`)
    .get(threadId) as { id: string } | undefined;
  if (!thread) throw new Error("Thread not found.");
  if (!parentId) return;
  const parent = database
    .prepare(`SELECT thread_id FROM messages WHERE id = ?`)
    .get(parentId) as { thread_id: string } | undefined;
  if (parent && parent.thread_id !== threadId)
    throw new Error("Branch anchor belongs to another thread.");
}

export function appendStoredMessage(
  database: DatabaseSync,
  threadId: string,
  parentId: string | undefined,
  message: unknown,
  status = "complete",
  expectedHead?: string | null,
): string {
  assertTurnThread(database, threadId, parentId);
  if (parentId) {
    const parent = database
      .prepare(`SELECT id FROM messages WHERE id = ? AND thread_id = ?`)
      .get(parentId, threadId);
    if (!parent) throw new Error("Branch anchor not found.");
  }
  const id = messageId(message) ?? randomUUID();
  const role =
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    typeof (message as { role: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const ts = Date.now();
  const inserted = database
    .prepare(
      `INSERT INTO messages (id, thread_id, parent_id, role, content_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      id,
      threadId,
      parentId ?? null,
      role,
      JSON.stringify(message),
      status,
      ts,
    );
  if (inserted.changes === 0) {
    const existing = database
      .prepare("SELECT thread_id FROM messages WHERE id=?")
      .get(id);
    if (existing?.thread_id !== threadId)
      throw new Error("Message belongs to another thread.");
    return id;
  }
  database
    .prepare(
      `UPDATE threads SET updated_at = ?, head_id = ? WHERE id = ? AND (? = 1 OR head_id IS ?)`,
    )
    .run(
      ts,
      id,
      threadId,
      expectedHead === undefined ? 1 : 0,
      expectedHead ?? null,
    );
  return id;
}

export function loadThreadHistory(
  database: DatabaseSync,
  threadId: string,
): ThreadHistory {
  const rows = database
    .prepare(
      `SELECT id, parent_id, role, content_json, created_at
       FROM messages WHERE thread_id = ? ORDER BY created_at ASC`,
    )
    .all(threadId) as MessageRow[];
  const head = database
    .prepare(`SELECT head_id FROM threads WHERE id = ?`)
    .get(threadId) as { head_id: string | null } | undefined;
  return {
    headId: head?.head_id ?? rows.at(-1)?.id ?? null,
    messages: rows.map((row) => {
      const parsed = JSON.parse(row.content_json) as Record<string, unknown>;
      return {
        parentId: row.parent_id,
        message: {
          ...parsed,
          id: row.id,
          role: row.role,
          content: parsed.content ?? [],
          createdAt:
            typeof parsed.createdAt === "number"
              ? parsed.createdAt
              : row.created_at,
        },
      };
    }),
  };
}
