import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app } from "electron";
import { migrateDatabase, VERBO_MIGRATIONS } from "./migrate";

let db: DatabaseSync | null = null;

export function openVerboDatabase(filePath: string): DatabaseSync {
  const database = new DatabaseSync(filePath);
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => String(row.name));
    if (tables.length && !tables.includes("schema_version"))
      throw new Error(
        "This file is not a Verbo app profile. No schema was changed.",
      );
    const version = tables.includes("schema_version")
      ? Number(
          database.prepare("SELECT version FROM schema_version LIMIT 1").get()
            ?.version ?? 0,
        )
      : 0;
    if (version > 0 && version < 24)
      throw new Error(
        "This legacy profile needs the verified Alo cutover before opening. Its saved data has not been changed.",
      );
    if (
      version > 24 ||
      (version === 0 && tables.some((name) => name !== "schema_version"))
    )
      throw new Error("Unsupported Verbo app schema. No schema was changed.");
    migrateDatabase(
      database,
      VERBO_MIGRATIONS,
      (fromVersion) =>
        filePath + ".backup-v" + fromVersion + "-" + Date.now() + ".sqlite",
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function getDatabase(): DatabaseSync {
  if (db) return db;
  const filePath = `${app.getPath("userData")}/verbo.sqlite`;
  mkdirSync(dirname(filePath), { recursive: true });
  db = openVerboDatabase(filePath);
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
