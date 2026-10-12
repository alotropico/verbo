import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionResult } from "../../shared/action-contract";
import { FILE_MUTATION_LIMITS } from "../../shared/file-mutation";
import { registryForDatabase } from "../capabilities/catalog";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { createScopeStore } from "../db/scopes";
import {
  cancelOperation,
  decideOperation,
  reconcileOperations,
} from "./mutation-plan";
import {
  operationSession,
  resetMutationPorts,
  setMutationPorts,
  setOperationSession,
} from "./mutation-ports";
import { trashItem } from "./recycle-bin";

const databases: DatabaseSync[] = [];
const directories: string[] = [];

function fakeTrash(absolutePath: string): void {
  renameSync(absolutePath, `${absolutePath}.trashed`);
}

beforeEach(() => {
  setOperationSession("session-a");
  setMutationPorts({ trashItem: fakeTrash, now: () => Date.now() });
});

afterEach(() => {
  resetMutationPorts();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "verbo-plan-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "verbo.sqlite"));
  databases.push(db);
  migrateDatabase(db, VERBO_MIGRATIONS);
  return db;
}

function folder(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), name));
  directories.push(directory);
  return directory;
}

function register(root: string, alias = "notes", write = true): DatabaseSync {
  const db = database();
  const saved = createScopeStore(db).apply({
    removeIds: [],
    updates: [],
    additions: [{ alias, path: root, read: true, write, defaultSave: false }],
  });
  expect(saved.ok).toBe(true);
  return db;
}

function invoke(
  db: DatabaseSync,
  name: string,
  args: Record<string, unknown>,
  threadId = "thread-1",
): ActionResult {
  return registryForDatabase(db).invoke(name, args, {
    actor: "model",
    threadId,
  });
}

function approve(
  db: DatabaseSync,
  operationId: string,
  threadId = "thread-1",
): ActionResult {
  return decideOperation({
    database: db,
    scopes: createScopeStore(db),
    operationId,
    threadId,
    sessionId: operationSession(),
    decision: "approve",
  });
}

