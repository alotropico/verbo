import { DatabaseSync } from "node:sqlite";
import { agsExecutableIdentity } from "../ags/executable";

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

const VERSION_7 = `
  CREATE TABLE IF NOT EXISTS operation_plans (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    session_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    action_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    scope_generation INTEGER NOT NULL,
    status TEXT NOT NULL,
    approval TEXT NOT NULL,
    risk_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    error_code TEXT,
    error_summary TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_operation_plans_expires
    ON operation_plans(expires_at);
  CREATE TABLE IF NOT EXISTS operation_items (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source_path TEXT,
    destination_path TEXT,
    source_display TEXT,
    destination_display TEXT,
    content TEXT,
    format TEXT,
    before_json TEXT NOT NULL,
    after_json TEXT,
    expected_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    error_summary TEXT,
    UNIQUE (operation_id, item_index),
    FOREIGN KEY (operation_id) REFERENCES operation_plans(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS action_audit (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    request_summary TEXT NOT NULL,
    result_summary TEXT NOT NULL,
    result_status TEXT NOT NULL,
    result_code TEXT,
    operation_id TEXT,
    created_at INTEGER NOT NULL
  );
`;

const VERSION_9 = `
  CREATE TABLE IF NOT EXISTS queued_turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    branch_anchor TEXT,
    source TEXT NOT NULL CHECK (source IN ('typed', 'voice')),
    text TEXT NOT NULL,
    attachment_refs_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'awaiting_approval', 'failed',
      'interrupted', 'pinned', 'completed', 'cancelled'
    )),
    sequence INTEGER NOT NULL,
    released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
    turn_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_queued_turns_thread
    ON queued_turns(thread_id, sequence);
`;

const VERSION_10 = `
  CREATE TABLE IF NOT EXISTS voice_drafts (
    thread_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
`;

const VERSION_11 = `
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_thread
    ON attachments(thread_id, created_at);
`;

const VERSION_12 = `
  ALTER TABLE attachments ADD COLUMN content_sha256 TEXT NOT NULL DEFAULT '';
`;

const VERSION_13 = `
  ALTER TABLE file_scopes ADD COLUMN extra_aliases TEXT NOT NULL DEFAULT '';
`;

const VERSION_14 = `
  CREATE TABLE queued_turns_v14 (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    branch_anchor TEXT,
    source TEXT NOT NULL CHECK (source IN ('typed', 'voice')),
    text TEXT NOT NULL,
    attachment_refs_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'editing', 'running', 'awaiting_approval', 'failed',
      'interrupted', 'pinned', 'completed', 'cancelled'
    )),
    sequence INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    edit_token TEXT,
    released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
    turn_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
  INSERT INTO queued_turns_v14 (
    id, thread_id, branch_anchor, source, text, attachment_refs_json, status,
    sequence, revision, released, turn_id, created_at, updated_at
  )
  SELECT
    id, thread_id, branch_anchor, source, text, attachment_refs_json, status,
    sequence, 0, released, turn_id, created_at, updated_at
  FROM queued_turns;
  DROP TABLE queued_turns;
  ALTER TABLE queued_turns_v14 RENAME TO queued_turns;
  CREATE INDEX IF NOT EXISTS idx_queued_turns_thread
    ON queued_turns(thread_id, sequence);
  CREATE TABLE IF NOT EXISTS composer_buffers (
    thread_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    attachment_refs_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
  ALTER TABLE file_query_snapshots ADD COLUMN omissions_json TEXT NOT NULL DEFAULT '{}';
`;

const VERSION_8 = `
  CREATE TABLE IF NOT EXISTS registered_projects (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL COLLATE NOCASE UNIQUE,
    canonical_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ags_hosts (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL COLLATE NOCASE UNIQUE,
    canonical_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ags_check_command (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    executable_path TEXT NOT NULL
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
  { version: 7, up: (database) => database.exec(VERSION_7) },
  { version: 8, up: (database) => database.exec(VERSION_8) },
  { version: 9, up: (database) => database.exec(VERSION_9) },
  { version: 10, up: (database) => database.exec(VERSION_10) },
  { version: 11, up: (database) => database.exec(VERSION_11) },
  { version: 12, up: (database) => database.exec(VERSION_12) },
  { version: 13, up: (database) => database.exec(VERSION_13) },
  { version: 14, up: (database) => database.exec(VERSION_14) },
  {
    version: 15,
    up: (database) =>
      database.exec(`
    CREATE TABLE command_overrides (
      node_id TEXT PRIMARY KEY, version INTEGER NOT NULL, value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE command_receipts (
      id TEXT PRIMARY KEY, action_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      turn_id TEXT, actor TEXT NOT NULL, result_json TEXT NOT NULL,
      children_json TEXT NOT NULL DEFAULT '[]', resources_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL
    );
    CREATE INDEX command_receipts_thread ON command_receipts(thread_id, finished_at);
  `),
  },
  {
    version: 16,
    up: (database) =>
      database.exec(`CREATE TABLE command_module_settings (
      module_id TEXT PRIMARY KEY, version INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );`),
  },
  {
    version: 17,
    up: (database) =>
      database.exec(`ALTER TABLE command_receipts ADD COLUMN parent_receipt_id TEXT;
      CREATE INDEX command_receipts_parent ON command_receipts(parent_receipt_id);`),
  },
  {
    version: 18,
    up: (database) =>
      database.exec(`CREATE TABLE registered_applications (
      id TEXT PRIMARY KEY, value_json TEXT NOT NULL, executable_identity TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE project_preferences (
      project_id TEXT PRIMARY KEY REFERENCES registered_projects(id) ON DELETE CASCADE, value_json TEXT NOT NULL
    );`),
  },
  {
    version: 19,
    up: (database) => {
      database.exec(
        "ALTER TABLE ags_check_command ADD COLUMN executable_identity TEXT",
      );
      for (const row of database
        .prepare("SELECT id, executable_path FROM ags_check_command")
        .all()) {
        try {
          database
            .prepare(
              "UPDATE ags_check_command SET executable_identity=? WHERE id=?",
            )
            .run(
              agsExecutableIdentity(String(row.executable_path)),
              Number(row.id),
            );
        } catch {
          /* Retain unavailable legacy paths for correction in Settings. */
        }
      }
    },
  },
  {
    version: 20,
    up: (database) =>
      database.exec(`
      CREATE TABLE attachment_live_references (
        receipt_id TEXT NOT NULL REFERENCES command_receipts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        resource_json TEXT NOT NULL,
        PRIMARY KEY(receipt_id, ordinal)
      );
      CREATE INDEX attachment_live_thread ON attachment_live_references(thread_id, receipt_id);
      INSERT INTO attachment_live_references(receipt_id, thread_id, ordinal, resource_json)
      SELECT receipt.id, receipt.thread_id, CAST(item.key AS INTEGER), item.value
      FROM command_receipts AS receipt, json_each(receipt.resources_json) AS item;
      ALTER TABLE command_receipts DROP COLUMN resources_json;
    `),
  },
  {
    version: 21,
    up: (database) =>
      database.exec(`
      ALTER TABLE file_scopes ADD COLUMN folder_kind TEXT NOT NULL DEFAULT 'none'
        CHECK(folder_kind IN ('none','projects','obsidian'));
      CREATE TABLE project_import_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL
      );
    `),
  },
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
