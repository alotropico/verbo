import { DatabaseSync } from "node:sqlite";
import { APP_SCHEMA } from "./app-schema";
export type MigrationStep = {
  version: number;
  up: (database: DatabaseSync) => void;
};
export const VERBO_MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 24,
    up: (database) => {
      if (
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_entries'",
          )
          .get()
      )
        throw new Error(
          "This legacy profile needs the verified Alo cutover before opening. Its saved data has not been changed.",
        );
      database.exec(APP_SCHEMA);
    },
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
