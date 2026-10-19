import { randomUUID } from "crypto";
import { getDatabase } from "../db/database";
import {
  appendStoredMessage,
  loadThreadHistory,
  type ThreadHistory,
} from "../db/history";
import type { RemoteThreadMetadata } from "../../shared/storage-ipc";
import {
  evaluateRecordedParts,
  type RecordedPart,
} from "../../shared/execution-trace";
import type { ActionResult } from "../../shared/action-contract";
import { chatPlaceholderTitle } from "../../shared/thread-title";

export type StoredMessageRow = {
  id: string;
  thread_id: string;
  parent_id: string | null;
  role: string;
  content_json: string;
  status: string;
  created_at: number;
};

function now(): number {
  return Date.now();
}

type ThreadMetaRow = {
  id: string;
  title: string;
  status: string;
  last_message_at: number | null;
  message_count: number;
};

const THREAD_META_COLUMNS = `
  t.id,
  t.title,
  t.status,
  (
    SELECT MAX(created_at) FROM messages
    WHERE thread_id = t.id AND role IN ('user', 'assistant')
  ) AS last_message_at,
  (
    SELECT COUNT(*) FROM messages
    WHERE thread_id = t.id AND role IN ('user', 'assistant')
  ) AS message_count
`;

function threadMetadata(row: ThreadMetaRow): RemoteThreadMetadata {
  return {
    status: row.status === "archived" ? "archived" : "regular",
    remoteId: row.id,
    externalId: row.id,
    title: row.title,
    messageCount: Number(row.message_count),
    ...(row.last_message_at == null
      ? {}
      : { lastMessageAt: Number(row.last_message_at) }),
  };
}

export function listThreads(): RemoteThreadMetadata[] {
  const rows = getDatabase()
    .prepare(
      `SELECT ${THREAD_META_COLUMNS}
       FROM threads t
       WHERE t.status != 'deleted'
       ORDER BY t.updated_at DESC`,
    )
    .all() as ThreadMetaRow[];
  return rows.map(threadMetadata);
}

export function initializeThread(localId: string): {
  remoteId: string;
  externalId: string;
} {
  const db = getDatabase();
  const id = localId || randomUUID();
  const title = chatPlaceholderTitle(id);
  const ts = now();
  db.prepare(
    `INSERT INTO threads (id, title, status, created_at, updated_at)
     VALUES (?, ?, 'regular', ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(id, title, ts, ts);
  return { remoteId: id, externalId: id };
}

export function renameThread(remoteId: string, title: string): void {
  getDatabase()
    .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, now(), remoteId);
}

export function archiveThread(remoteId: string): void {
  getDatabase()
    .prepare(
      `UPDATE threads SET status = 'archived', updated_at = ? WHERE id = ?`,
    )
    .run(now(), remoteId);
}

export function unarchiveThread(remoteId: string): void {
  getDatabase()
    .prepare(
      `UPDATE threads SET status = 'regular', updated_at = ? WHERE id = ?`,
    )
    .run(now(), remoteId);
}

export function deleteThread(remoteId: string): void {
  const db = getDatabase();
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(remoteId);
    db.prepare(`DELETE FROM threads WHERE id = ?`).run(remoteId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function fetchThread(remoteId: string): RemoteThreadMetadata {
  const row = getDatabase()
    .prepare(
      `SELECT ${THREAD_META_COLUMNS}
       FROM threads t
       WHERE t.id = ?`,
    )
    .get(remoteId) as ThreadMetaRow | undefined;
  if (!row) {
    throw new Error("Thread not found");
  }
  return threadMetadata(row);
}

export function loadMessageRows(threadId: string): StoredMessageRow[] {
  return getDatabase()
    .prepare(
      `SELECT id, thread_id, parent_id, role, content_json, status, created_at
       FROM messages WHERE thread_id = ? ORDER BY created_at ASC`,
    )
    .all(threadId) as StoredMessageRow[];
}

function withLegacyTrace(history: ThreadHistory): ThreadHistory {
  return {
    ...history,
    messages: history.messages.map((item) => {
      const content = item.message.content;
      if (item.message.role !== "assistant" || !Array.isArray(content))
        return item;
      if (
        content.some(
          (part) =>
            part &&
            typeof part === "object" &&
            "name" in part &&
            part.name === "execution-trace",
        )
      )
        return item;
      const trace = evaluateRecordedParts({
        turnId: item.message.id ?? "legacy",
        parts: content.flatMap((part): RecordedPart[] => {
          if (!part || typeof part !== "object") return [];
          if (
            "type" in part &&
            part.type === "tool-call" &&
            "toolCallId" in part
          )
            return [
              {
                type: "tool-call" as const,
                toolCallId: String(part.toolCallId),
                toolName: "toolName" in part ? String(part.toolName) : "tool",
                ...("result" in part && part.result
                  ? { result: part.result as ActionResult }
                  : {}),
              },
            ];
          if ("type" in part && part.type === "data" && "name" in part)
            return [
              {
                type: "data" as const,
                name: String(part.name),
                data: "data" in part ? part.data : undefined,
              },
            ];
          if ("type" in part && part.type === "text" && "text" in part)
            return [{ type: "text" as const, text: String(part.text) }];
          return [];
        }),
        clock: { assumeReady: true },
      });
      return {
        ...item,
        message: {
          ...item.message,
          content: [
            ...content,
            { type: "data", name: "execution-trace", data: trace },
          ],
        },
      };
    }),
  };
}

export function loadHistory(threadId: string): ThreadHistory {
  return withLegacyTrace(loadThreadHistory(getDatabase(), threadId));
}

export function appendMessage(
  threadId: string,
  parentId: string | undefined,
  message: unknown,
  status = "complete",
): string {
  return appendStoredMessage(
    getDatabase(),
    threadId,
    parentId,
    message,
    status,
  );
}
