import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { registryForDatabase } from "../capabilities/catalog";
import {
  dispatchModelTool,
  type ActionContext,
} from "../capabilities/registry";
import { migrateDatabase, VERBO_MIGRATIONS } from "./migrate";
import { createMemoryStore } from "./memory";
import { executeLocalCommand } from "../runtime/local-command";
import { modelRoute } from "../../shared/local-commands";
import { estimateContextMeters } from "../runtime/context-estimate";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "verbo-memory-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "verbo.sqlite"));
  migrateDatabase(db, VERBO_MIGRATIONS);
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads (id, title, status, created_at, updated_at)
     VALUES (?, ?, 'regular', ?, ?)`,
  ).run("thread-1", "Notes", now, now);
  return db;
}

const modelContext: ActionContext = {
  actor: "model",
  threadId: "thread-1",
  turnId: "turn-1",
};

describe("memory store", () => {
  it("saves, lists, updates, and removes through the same rules for commands and the model", () => {
    const db = database();
    const store = createMemoryStore(db);
    const registry = registryForDatabase(db);
    const command = executeLocalCommand({
      text: "/remember Prefers short replies",
      store,
      registry,
    });
    expect(command.status).toBe("success");
    expect(modelRoute("/remember Prefers short replies")).toBe("local");
    const again = executeLocalCommand({
      text: "/remember Prefers   short replies",
      store,
      registry,
    });
    expect(again.status).toBe("error");
    expect(again.summary).toContain("already exists");

    const listed = store.list({ scope: "global", inclusion: "always" });
    expect(listed.entries).toHaveLength(1);
    const id = listed.entries[0]?.id ?? "";
    const invoked = dispatchModelTool(
      registry,
      "actions.invoke",
      {
        name: "memory.add",
        args: {
          text: "Project color is teal",
          scope: "global",
          inclusion: "on_demand",
        },
      },
      modelContext,
    );
    expect(invoked.status).toBe("success");
    const snapshot = store.snapshot("thread-1");
    expect(snapshot.alwaysGlobal).toEqual(["Prefers short replies"]);
    expect(snapshot.onDemandGlobalCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("teal");

    const fetched = dispatchModelTool(
      registry,
      "actions.invoke",
      {
        name: "memory.get",
        args: {
          ids: [store.list({ query: "teal" }).entries[0]?.id ?? ""],
        },
      },
      modelContext,
    );
    expect(fetched.detail).toContain("teal");
    expect(store.recentChanges().length).toBeGreaterThan(0);

    const forgotten = executeLocalCommand({
      text: `/forget ${id}`,
      store,
      registry,
    });
    expect(forgotten.status).toBe("success");
    expect(store.list({ inclusion: "always" }).entries).toHaveLength(0);
    const messages = db
      .prepare(`SELECT count(*) AS count FROM messages`)
      .get() as { count: number };
    expect(messages.count).toBe(0);
    db.close();
  });

  it("blocks always-on growth past the budget and keeps on-demand entries", () => {
    const db = database();
    const store = createMemoryStore(db, 8);
    const blocked = store.add({
      text: "x".repeat(80),
      scope: "global",
      inclusion: "always",
      actor: "user_command",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe("memory_budget");
    expect(store.list({}).entries).toHaveLength(0);
    expect(store.recentChanges()).toHaveLength(0);
    const optional = store.add({
      text: "x".repeat(80),
      scope: "global",
      inclusion: "on_demand",
      actor: "model",
      originThreadId: "thread-1",
      originTurnId: "turn-1",
    });
    expect(optional.ok).toBe(true);
    if (!optional.ok) return;
    expect(optional.entry?.source).toBe("model");
    expect(optional.entry?.originTurnId).toBe("turn-1");
    const promoted = store.update({
      id: optional.entry?.id ?? "",
      inclusion: "always",
      actor: "ui",
    });
    expect(promoted.ok).toBe(false);
    db.close();
  });

  it("uses bounded text search and reports context without on-demand text", () => {
    const db = database();
    let fts = true;
    try {
      db.exec(`CREATE VIRTUAL TABLE fts_probe USING fts5(text)`);
      db.exec(`DROP TABLE fts_probe`);
    } catch {
      fts = false;
    }
    expect(fts).toBe(true);
    const store = createMemoryStore(db);
    store.add({
      text: "Vault note about jaguars",
      scope: "thread",
      inclusion: "on_demand",
      threadId: "thread-1",
      actor: "ui",
    });
    expect(
      store.list({ query: "jaguar", scope: "thread" }).entries,
    ).toHaveLength(1);
    expect(store.list({ query: "100%_done" }).entries).toHaveLength(0);
    const meters = estimateContextMeters({
      database: db,
      threadId: "thread-1",
      numCtx: 8192,
    });
    expect(meters.memoryTokens).toBe(0);
    expect(meters.contextWindow).toBe(8192);
    expect(meters.contextTokens).toBeGreaterThan(0);
    db.close();
  });
});
