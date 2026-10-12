import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseAttachmentRefs } from "../files/asset-store";
import type { AttachmentRef } from "../../shared/attachments";
import type {
  QueueSource,
  QueueStatus,
  QueuedTurn,
} from "../../shared/turn-queue";

export type QueuedTurnStore = {
  threadExists(threadId: string): boolean;
  insert(input: {
    threadId: string;
    text: string;
    branchAnchor: string | null;
    source: QueueSource;
    attachmentRefs?: AttachmentRef[];
    now: number;
  }): QueuedTurn;
  get(id: string): QueuedTurn | null;
  visible(threadId: string): QueuedTurn[];
  hasUnfinished(): boolean;
  nextQueuedHead(): QueuedTurn | null;
  markStaleBranches(now: number): boolean;
  recoverInterrupted(now: number): number;
  markRunning(id: string, turnId: string, now: number): boolean;
  setStatus(
    id: string,
    status: QueueStatus,
    now: number,
    released?: boolean,
  ): boolean;
  acknowledge(id: string, now: number): boolean;
  rebind(id: string, anchor: string | null, now: number): boolean;
  sendAgain(id: string, now: number): boolean;
  cancel(id: string, now: number, allowed: readonly QueueStatus[]): boolean;
  clearPending(threadId: string, now: number): number;
  headId(threadId: string): string | null;
};

type TurnRow = {
  id: string;
  thread_id: string;
  branch_anchor: string | null;
  source: QueueSource;
  text: string;
  attachment_refs_json: string;
  status: QueueStatus;
  sequence: number;
  released: number;
  turn_id: string | null;
  created_at: number;
  updated_at: number;
};

const COLUMNS = `id, thread_id, branch_anchor, source, text, attachment_refs_json,
  status, sequence, released, turn_id, created_at, updated_at`;

const OPEN_STATUSES = `('queued', 'running', 'awaiting_approval', 'failed', 'interrupted', 'pinned')`;

