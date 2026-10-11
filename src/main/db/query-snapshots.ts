import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FILE_QUERY_LIMITS, type FileQuerySort } from "../../shared/file-query";

export type StoredItem = {
  displayPath: string;
  absolutePath: string;
  kind: "file" | "directory" | "link";
  extension: string;
  size: number | null;
  modifiedAt: number | null;
  createdAt: number | null;
  readOnly: boolean;
  link: boolean;
  snippet: string | null;
  lineNumber: number | null;
  matchCount: number | null;
};

export type StoredDir = {
  absolutePath: string;
  modifiedAt: number;
};

export type StoredSnapshot = {
  id: string;
  threadId: string;
  fingerprint: string;
  scopeGeneration: number;
  complete: boolean;
  examined: number;
  warnings: string[];
  expiresAt: number;
  sort: FileQuerySort;
};

type SnapshotRow = {
  id: string;
  thread_id: string;
  fingerprint: string;
  scope_generation: number;
  complete: number;
  examined: number;
  warnings_json: string;
  expires_at: number;
  sort_by: FileQuerySort["by"];
  sort_direction: FileQuerySort["direction"];
};

type ItemRow = {
  display_path: string;
  absolute_path: string;
  kind: StoredItem["kind"];
  extension: string;
  size: number | null;
  modified_at: number | null;
  created_at: number | null;
  read_only: number;
  is_link: number;
  snippet: string | null;
  line_number: number | null;
  match_count: number | null;
};

type CursorRow = {
  snapshot_id: string;
  page_offset: number;
  expires_at: number;
};

const SORTS = {
  name: "display_path",
  extension: "extension",
  type: "kind",
  size: "size",
  modified: "modified_at",
  created: "created_at",
} as const;

function orderBy(sort: FileQuerySort): string {
  const column = SORTS[sort.by];
  const direction = sort.direction === "desc" ? "DESC" : "ASC";
  const textual =
    column === "display_path" || column === "extension" || column === "kind";
  const primary = textual
    ? `${column} COLLATE NOCASE ${direction}`
    : `${column} ${direction} NULLS LAST`;
  return `${primary}, display_path COLLATE NOCASE ASC, line_number ASC`;
}

function mapItem(row: ItemRow): StoredItem {
  return {
    displayPath: row.display_path,
    absolutePath: row.absolute_path,
    kind: row.kind,
    extension: row.extension,
    size: row.size,
    modifiedAt: row.modified_at,
    createdAt: row.created_at,
    readOnly: row.read_only === 1,
    link: row.is_link === 1,
    snippet: row.snippet,
    lineNumber: row.line_number,
    matchCount: row.match_count,
  };
}

function mapSnapshot(row: SnapshotRow): StoredSnapshot {
  const warnings = JSON.parse(row.warnings_json) as unknown;
  return {
    id: row.id,
    threadId: row.thread_id,
    fingerprint: row.fingerprint,
    scopeGeneration: row.scope_generation,
    complete: row.complete === 1,
    examined: row.examined,
    warnings: Array.isArray(warnings)
      ? warnings.filter((warning) => typeof warning === "string")
      : [],
    expiresAt: row.expires_at,
    sort: { by: row.sort_by, direction: row.sort_direction },
  };
}

export type QuerySnapshotStore = {
  purge: (now: number) => void;
  save: (input: {
    now: number;
    threadId: string;
    fingerprint: string;
    scopeGeneration: number;
    rootPath: string;
    sort: FileQuerySort;
    complete: boolean;
    examined: number;
    warnings: readonly string[];
    items: readonly StoredItem[];
    dirs: readonly StoredDir[];
  }) => StoredSnapshot;
  snapshot: (id: string) => StoredSnapshot | null;
  countItems: (id: string) => number;
  page: (
    id: string,
    offset: number,
    limit: number,
    sort: FileQuerySort,
  ) => StoredItem[];
  validationRows: (id: string) => Array<{
    absolutePath: string;
    size: number | null;
    modifiedAt: number | null;
    kind: StoredItem["kind"];
  }>;
  directories: (id: string) => StoredDir[];
  putCursor: (snapshotId: string, offset: number, expiresAt: number) => string;
  takeCursor: (
    token: string,
  ) => { snapshotId: string; offset: number; expiresAt: number } | null;
  remove: (id: string) => void;
};