describe("file mutations", () => {
  it("refuses a bare filename when no default folder is set", () => {
    const root = folder("verbo-nodefault-");
    const db = register(root);
    const created = invoke(db, "files.create", {
      path: "test.txt",
      kind: "file",
      content: "dummy",
    });
    expect(created.code).toBe("no_default_scope");
    expect(existsSync(join(root, "test.txt"))).toBe(false);
  });

  it("saves a bare filename in the default folder", () => {
    const root = folder("verbo-default-");
    const db = database();
    const saved = createScopeStore(db).apply({
      removeIds: [],
      updates: [],
      additions: [
        {
          alias: "tmp",
          path: root,
          read: true,
          write: true,
          defaultSave: true,
        },
      ],
    });
    expect(saved.ok).toBe(true);
    const created = invoke(db, "files.create", {
      path: "test.txt",
      kind: "file",
      content: "dummy",
    });
    expect(created.status).toBe("success");
    expect(readFileSync(join(root, "test.txt"), "utf8")).toBe("dummy");
    const refused = invoke(db, "files.create", {
      path: "test.txt",
      kind: "file",
      content: "again",
    });
    expect(refused.status).not.toBe("success");
    expect(readFileSync(join(root, "test.txt"), "utf8")).toBe("dummy");
  });

  it("writes one new file immediately and keeps its content out of the audit", () => {
    const root = folder("verbo-create-");
    const db = register(root);
    const created = invoke(db, "files.create", {
      path: "notes:/note.md",
      kind: "file",
      content: "secret-token",
    });
    expect(created.status).toBe("success");
    expect(readFileSync(join(root, "note.md"), "utf8")).toBe("secret-token");
    const audit = db
      .prepare(`SELECT request_summary, result_summary FROM action_audit`)
      .all() as Array<{ request_summary: string; result_summary: string }>;
    expect(JSON.stringify(audit)).not.toContain("secret-token");
    expect(audit.length).toBeGreaterThan(0);
  });

  it("does not write a multi-file create until the stored plan is approved", () => {
    const root = folder("verbo-batch-create-");
    const db = register(root);
    const pending = invoke(db, "files.create", {
      items: [
        { path: "notes:/a.md", kind: "file", content: "a" },
        { path: "notes:/b.md", kind: "file", content: "b" },
      ],
    });
    expect(pending.status).toBe("requires_confirmation");
    expect(existsSync(join(root, "a.md"))).toBe(false);
    const decided = approve(db, pending.operationId ?? "");
    expect(decided.status).toBe("success");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("a");
    expect(readFileSync(join(root, "b.md"), "utf8")).toBe("b");
    const replay = approve(db, pending.operationId ?? "");
    expect(replay.code).toBe("replayed");
  });

  it("rejects a forged approval field and an approve action", () => {
    const root = folder("verbo-forge-");
    const db = register(root);
    writeFileSync(join(root, "keep.md"), "keep");
    const forged = invoke(db, "files.trash", {
      path: "notes:/keep.md",
      approved: true,
    });
    expect(forged.code).toBe("invalid_args");
    expect(readFileSync(join(root, "keep.md"), "utf8")).toBe("keep");
    expect(invoke(db, "files.approve", { operationId: "x" }).code).toBe(
      "unknown_action",
    );
  });

  it("leaves a file in place when trash is denied", () => {
    const root = folder("verbo-deny-");
    const db = register(root);
    writeFileSync(join(root, "keep.md"), "keep");
    const pending = invoke(db, "files.trash", { path: "notes:/keep.md" });
    expect(pending.status).toBe("requires_confirmation");
    const denied = decideOperation({
      database: db,
      scopes: createScopeStore(db),
      operationId: pending.operationId ?? "",
      threadId: "thread-1",
      sessionId: operationSession(),
      decision: "deny",
    });
    expect(denied.status).toBe("denied");
    expect(readFileSync(join(root, "keep.md"), "utf8")).toBe("keep");
  });

  it("blocks collisions, cycles, swaps, link escapes, and outside writes", () => {
    const root = folder("verbo-block-");
    const db = register(root);
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    mkdirSync(join(root, "box", "inner"), { recursive: true });
    const outside = folder("verbo-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "jump"), "junction");

    const collision = invoke(db, "files.create", {
      path: "notes:/a.txt",
      kind: "file",
      content: "nope",
    });
    expect(collision.code).toBe("collision");
    expect(collision.summary).toContain("(2)");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a");

    expect(
      invoke(db, "files.move", {
        from: "notes:/box",
        to: "notes:/box/inner/box",
      }).code,
    ).toBe("cycle");
    expect(
      invoke(db, "files.rename", {
        items: [
          { from: "notes:/a.txt", to: "notes:/b.txt" },
          { from: "notes:/b.txt", to: "notes:/a.txt" },
        ],
      }).code,
    ).toBe("swap");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a");
    expect(invoke(db, "files.trash", { path: "notes:/jump" }).code).toBe(
      "link",
    );
    expect(existsSync(join(root, "jump"))).toBe(true);
    const escaped = invoke(db, "files.create", {
      path: join(outside, "new.txt"),
      kind: "file",
      content: "no",
    });
    expect(escaped.code).toBe("outside_scope");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });

  it("copies a readable outside file and refuses a move from a read-only alias", () => {
    const root = folder("verbo-copy-");
    const outside = folder("verbo-copy-src-");
    const db = register(root);
    writeFileSync(join(outside, "src.txt"), "hello");
    const copied = invoke(db, "files.copy", {
      from: join(outside, "src.txt"),
      to: "notes:/src.txt",
    });
    expect(copied.status).toBe("success");
    expect(readFileSync(join(root, "src.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(outside, "src.txt"), "utf8")).toBe("hello");

    const source = folder("verbo-ro-");
    writeFileSync(join(source, "stay.txt"), "stay");
    const saved = createScopeStore(db).apply({
      removeIds: [],
      updates: [],
      additions: [
        {
          alias: "locked",
          path: source,
          read: true,
          write: false,
          defaultSave: false,
        },
      ],
    });
    expect(saved.ok).toBe(true);
    const moved = invoke(db, "files.move", {
      from: "locked:/stay.txt",
      to: "notes:/stay.txt",
    });
    expect(moved.code).toBe("write_denied");
    expect(existsSync(join(source, "stay.txt"))).toBe(true);
  });

  it("requires a diff approval for an edit and rejects invalid JSON", () => {
    const root = folder("verbo-edit-");
    const db = register(root);
    writeFileSync(join(root, "note.json"), '{"ok":true}\n');
    const invalid = invoke(db, "files.edit", {
      path: "notes:/note.json",
      mode: "full",
      content: "{",
    });
    expect(invalid.code).toBe("invalid_json");
    expect(readFileSync(join(root, "note.json"), "utf8")).toBe('{"ok":true}\n');
    const pending = invoke(db, "files.edit", {
      path: "notes:/note.json",
      mode: "replace",
      find: "true",
      replace: "false",
      expectedMatches: 1,
    });
    expect(pending.status).toBe("requires_confirmation");
    expect(readFileSync(join(root, "note.json"), "utf8")).toBe('{"ok":true}\n');
    const decided = approve(db, pending.operationId ?? "");
    expect(decided.status).toBe("success");
    expect(readFileSync(join(root, "note.json"), "utf8")).toBe(
      '{"ok":false}\n',
    );
  });

  it("invalidates a plan when the source or the scope changes", () => {
    const root = folder("verbo-stale-");
    const db = register(root);
    writeFileSync(join(root, "note.md"), "one");
    const pending = invoke(db, "files.edit", {
      path: "notes:/note.md",
      mode: "full",
      content: "two",
    });
    writeFileSync(join(root, "note.md"), "changed");
    const stale = approve(db, pending.operationId ?? "");
    expect(stale.code).toBe("stale_source");
    expect(readFileSync(join(root, "note.md"), "utf8")).toBe("changed");

    const waiting = invoke(db, "files.create", {
      items: [
        { path: "notes:/c.md", kind: "file", content: "c" },
        { path: "notes:/d.md", kind: "file", content: "d" },
      ],
    });
    const scope = createScopeStore(db).list()[0];
    expect(scope).toBeTruthy();
    createScopeStore(db).apply({
      removeIds: [],
      updates: [
        {
          id: scope?.id ?? "",
          alias: "notes",
          read: true,
          write: true,
          defaultSave: false,
        },
      ],
      additions: [],
    });
    const scopeStale = approve(db, waiting.operationId ?? "");
    expect(scopeStale.code).toBe("stale_scope");
    expect(existsSync(join(root, "c.md"))).toBe(false);
  });

  it("rejects the wrong session, thread, or an expired plan", () => {
    const root = folder("verbo-session-");
    const db = register(root);
    let now = 1_700_000_000_000;
    setMutationPorts({ trashItem: fakeTrash, now: () => now });
    writeFileSync(join(root, "keep.md"), "keep");
    const pending = invoke(db, "files.trash", { path: "notes:/keep.md" });
    setOperationSession("session-b");
    expect(approve(db, pending.operationId ?? "").code).toBe("wrong_session");
    setOperationSession("session-a");
    expect(
      decideOperation({
        database: db,
        scopes: createScopeStore(db),
        operationId: pending.operationId ?? "",
        threadId: "thread-2",
        sessionId: "session-a",
        decision: "approve",
      }).code,
    ).toBe("wrong_thread");
    now += FILE_MUTATION_LIMITS.planTtlMs + 1;
    expect(approve(db, pending.operationId ?? "").code).toBe("expired");
    expect(readFileSync(join(root, "keep.md"), "utf8")).toBe("keep");
  });

  it("runs an ordered batch and stops a partial trash without deleting the rest", () => {
    const root = folder("verbo-exec-");
    const db = register(root);
    writeFileSync(join(root, "a.md"), "a");
    const batch = invoke(db, "files.batch", {
      items: [
        { action: "files.create", kind: "directory", path: "notes:/Sorted" },
        { action: "files.move", from: "notes:/a.md", to: "notes:/Sorted/a.md" },
      ],
    });
    expect(batch.status).toBe("requires_confirmation");
    expect(existsSync(join(root, "Sorted"))).toBe(false);
    expect(approve(db, batch.operationId ?? "").status).toBe("success");
    expect(readFileSync(join(root, "Sorted", "a.md"), "utf8")).toBe("a");
    expect(
      invoke(db, "files.batch", {
        items: [
          {
            action: "files.move",
            from: "notes:/Sorted/a.md",
            to: "notes:/Later/a.md",
          },
          { action: "files.create", kind: "directory", path: "notes:/Later" },
        ],
      }).code,
    ).toBe("dependency");
    expect(existsSync(join(root, "Sorted", "a.md"))).toBe(true);

    writeFileSync(join(root, "one.txt"), "1");
    writeFileSync(join(root, "two.txt"), "2");
    writeFileSync(join(root, "three.txt"), "3");
    let calls = 0;
    setMutationPorts({
      trashItem(absolutePath) {
        calls += 1;
        if (calls === 2) throw new Error("Recycle Bin rejected the item.");
        fakeTrash(absolutePath);
      },
    });
    const trashed = invoke(db, "files.trash", {
      paths: ["notes:/one.txt", "notes:/two.txt", "notes:/three.txt"],
    });
    const partial = approve(db, trashed.operationId ?? "");
    expect(partial.status).toBe("partial");
    expect(partial.summary).toBe(
      "Partial: 1 succeeded, 1 failed, 1 not attempted.",
    );
    expect(existsSync(join(root, "one.txt"))).toBe(false);
    expect(existsSync(join(root, "two.txt"))).toBe(true);
    expect(existsSync(join(root, "three.txt"))).toBe(true);
  });

  it("stops later items when the operation is cancelled", () => {
    const root = folder("verbo-cancel-");
    const db = register(root);
    writeFileSync(join(root, "one.txt"), "1");
    writeFileSync(join(root, "two.txt"), "2");
    setMutationPorts({
      trashItem: fakeTrash,
      beforeItem(operationId, index) {
        if (index === 1) {
          cancelOperation({
            database: db,
            operationId,
            threadId: "thread-1",
            sessionId: operationSession(),
          });
        }
      },
    });
    const pending = invoke(db, "files.trash", {
      paths: ["notes:/one.txt", "notes:/two.txt"],
    });
    const cancelled = approve(db, pending.operationId ?? "");
    expect(cancelled.status).toBe("cancelled");
    expect(existsSync(join(root, "one.txt"))).toBe(false);
    expect(existsSync(join(root, "two.txt"))).toBe(true);
  });

  it("undoes one move and refuses undo after the destination changes", () => {
    const root = folder("verbo-undo-");
    const db = register(root);
    writeFileSync(join(root, "a.md"), "a");
    const moved = invoke(db, "files.move", {
      from: "notes:/a.md",
      to: "notes:/b.md",
    });
    expect(moved.status).toBe("success");
    const undone = invoke(db, "files.undo", { operationId: moved.operationId });
    expect(undone.status).toBe("success");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("a");
    expect(existsSync(join(root, "b.md"))).toBe(false);

    const again = invoke(db, "files.move", {
      from: "notes:/a.md",
      to: "notes:/c.md",
    });
    writeFileSync(join(root, "c.md"), "edited");
    expect(
      invoke(db, "files.undo", { operationId: again.operationId }).code,
    ).toBe("stale_source");
    expect(readFileSync(join(root, "c.md"), "utf8")).toBe("edited");
  });

  it("reconciles an interrupted plan without replaying the rest", () => {
    const root = folder("verbo-crash-");
    const db = register(root);
    writeFileSync(join(root, "a.md"), "a");
    writeFileSync(join(root, "b.md"), "b");
    const pending = invoke(db, "files.move", {
      items: [
        { from: "notes:/a.md", to: "notes:/a-next.md" },
        { from: "notes:/b.md", to: "notes:/b-next.md" },
      ],
    });
    const operationId = pending.operationId ?? "";
    expect(operationId).not.toBe("");
    renameSync(join(root, "a.md"), join(root, "a-next.md"));
    db.prepare(
      `UPDATE operation_plans SET status = 'executing' WHERE id = ?`,
    ).run(operationId);
    db.prepare(
      `UPDATE operation_items SET status = 'uncertain' WHERE operation_id = ? AND item_index = 0`,
    ).run(operationId);
    expect(reconcileOperations(db)).toBe(1);
    const row = db
      .prepare(`SELECT status FROM operation_plans WHERE id = ?`)
      .get(operationId) as { status: string };
    expect(row.status).toBe("needs_review");
    const replay = approve(db, pending.operationId ?? "");
    expect(replay.code).toBe("needs_review");
    expect(existsSync(join(root, "b.md"))).toBe(true);
    expect(existsSync(join(root, "b-next.md"))).toBe(false);
  });

  it("expands a saved result set into a fixed move and rejects a stale one", () => {
    const root = folder("verbo-set-");
    const db = register(root);
    mkdirSync(join(root, "out"));
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(join(root, `n${String(index).padStart(2, "0")}.txt`), "x");
    }
    const listed = invoke(db, "files.list", {
      root: "notes:",
      depth: 0,
      entryType: "files",
      pageSize: 20,
    });
    const page = JSON.parse(listed.detail ?? "{}") as {
      page: { nextCursor?: string };
    };
    const cursor = page.page.nextCursor ?? "";
    expect(cursor).not.toBe("");
    const pending = invoke(db, "files.move", {
      resultSet: cursor,
      toDirectory: "notes:/out",
    });
    expect(pending.status).toBe("requires_confirmation");
    expect(pending.totalItems).toBe(25);
    expect(approve(db, pending.operationId ?? "").status).toBe("success");
    expect(existsSync(join(root, "n00.txt"))).toBe(false);
    expect(existsSync(join(root, "out", "n24.txt"))).toBe(true);

    writeFileSync(join(root, "out", "fresh.txt"), "f");
    const again = invoke(db, "files.list", {
      root: "notes:/out",
      depth: 0,
      pageSize: 20,
    });
    const next = JSON.parse(again.detail ?? "{}") as {
      page: { nextCursor?: string };
    };
    utimesSync(
      join(root, "out", "fresh.txt"),
      new Date(),
      new Date(Date.now() + 5000),
    );
    const stale = invoke(db, "files.trash", {
      resultSet: next.page.nextCursor,
    });
    expect(stale.code).toBe("stale_cursor");
    expect(existsSync(join(root, "out", "fresh.txt"))).toBe(true);
  });

  it("sends a file to the Recycle Bin and does not leave a renamed copy", () => {
    const root = folder("verbo-recycle-");
    const db = register(root);
    const file = join(root, "recycle-me.txt");
    writeFileSync(file, "bin");
    setMutationPorts({ trashItem });
    const pending = invoke(db, "files.trash", {
      path: "notes:/recycle-me.txt",
    });
    const trashed = approve(db, pending.operationId ?? "");
    expect(trashed.status).toBe("success");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.trashed`)).toBe(false);
  });
});
