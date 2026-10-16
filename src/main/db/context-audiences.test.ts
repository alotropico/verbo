import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { VERBO_MIGRATIONS, migrateDatabase } from "./migrate";
import { createMemoryStore } from "./memory";
import { agentIdSchema } from "../../shared/workflows";

describe("explicit context recipients", () => {
  it("pages every preserved note and puts unassigned recipients before newer assigned notes", () => {
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, VERBO_MIGRATIONS);
    const store = createMemoryStore(database);
    for (let index = 0; index < 125; index += 1) {
      const result = store.add({
        text: `Preserved note ${index}`,
        scope: "global",
        inclusion: "on_demand",
        audiences: index < 110 ? [] : ["conversational"],
        actor: "ui",
      });
      expect(result.ok).toBe(true);
    }
    const first = store.list({ limit: 100, unassignedFirst: true });
    const second = store.list({
      limit: 100,
      offset: 100,
      unassignedFirst: true,
    });
    expect(first.more).toBe(true);
    expect(first.entries.every((entry) => !entry.audiences.length)).toBe(true);
    expect(second.more).toBe(false);
    expect(second.entries).toHaveLength(25);
    expect(
      new Set([...first.entries, ...second.entries].map((entry) => entry.id))
        .size,
    ).toBe(125);
    database.close();
  });
  it("preserves all legacy notes unassigned and uninjected until selected recipients are assigned", () => {
    const database = new DatabaseSync(":memory:");
    migrateDatabase(
      database,
      VERBO_MIGRATIONS.filter((migration) => migration.version <= 21),
    );
    database
      .prepare(
        "INSERT INTO threads(id,title,created_at,updated_at) VALUES('thread','Old',1,1)",
      )
      .run();
    for (const [id, scope, threadId] of [
      ["global", "global", null],
      ["thread-note", "thread", "thread"],
    ])
      database
        .prepare(
          "INSERT INTO memory_entries(id,scope,thread_id,text,inclusion,source,created_at,updated_at) VALUES(?,?,?,?,'always','user',1,1)",
        )
        .run(id, scope, threadId, `${id} original text`);
    migrateDatabase(database, VERBO_MIGRATIONS);
    const store = createMemoryStore(database);
    for (const audience of agentIdSchema.options)
      expect(store.snapshot("thread", audience)).toMatchObject({
        alwaysGlobal: [],
        alwaysThread: [],
      });
    expect(
      store.list({}).entries.every((entry) => entry.audiences.length === 0),
    ).toBe(true);
    store.update({
      id: "global",
      audiences: ["writer", "decision"],
      actor: "ui",
    });
    expect(store.snapshot("thread", "writer").alwaysGlobal).toEqual([
      "global original text",
    ]);
    expect(store.snapshot("thread", "commander").alwaysGlobal).toEqual([]);
    expect(store.get(["thread-note"])[0]?.text).toBe(
      "thread-note original text",
    );
    expect(store.get(["thread-note"])[0]?.audiences).toEqual([]);
    expect(
      store.add({
        text: "New note",
        scope: "global",
        inclusion: "always",
        actor: "ui",
      }),
    ).toMatchObject({ ok: true, entry: { audiences: ["conversational"] } });
  });
});