export function createQuerySnapshotStore(
  database: DatabaseSync,
): QuerySnapshotStore {
  function removeIds(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(", ");
    database
      .prepare(`DELETE FROM file_query_cursors WHERE snapshot_id IN (${marks})`)
      .run(...ids);
    database
      .prepare(`DELETE FROM file_query_items WHERE snapshot_id IN (${marks})`)
      .run(...ids);
    database
      .prepare(`DELETE FROM file_query_dirs WHERE snapshot_id IN (${marks})`)
      .run(...ids);
    database
      .prepare(`DELETE FROM file_query_snapshots WHERE id IN (${marks})`)
      .run(...ids);
  }

  function snapshotIds(): string[] {
    const rows = database
      .prepare(
        `SELECT id FROM file_query_snapshots ORDER BY created_at ASC, id ASC`,
      )
      .all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  function purge(now: number): void {
    const expired = database
      .prepare(`SELECT id FROM file_query_snapshots WHERE expires_at <= ?`)
      .all(now) as { id: string }[];
    removeIds(expired.map((row) => row.id));
    const keep = Math.max(0, FILE_QUERY_LIMITS.maxSnapshots - 1);
    const ids = snapshotIds();
    if (ids.length > keep) removeIds(ids.slice(0, ids.length - keep));
    const itemCount = database
      .prepare(`SELECT COUNT(*) AS count FROM file_query_items`)
      .get() as { count: number };
    const remaining = snapshotIds();
    if (
      itemCount.count > FILE_QUERY_LIMITS.maxSnapshotItems &&
      remaining.length > 1
    ) {
      removeIds(remaining.slice(0, remaining.length - 1));
    }
  }

  return {
    purge,
    save(input) {
      purge(input.now);
      const id = randomUUID();
      const expiresAt = input.now + FILE_QUERY_LIMITS.snapshotTtlMs;
      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO file_query_snapshots (
               id, thread_id, fingerprint, scope_generation, root_path,
               sort_by, sort_direction, complete, examined, warnings_json,
               created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.threadId,
            input.fingerprint,
            input.scopeGeneration,
            input.rootPath,
            input.sort.by,
            input.sort.direction,
            input.complete ? 1 : 0,
            input.examined,
            JSON.stringify(input.warnings),
            input.now,
            expiresAt,
          );
        const insertItem = database.prepare(
          `INSERT INTO file_query_items (
             snapshot_id, ordinal, display_path, absolute_path, kind, extension,
             size, modified_at, created_at, read_only, is_link, snippet,
             line_number, match_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        input.items.forEach((item, ordinal) => {
          insertItem.run(
            id,
            ordinal,
            item.displayPath,
            item.absolutePath,
            item.kind,
            item.extension,
            item.size,
            item.modifiedAt,
            item.createdAt,
            item.readOnly ? 1 : 0,
            item.link ? 1 : 0,
            item.snippet,
            item.lineNumber,
            item.matchCount,
          );
        });
        const insertDir = database.prepare(
          `INSERT INTO file_query_dirs (snapshot_id, absolute_path, modified_at)
           VALUES (?, ?, ?)`,
        );
        for (const dir of input.dirs) {
          insertDir.run(id, dir.absolutePath, dir.modifiedAt);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return {
        id,
        threadId: input.threadId,
        fingerprint: input.fingerprint,
        scopeGeneration: input.scopeGeneration,
        complete: input.complete,
        examined: input.examined,
        warnings: [...input.warnings],
        expiresAt,
        sort: input.sort,
      };
    },
    snapshot(id) {
      const row = database
        .prepare(
          `SELECT id, thread_id, fingerprint, scope_generation, complete, examined,
                  warnings_json, expires_at, sort_by, sort_direction
           FROM file_query_snapshots WHERE id = ?`,
        )
        .get(id) as SnapshotRow | undefined;
      return row ? mapSnapshot(row) : null;
    },
    countItems(id) {
      const row = database
        .prepare(
          `SELECT COUNT(*) AS count FROM file_query_items WHERE snapshot_id = ?`,
        )
        .get(id) as { count: number };
      return row.count;
    },
    page(id, offset, limit, sort) {
      const rows = database
        .prepare(
          `SELECT display_path, absolute_path, kind, extension, size, modified_at,
                  created_at, read_only, is_link, snippet, line_number, match_count
           FROM file_query_items
           WHERE snapshot_id = ?
           ORDER BY ${orderBy(sort)}
           LIMIT ? OFFSET ?`,
        )
        .all(id, limit, offset) as ItemRow[];
      return rows.map(mapItem);
    },
    validationRows(id) {
      const rows = database
        .prepare(
          `SELECT absolute_path, size, modified_at, kind
           FROM file_query_items WHERE snapshot_id = ?`,
        )
        .all(id) as Array<{
        absolute_path: string;
        size: number | null;
        modified_at: number | null;
        kind: StoredItem["kind"];
      }>;
      return rows.map((row) => ({
        absolutePath: row.absolute_path,
        size: row.size,
        modifiedAt: row.modified_at,
        kind: row.kind,
      }));
    },
    directories(id) {
      const rows = database
        .prepare(
          `SELECT absolute_path, modified_at FROM file_query_dirs WHERE snapshot_id = ?`,
        )
        .all(id) as Array<{ absolute_path: string; modified_at: number }>;
      return rows.map((row) => ({
        absolutePath: row.absolute_path,
        modifiedAt: row.modified_at,
      }));
    },
    putCursor(snapshotId, offset, expiresAt) {
      const token = randomUUID();
      database
        .prepare(
          `INSERT INTO file_query_cursors (token, snapshot_id, page_offset, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(token, snapshotId, offset, expiresAt);
      return token;
    },
    takeCursor(token) {
      const row = database
        .prepare(
          `SELECT snapshot_id, page_offset, expires_at
           FROM file_query_cursors WHERE token = ?`,
        )
        .get(token) as CursorRow | undefined;
      if (!row) return null;
      return {
        snapshotId: row.snapshot_id,
        offset: row.page_offset,
        expiresAt: row.expires_at,
      };
    },
    remove(id) {
      removeIds([id]);
    },
  };
}
