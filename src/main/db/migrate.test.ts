import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { migrateDatabase, VERBO_MIGRATIONS } from "./migrate";
describe("app-only schema", () => {
  it("creates app data with no command tables", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(migrateDatabase(db, VERBO_MIGRATIONS)).toBe(24);
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      expect(names).toContain("workflow_action_attempts");
      expect(names).toContain("attachments");
      expect(names).not.toContain("memory_entries");
      expect(names).not.toContain("command_receipts");
      expect(migrateDatabase(db, VERBO_MIGRATIONS)).toBe(24);
    } finally {
      db.close();
    }
  });
  it("refuses to discard an unpartitioned legacy profile", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE schema_version(version INTEGER);INSERT INTO schema_version VALUES(23);CREATE TABLE memory_entries(id TEXT);INSERT INTO memory_entries VALUES('keep')",
      );
      expect(() => migrateDatabase(db, VERBO_MIGRATIONS)).toThrow(
        /verified Alo cutover/,
      );
      expect(db.prepare("SELECT id FROM memory_entries").get()?.id).toBe(
        "keep",
      );
      expect(
        db.prepare("SELECT version FROM schema_version").get()?.version,
      ).toBe(23);
    } finally {
      db.close();
    }
  });
  it("rolls back a failed migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() =>
        migrateDatabase(db, [
          {
            version: 1,
            up: (d) => {
              d.exec("CREATE TABLE transient(id TEXT)");
              throw new Error("fixture failure");
            },
          },
        ]),
      ).toThrow("fixture failure");
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='transient'")
          .get(),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT version FROM schema_version").get()?.version,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
