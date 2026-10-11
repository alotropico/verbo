import { DatabaseSync } from "node:sqlite";

export type MigrationStep = {
  version: number;
  up: (database: DatabaseSync) => void;
};

const VERSION_1 = `
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'regular',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    parent_id TEXT,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
`;

const VERSION_3 = `
  CREATE TABLE IF NOT EXISTS turn_events (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_turn_events_message ON turn_events(message_id, seq);
`;

const VERSION_4 = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'thread')),
    thread_id TEXT,
    text TEXT NOT NULL,
    inclusion TEXT NOT NULL CHECK (inclusion IN ('always', 'on_demand')),
    source TEXT NOT NULL CHECK (source IN ('user', 'model', 'settings')),
    origin_thread_id TEXT,
    origin_turn_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
    CHECK (
      (scope = 'global' AND thread_id IS NULL) OR
      (scope = 'thread' AND thread_id IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(scope, inclusion);
  CREATE INDEX IF NOT EXISTS idx_memory_thread ON memory_entries(thread_id);
  CREATE TABLE IF NOT EXISTS memory_changes (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    change TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_changes_created ON memory_changes(created_at);
`;

const VERSION_5 = `
  CREATE TABLE IF NOT EXISTS file_scopes (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL COLLATE NOCASE UNIQUE,
    canonical_path TEXT NOT NULL,
    can_read INTEGER NOT NULL CHECK (can_read IN (0, 1)),
    can_write INTEGER NOT NULL CHECK (can_write IN (0, 1)),
    is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (can_write = 0 OR can_read = 1)
  );
  CREATE TABLE IF NOT EXISTS file_read_grants (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
    canonical_path TEXT NOT NULL,
    thread_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_file_grants_expires ON file_read_grants(expires_at);
  CREATE TABLE IF NOT EXISTS file_scope_generation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO file_scope_generation (id, version) VALUES (1, 1);
`;

const VERSION_6 = `
  CREATE TABLE IF NOT EXISTS file_query_snapshots (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    scope_generation INTEGER NOT NULL,
    root_path TEXT NOT NULL,
    sort_by TEXT NOT NULL,
    sort_direction TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    examined INTEGER NOT NULL,
    warnings_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_file_query_snapshots_expires
    ON file_query_snapshots(expires_at);
  CREATE TABLE IF NOT EXISTS file_query_items (
    snapshot_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    display_path TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    extension TEXT NOT NULL,
    size INTEGER,
    modified_at INTEGER,
    created_at INTEGER,
    read_only INTEGER NOT NULL,
    is_link INTEGER NOT NULL,
    snippet TEXT,
    line_number INTEGER,
    match_count INTEGER,
    PRIMARY KEY (snapshot_id, ordinal),
    FOREIGN KEY (snapshot_id) REFERENCES file_query_snapshots(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS file_query_dirs (
    snapshot_id TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    modified_at INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, absolute_path),
    FOREIGN KEY (snapshot_id) REFERENCES file_query_snapshots(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS file_query_cursors (
    token TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    page_offset INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES file_query_snapshots(id) ON DELETE CASCADE
  );
`;

export const VERBO_MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, up: (database) => database.exec(VERSION_1) },
  {
    version: 2,
    up: (database) => {
      const columns = database.prepare(`PRAGMA table_info(threads)`).all() as {
        name: string;
      }[];
      if (!columns.some((column) => column.name === "head_id")) {
        database.exec(`ALTER TABLE threads ADD COLUMN head_id TEXT`);
      }
      database.exec(`
        UPDATE threads
        SET head_id = (
          SELECT id FROM messages
          WHERE messages.thread_id = threads.id
          ORDER BY created_at DESC
          LIMIT 1
        )
        WHERE head_id IS NULL
      `);
    },
  },
  { version: 3, up: (database) => database.exec(VERSION_3) },
  { version: 4, up: (database) => database.exec(VERSION_4) },
  { version: 5, up: (database) => database.exec(VERSION_5) },
  { version: 6, up: (database) => database.exec(VERSION_6) },
];

export function backupDatabase(
  database: DatabaseSync,
  destination: string,
): void {
  if (destination.includes("'")) throw new Error("Invalid backup path.");
  database.exec("PRAGMA wal_checkpoint(FULL);");
  database.exec(`VACUUM INTO '${destination}'`);
}

function readVersion(database: DatabaseSync): number {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
  );
  const row = database
    .prepare(`SELECT version FROM schema_version LIMIT 1`)
    .get() as { version: number } | undefined;
  if (!row) {
    database.prepare(`INSERT INTO schema_version(version) VALUES (0)`).run();
    return 0;
  }
  return row.version;
}

export function migrateDatabase(
  database: DatabaseSync,
  steps: readonly MigrationStep[],
  backupTo?: (fromVersion: number, toVersion: number) => string,
): number {
  database.exec("PRAGMA foreign_keys = ON;");
  let version = readVersion(database);
  const pending = steps
    .filter((step) => step.version > version)
    .sort((left, right) => left.version - right.version);
  if (pending.length === 0) return version;
  const destination = backupTo?.(
    version,
    pending[pending.length - 1]?.version ?? version,
  );
  if (destination && version > 0) backupDatabase(database, destination);
  for (const step of pending) {
    database.exec("BEGIN");
    try {
      step.up(database);
      database
        .prepare(`UPDATE schema_version SET version = ?`)
        .run(step.version);
      database.exec("COMMIT");
      version = step.version;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return version;
}
