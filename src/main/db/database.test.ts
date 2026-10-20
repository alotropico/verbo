import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
vi.mock("electron", () => ({ app: {} }));
import { openVerboDatabase } from "./database";
describe("app profile opening", () => {
  it("creates only the current app schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "verbo-open-"));
    try {
      const db = openVerboDatabase(join(directory, "verbo.sqlite"));
      try {
        expect(
          db.prepare("SELECT version FROM schema_version").get()?.version,
        ).toBe(24);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name='memory_entries'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["legacy", "foreign"])(
    "refuses a %s profile without writing schema or backup files",
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "verbo-refusal-")),
        file = join(directory, "verbo.sqlite");
      try {
        const db = new DatabaseSync(file);
        db.exec(
          kind === "legacy"
            ? "CREATE TABLE schema_version(version INTEGER);INSERT INTO schema_version VALUES(23);CREATE TABLE memory_entries(id TEXT);INSERT INTO memory_entries VALUES('keep')"
            : "CREATE TABLE unrelated(id TEXT);INSERT INTO unrelated VALUES('keep')",
        );
        db.close();
        const hash = (): string =>
          createHash("sha256").update(readFileSync(file)).digest("hex");
        const before = hash();
        expect(() => openVerboDatabase(file)).toThrow(
          kind === "legacy"
            ? /verified Alo cutover/
            : /not a Verbo app profile/,
        );
        expect(hash()).toBe(before);
        expect(readdirSync(directory)).toEqual(["verbo.sqlite"]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
