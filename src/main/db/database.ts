import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app } from "electron";
import { migrateDatabase, VERBO_MIGRATIONS } from "./migrate";

let db: DatabaseSync | null = null;

export function openVerboDatabase(filePath: string): DatabaseSync {
  const database = new DatabaseSync(filePath);
  migrateDatabase(database, VERBO_MIGRATIONS, (fromVersion) => {
    return `${filePath}.backup-v${fromVersion}-${Date.now()}.sqlite`;
  });
  return database;
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
