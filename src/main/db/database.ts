import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'

let db: DatabaseSync | null = null

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
  `)
  const row = database.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  const version = row?.version ?? 0
  if (version < 1) {
    database.exec(`
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
      DELETE FROM schema_version;
      INSERT INTO schema_version(version) VALUES (1);
    `)
  }
}

export function getDatabase(): DatabaseSync {
  if (db) return db
  const filePath = `${app.getPath('userData')}/verbo.sqlite`
  mkdirSync(dirname(filePath), { recursive: true })
  db = new DatabaseSync(filePath)
  db.exec('PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
