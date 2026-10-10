import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActorKind } from "../../shared/action-contract";
import {
  ALWAYS_ON_MEMORY_TOKEN_BUDGET,
  normalizeMemoryText,
  type MemoryChange,
  type MemoryInclusion,
  type MemoryRecord,
  type MemoryScope,
  type MemorySnapshot,
  type MemorySource,
  type MemoryUsage,
} from "../../shared/memory";
import { estimateTokens } from "../services/history-trim";

type EntryRow = {
  id: string;
  scope: MemoryScope;
  thread_id: string | null;
  text: string;
  inclusion: MemoryInclusion;
  source: MemorySource;
  origin_thread_id: string | null;
  origin_turn_id: string | null;
  created_at: number;
  updated_at: number;
};

type ChangeRow = {
  id: string;
  entry_id: string;
  actor: string;
  change: "add" | "update" | "remove";
  summary: string;
  created_at: number;
};

export type MemoryListFilter = {
  scope?: MemoryScope;
  inclusion?: MemoryInclusion;
  threadId?: string;
  query?: string;
  limit?: number;
};

export type MemoryWrite = {
  text: string;
  scope: MemoryScope;
  inclusion: MemoryInclusion;
  threadId?: string;
  actor: ActorKind;
  originThreadId?: string;
  originTurnId?: string;
};

export type MemoryPatch = {
  id: string;
  text?: string;
  inclusion?: MemoryInclusion;
  actor: ActorKind;
};

export type MemoryFailure = {
  ok: false;
  code: string;
  summary: string;
};

export type MemorySuccess = {
  ok: true;
  summary: string;
  entry?: MemoryRecord;
};

export type MemoryStore = {
  budget: number;
  list: (filter: MemoryListFilter) => {
    entries: MemoryRecord[];
    more: boolean;
  };
  get: (ids: readonly string[]) => MemoryRecord[];
  add: (write: MemoryWrite) => MemoryFailure | MemorySuccess;
  update: (patch: MemoryPatch) => MemoryFailure | MemorySuccess;
  remove: (id: string, actor: ActorKind) => MemoryFailure | MemorySuccess;
  snapshot: (threadId?: string) => MemorySnapshot;
  usage: () => MemoryUsage;
  recentChanges: (limit?: number) => MemoryChange[];
};

function sourceFor(actor: ActorKind): MemorySource {
  if (actor === "model") return "model";
  if (actor === "ui") return "settings";
  return "user";
}