function mapTurn(row: TurnRow): QueuedTurn {
  return {
    id: row.id,
    threadId: row.thread_id,
    branchAnchor: row.branch_anchor,
    source: row.source,
    text: row.text,
    attachmentRefs: parseAttachmentRefs(row.attachment_refs_json),
    status: row.status,
    sequence: row.sequence,
    released: row.released === 1,
    turnId: row.turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function branchIntact(
  messages: { id: string; parent_id: string | null }[],
  head: string | null,
  anchor: string | null,
): boolean {
  if (head === anchor) return true;
  if (!head) return false;
  const parent = new Map(messages.map((row) => [row.id, row.parent_id]));
  const childCount = new Map<string | null, number>();
  for (const row of messages) {
    childCount.set(row.parent_id, (childCount.get(row.parent_id) ?? 0) + 1);
  }
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = head;
  while (cursor) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    chain.push(cursor);
    if (anchor !== null && cursor === anchor) break;
    const next = parent.get(cursor);
    if (next === undefined) return false;
    cursor = next;
  }
  if (anchor !== null && cursor !== anchor) return false;
  for (let index = 1; index < chain.length; index += 1) {
    const node = chain[index];
    if (!node) continue;
    if ((childCount.get(node) ?? 0) > 1) return false;
  }
  if (anchor === null && (childCount.get(null) ?? 0) > 1) return false;
  return true;
}

export function createQueuedTurnStore(database: DatabaseSync): QueuedTurnStore {
  function read(id: string): QueuedTurn | null {
    const row = database
      .prepare(`SELECT ${COLUMNS} FROM queued_turns WHERE id = ?`)
      .get(id) as TurnRow | undefined;
    return row ? mapTurn(row) : null;
  }

  function openRows(): QueuedTurn[] {
    const rows = database
      .prepare(
        `SELECT ${COLUMNS} FROM queued_turns
         WHERE status IN ${OPEN_STATUSES}
           AND NOT (status = 'failed' AND released = 1)
         ORDER BY sequence ASC, created_at ASC`,
      )
      .all() as TurnRow[];
    return rows.map(mapTurn);
  }

  return {
    threadExists(threadId: string): boolean {
      const row = database
        .prepare(`SELECT id FROM threads WHERE id = ?`)
        .get(threadId) as { id: string } | undefined;
      return row !== undefined;
    },
    insert(input: {
      threadId: string;
      text: string;
      branchAnchor: string | null;
      source: QueueSource;
      attachmentRefs?: AttachmentRef[];
      now: number;
    }): QueuedTurn {
      const id = randomUUID();
      database.exec("BEGIN");
      try {
        const sequenceRow = database
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) AS sequence
             FROM queued_turns WHERE thread_id = ?`,
          )
          .get(input.threadId) as { sequence: number };
        database
          .prepare(
            `INSERT INTO queued_turns (
               id, thread_id, branch_anchor, source, text, attachment_refs_json,
               status, sequence, released, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
          )
          .run(
            id,
            input.threadId,
            input.branchAnchor,
            input.source,
            input.text,
            JSON.stringify(input.attachmentRefs ?? []),
            sequenceRow.sequence + 1,
            input.now,
            input.now,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      const stored = read(id);
      if (!stored) throw new Error("The queued turn was not stored.");
      return stored;
    },
    get: read,
    visible(threadId: string): QueuedTurn[] {
      return openRows().filter(
        (row) =>
          row.threadId === threadId &&
          (row.status === "queued" ||
            row.status === "pinned" ||
            row.status === "failed" ||
            row.status === "interrupted"),
      );
    },
    hasUnfinished(): boolean {
      return openRows().length > 0;
    },
    nextQueuedHead(): QueuedTurn | null {
      const grouped = new Map<string, QueuedTurn[]>();
      for (const row of openRows()) {
        const list = grouped.get(row.threadId) ?? [];
        list.push(row);
        grouped.set(row.threadId, list);
      }
      let winner: QueuedTurn | null = null;
      for (const list of grouped.values()) {
        list.sort((left, right) => left.sequence - right.sequence);
        const head = list[0];
        if (!head || head.status !== "queued") continue;
        if (
          !winner ||
          head.createdAt < winner.createdAt ||
          (head.createdAt === winner.createdAt && head.id < winner.id)
        ) {
          winner = head;
        }
      }
      return winner;
    },
    markStaleBranches(now: number): boolean {
      const threadIds = database
        .prepare(
          `SELECT DISTINCT thread_id FROM queued_turns WHERE status = 'queued'`,
        )
        .all() as { thread_id: string }[];
      let changed = false;
      for (const { thread_id: threadId } of threadIds) {
        const head = database
          .prepare(`SELECT head_id FROM threads WHERE id = ?`)
          .get(threadId) as { head_id: string | null } | undefined;
        const messages = database
          .prepare(`SELECT id, parent_id FROM messages WHERE thread_id = ?`)
          .all(threadId) as { id: string; parent_id: string | null }[];
        const queued = database
          .prepare(
            `SELECT ${COLUMNS} FROM queued_turns
           WHERE thread_id = ? AND status = 'queued'`,
          )
          .all(threadId) as TurnRow[];
        const queuedTurns = queued.map(mapTurn);
        for (const row of queuedTurns) {
          if (branchIntact(messages, head?.head_id ?? null, row.branchAnchor)) {
            continue;
          }
          database
            .prepare(
              `UPDATE queued_turns SET status = 'pinned', updated_at = ?
               WHERE id = ? AND status = 'queued'`,
            )
            .run(now, row.id);
          changed = true;
        }
      }
      return changed;
    },
    recoverInterrupted(now: number): number {
      const result = database
        .prepare(
          `UPDATE queued_turns
           SET status = 'interrupted', updated_at = ?
           WHERE status IN ('running', 'awaiting_approval')`,
        )
        .run(now);
      return Number(result.changes);
    },
    markRunning(id: string, turnId: string, now: number): boolean {
      const result = database
        .prepare(
          `UPDATE queued_turns
           SET status = 'running', turn_id = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(turnId, now, id);
      return result.changes === 1;
    },
    setStatus(
      id: string,
      status: QueueStatus,
      now: number,
      released?: boolean,
    ): boolean {
      const result = database
        .prepare(
          `UPDATE queued_turns
           SET status = ?, updated_at = ?, released = COALESCE(?, released)
           WHERE id = ?`,
        )
        .run(status, now, released === undefined ? null : released ? 1 : 0, id);
      return result.changes === 1;
    },
    acknowledge(id: string, now: number): boolean {
      const result = database
        .prepare(
          `UPDATE queued_turns SET released = 1, updated_at = ?
           WHERE id = ? AND status = 'failed' AND released = 0`,
        )
        .run(now, id);
      return result.changes === 1;
    },
    rebind(id: string, anchor: string | null, now: number): boolean {
      const result = database
        .prepare(
          `UPDATE queued_turns
           SET status = 'queued', branch_anchor = ?, updated_at = ?
           WHERE id = ? AND status = 'pinned'`,
        )
        .run(anchor, now, id);
      return result.changes === 1;
    },
    sendAgain(id: string, now: number): boolean {
      const result = database
        .prepare(
          `UPDATE queued_turns
           SET status = 'queued', released = 0, updated_at = ?
           WHERE id = ? AND status = 'interrupted'`,
        )
        .run(now, id);
      return result.changes === 1;
    },
    cancel(id: string, now: number, allowed: readonly QueueStatus[]): boolean {
      const marks = allowed.map(() => "?").join(", ");
      const result = database
        .prepare(
          `UPDATE queued_turns SET status = 'cancelled', updated_at = ?
           WHERE id = ? AND status IN (${marks})`,
        )
        .run(now, id, ...allowed);
      return result.changes === 1;
    },
    clearPending(threadId: string, now: number): number {
      const result = database
        .prepare(
          `UPDATE queued_turns SET status = 'cancelled', updated_at = ?
           WHERE thread_id = ? AND status IN ('queued', 'pinned')`,
        )
        .run(now, threadId);
      return Number(result.changes);
    },
    headId(threadId: string): string | null {
      const row = database
        .prepare(`SELECT head_id FROM threads WHERE id = ?`)
        .get(threadId) as { head_id: string | null } | undefined;
      return row?.head_id ?? null;
    },
  };
}
