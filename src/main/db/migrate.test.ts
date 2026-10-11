import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createV1Database, readV1Messages } from "./v1-fixture";
import {
  migrateDatabase,
  VERBO_MIGRATIONS,
  type MigrationStep,
} from "./migrate";
import { loadThreadHistory } from "./history";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDatabase(): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), "verbo-db-"));
  directories.push(directory);
  return { directory, file: join(directory, "verbo.sqlite") };
}

describe("migration protection", () => {
  it("backs up v1, keeps payloads, and records the previous implicit head", () => {
    const { directory, file } = tempDatabase();
    const original = new DatabaseSync(file);
    createV1Database(original);
    original.close();

    const database = new DatabaseSync(file);
    const backup = join(directory, "backup.sqlite");
    const version = migrateDatabase(database, VERBO_MIGRATIONS, () => backup);
    expect(version).toBe(6);
    const stored = readV1Messages(database);
    expect(
      stored.find((message) => message.rowId === "row-notes-user-1b")?.text,
    ).toBe("What is a jaguar in the notes?");
    const head = database
      .prepare(`SELECT head_id FROM threads WHERE id = ?`)
      .get("thread-notes") as {
      head_id: string;
    };
    expect(head.head_id).toBe("row-notes-assistant-2");

    const restored = new DatabaseSync(backup);
    const restoredVersion = restored
      .prepare(`SELECT version FROM schema_version`)
      .get() as {
      version: number;
    };
    expect(restoredVersion.version).toBe(1);
    expect(readV1Messages(restored)).toEqual(stored);
    restored.close();

    expect(
      migrateDatabase(database, VERBO_MIGRATIONS, () =>
        join(directory, "again.sqlite"),
      ),
    ).toBe(6);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_query_snapshots'`,
        )
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_scopes'`,
        )
        .get(),
    ).toBeTruthy();
    const history = loadThreadHistory(database, "thread-notes");
    expect(history.headId).toBe("row-notes-assistant-2");
    expect(
      history.messages.find((item) => item.message.id === "row-notes-user-1b")
        ?.parentId,
    ).toBeNull();
    const raw = database
      .prepare(`SELECT content_json FROM messages WHERE id = ?`)
      .get("row-notes-user-1") as {
      content_json: string;
    };
    expect(JSON.parse(raw.content_json).id).toBe("msg-notes-user-1");
    database.close();
  });

  it("rolls back a failed step and leaves the backup restorable", () => {
    const { directory, file } = tempDatabase();
    const original = new DatabaseSync(file);
    createV1Database(original);
    original.close();
    const database = new DatabaseSync(file);
    const backup = join(directory, "backup.sqlite");
    const nextVersion = (VERBO_MIGRATIONS.at(-1)?.version ?? 0) + 1;
    const failing: MigrationStep = {
      version: nextVersion,
      up: (db) => {
        db.exec(`ALTER TABLE threads ADD COLUMN broken TEXT`);
        throw new Error("boom");
      },
    };
    expect(() =>
      migrateDatabase(database, [...VERBO_MIGRATIONS, failing], () => backup),
    ).toThrow("boom");
    const version = database
      .prepare(`SELECT version FROM schema_version`)
      .get() as { version: number };
    expect(version.version).toBe(nextVersion - 1);
    const columns = database.prepare(`PRAGMA table_info(threads)`).all() as {
      name: string;
    }[];
    expect(columns.some((column) => column.name === "broken")).toBe(false);
    database.close();
  });
});