function mapEntry(row: EntryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    threadId: row.thread_id,
    text: row.text,
    inclusion: row.inclusion,
    source: row.source,
    originThreadId: row.origin_thread_id,
    originTurnId: row.origin_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChange(row: ChangeRow): MemoryChange {
  return {
    id: row.id,
    entryId: row.entry_id,
    actor: row.actor,
    change: row.change,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function likePattern(query: string): string {
  const escaped = query
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/gu, (char) => `\\${char}`);
  return `%${escaped}%`;
}

function snippet(text: string): string {
  const flat = normalizeMemoryText(text);
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

export function createMemoryStore(
  database: DatabaseSync,
  budget = ALWAYS_ON_MEMORY_TOKEN_BUDGET,
): MemoryStore {
  database.exec("PRAGMA foreign_keys = ON;");

  function readEntry(id: string): EntryRow | undefined {
    return database
      .prepare(`SELECT * FROM memory_entries WHERE id = ?`)
      .get(id) as EntryRow | undefined;
  }

  function alwaysTokens(exceptId?: string): number {
    const rows = database
      .prepare(
        `SELECT id, text FROM memory_entries
         WHERE scope = 'global' AND inclusion = 'always'`,
      )
      .all() as { id: string; text: string }[];
    return rows
      .filter((row) => row.id !== exceptId)
      .reduce((sum, row) => sum + estimateTokens(row.text), 0);
  }

  function duplicateId(
    text: string,
    scope: MemoryScope,
    threadId: string | null,
    exceptId?: string,
  ): string | undefined {
    const normalized = normalizeMemoryText(text);
    const rows = database
      .prepare(
        `SELECT id, text FROM memory_entries
         WHERE scope = ? AND ifnull(thread_id, '') = ifnull(?, '')`,
      )
      .all(scope, threadId) as { id: string; text: string }[];
    return rows.find(
      (row) =>
        row.id !== exceptId && normalizeMemoryText(row.text) === normalized,
    )?.id;
  }

  function threadExists(threadId: string): boolean {
    const row = database
      .prepare(`SELECT id FROM threads WHERE id = ?`)
      .get(threadId) as { id: string } | undefined;
    return row !== undefined;
  }

  function audit(
    entryId: string,
    actor: ActorKind,
    change: MemoryChange["change"],
    summary: string,
  ): void {
    database
      .prepare(
        `INSERT INTO memory_changes
         (id, entry_id, actor, change, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), entryId, actor, change, summary, Date.now());
  }

  function budgetFailure(
    text: string,
    exceptId?: string,
  ): MemoryFailure | undefined {
    const next = alwaysTokens(exceptId) + estimateTokens(text);
    if (next <= budget) return undefined;
    return {
      ok: false,
      code: "memory_budget",
      summary: `Always-on memory would be ${next}/${budget} estimated tokens. Shorten it or save it as on demand.`,
    };
  }

  function list(filter: MemoryListFilter): {
    entries: MemoryRecord[];
    more: boolean;
  } {
    const clauses = ["1 = 1"];
    const params: (string | number)[] = [];
    if (filter.scope) {
      clauses.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.inclusion) {
      clauses.push("inclusion = ?");
      params.push(filter.inclusion);
    }
    if (filter.threadId) {
      clauses.push("thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.query) {
      clauses.push(`lower(text) LIKE ? ESCAPE '\\'`);
      params.push(likePattern(filter.query));
    }
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    params.push(limit + 1);
    const rows = database
      .prepare(
        `SELECT * FROM memory_entries
         WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC, id ASC
         LIMIT ?`,
      )
      .all(...params) as EntryRow[];
    return {
      entries: rows.slice(0, limit).map(mapEntry),
      more: rows.length > limit,
    };
  }

  function add(write: MemoryWrite): MemoryFailure | MemorySuccess {
    const text = write.text.trim();
    if (!text) {
      return {
        ok: false,
        code: "invalid_args",
        summary: "Memory text is empty.",
      };
    }
    const threadId = write.scope === "thread" ? (write.threadId ?? null) : null;
    if (write.scope === "global" && write.threadId) {
      return {
        ok: false,
        code: "invalid_args",
        summary: "Global memory does not belong to a thread.",
      };
    }
    if (write.scope === "thread" && !threadId) {
      return {
        ok: false,
        code: "invalid_args",
        summary: "A thread memory needs a thread.",
      };
    }
    if (threadId && !threadExists(threadId)) {
      return {
        ok: false,
        code: "unknown_thread",
        summary: "That thread does not exist.",
      };
    }
    const existing = duplicateId(text, write.scope, threadId);
    if (existing) {
      return {
        ok: false,
        code: "duplicate",
        summary: `That memory already exists (${existing}).`,
      };
    }
    if (write.scope === "global" && write.inclusion === "always") {
      const blocked = budgetFailure(text);
      if (blocked) return blocked;
    }
    const id = randomUUID();
    const now = Date.now();
    const source = sourceFor(write.actor);
    const originThreadId =
      write.actor === "model" ? (write.originThreadId ?? null) : null;
    const originTurnId =
      write.actor === "model" ? (write.originTurnId ?? null) : null;
    database.exec("BEGIN");
    try {
      database
        .prepare(
          `INSERT INTO memory_entries
           (id, scope, thread_id, text, inclusion, source,
            origin_thread_id, origin_turn_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          write.scope,
          threadId,
          text,
          write.inclusion,
          source,
          originThreadId,
          originTurnId,
          now,
          now,
        );
      audit(id, write.actor, "add", `Added ${snippet(text)}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const entry = readEntry(id);
    const used = alwaysTokens();
    return {
      ok: true,
      summary: `Saved memory ${id}. Always-on budget ${used}/${budget} estimated tokens.`,
      entry: entry ? mapEntry(entry) : undefined,
    };
  }

  function update(patch: MemoryPatch): MemoryFailure | MemorySuccess {
    const current = readEntry(patch.id);
    if (!current) {
      return {
        ok: false,
        code: "not_found",
        summary: "No memory with that id.",
      };
    }
    const text = patch.text?.trim() ?? current.text;
    const inclusion = patch.inclusion ?? current.inclusion;
    if (patch.text === undefined && patch.inclusion === undefined) {
      return {
        ok: false,
        code: "invalid_args",
        summary: "Update needs text or inclusion.",
      };
    }
    const existing = duplicateId(
      text,
      current.scope,
      current.thread_id,
      current.id,
    );
    if (existing) {
      return {
        ok: false,
        code: "duplicate",
        summary: `That memory already exists (${existing}).`,
      };
    }
    if (current.scope === "global" && inclusion === "always") {
      const blocked = budgetFailure(text, current.id);
      if (blocked) return blocked;
    }
    const now = Date.now();
    database.exec("BEGIN");
    try {
      database
        .prepare(
          `UPDATE memory_entries
           SET text = ?, inclusion = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(text, inclusion, now, current.id);
      const changed =
        text !== current.text && inclusion !== current.inclusion
          ? "text and inclusion"
          : text !== current.text
            ? "text"
            : "inclusion";
      audit(
        current.id,
        patch.actor,
        "update",
        `Updated ${changed}: ${snippet(text)}`,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const entry = readEntry(current.id);
    return {
      ok: true,
      summary: `Updated memory ${current.id}.`,
      entry: entry ? mapEntry(entry) : undefined,
    };
  }

  function remove(id: string, actor: ActorKind): MemoryFailure | MemorySuccess {
    const current = readEntry(id);
    if (!current) {
      return {
        ok: false,
        code: "not_found",
        summary: "No memory with that id.",
      };
    }
    database.exec("BEGIN");
    try {
      database.prepare(`DELETE FROM memory_entries WHERE id = ?`).run(id);
      audit(id, actor, "remove", `Removed ${snippet(current.text)}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, summary: `Removed memory ${id}.` };
  }

  function snapshot(threadId?: string): MemorySnapshot {
    const alwaysGlobal = (
      database
        .prepare(
          `SELECT text FROM memory_entries
           WHERE scope = 'global' AND inclusion = 'always'
           ORDER BY created_at ASC, id ASC`,
        )
        .all() as { text: string }[]
    ).map((row) => row.text);
    const alwaysThread = threadId
      ? (
          database
            .prepare(
              `SELECT text FROM memory_entries
               WHERE scope = 'thread' AND thread_id = ? AND inclusion = 'always'
               ORDER BY created_at ASC, id ASC`,
            )
            .all(threadId) as { text: string }[]
        ).map((row) => row.text)
      : [];
    const globalCount = database
      .prepare(
        `SELECT count(*) AS count FROM memory_entries
         WHERE scope = 'global' AND inclusion = 'on_demand'`,
      )
      .get() as { count: number };
    const threadCount = threadId
      ? (database
          .prepare(
            `SELECT count(*) AS count FROM memory_entries
             WHERE scope = 'thread' AND thread_id = ? AND inclusion = 'on_demand'`,
          )
          .get(threadId) as { count: number })
      : { count: 0 };
    return {
      alwaysGlobal,
      alwaysThread,
      onDemandGlobalCount: globalCount.count,
      onDemandThreadCount: threadCount.count,
    };
  }

  return {
    budget,
    list,
    get(ids) {
      const found: MemoryRecord[] = [];
      for (const id of ids) {
        const row = readEntry(id);
        if (row) found.push(mapEntry(row));
      }
      return found;
    },
    add,
    update,
    remove,
    snapshot,
    usage: () => ({ tokens: alwaysTokens(), budget }),
    recentChanges(limit = 8) {
      const rows = database
        .prepare(
          `SELECT id, entry_id, actor, change, summary, created_at
           FROM memory_changes
           ORDER BY created_at DESC, id ASC
           LIMIT ?`,
        )
        .all(Math.min(Math.max(limit, 1), 20)) as ChangeRow[];
      return rows.map(mapChange);
    },
  };
}
