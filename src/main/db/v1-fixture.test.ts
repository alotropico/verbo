import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createV1Database,
  readV1Messages,
  representativeV1Fixture,
} from "./v1-fixture";

describe("v1 history fixture", () => {
  it("keeps edited branches, regenerated siblings, archive state, and separate row ids", () => {
    const database = new DatabaseSync(":memory:");
    const fixture = createV1Database(database);
    const stored = readV1Messages(database);

    expect(fixture.threads.map((thread) => thread.title)).toEqual([
      "Field notes",
      "Color",
      "Archived chat",
    ]);
    expect(stored).toHaveLength(11);

    const notes = stored.filter(
      (message) => message.threadId === "thread-notes",
    );
    const edited = notes.find(
      (message) => message.rowId === "row-notes-user-1b",
    );
    expect(edited?.parentRowId).toBeNull();
    expect(edited?.contentId).not.toBe(edited?.rowId);
    expect(
      notes.find((message) => message.rowId === "row-notes-assistant-2")
        ?.parentRowId,
    ).toBe("row-notes-user-2");

    const regen = stored.filter(
      (message) => message.threadId === "thread-regen",
    );
    const answers = regen.filter((message) => message.role === "assistant");
    expect(answers.map((message) => message.parentRowId)).toEqual([
      "row-regen-user",
      "row-regen-user",
    ]);
    expect(answers.map((message) => message.text)).toEqual(["Blue.", "Green."]);

    const statuses = database
      .prepare(`SELECT id, status, title FROM threads ORDER BY id`)
      .all() as { id: string; status: string; title: string }[];
    expect(statuses).toContainEqual({
      id: "thread-archive",
      status: "archived",
      title: "Archived chat",
    });

    const version = database
      .prepare(`SELECT version FROM schema_version`)
      .get() as {
      version: number;
    };
    expect(version.version).toBe(1);
  });

  it("shows that created-at order is not the selected branch", () => {
    const database = new DatabaseSync(":memory:");
    createV1Database(database, representativeV1Fixture());
    const notes = readV1Messages(database).filter(
      (message) => message.threadId === "thread-notes",
    );
    const createdAtParents = notes.map((_, index) =>
      index === 0 ? null : notes[index - 1]?.rowId,
    );
    const storedParents = notes.map((message) => message.parentRowId);
    expect(createdAtParents).not.toEqual(storedParents);
    expect(notes.at(-1)?.rowId).toBe("row-notes-assistant-2");
  });
});
