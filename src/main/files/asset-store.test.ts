import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS } from "../../shared/attachments";
import { readFilePage } from "../../shared/file-page";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import { createAssetStore } from "./asset-store";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(): {
  database: DatabaseSync;
  root: string;
  store: ReturnType<typeof createAssetStore>;
} {
  const directory = mkdtempSync(join(tmpdir(), "verbo-assets-"));
  directories.push(directory);
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, VERBO_MIGRATIONS);
  database
    .prepare(
      `INSERT INTO threads (id, title, status, created_at, updated_at)
       VALUES ('thread-1', 'Chat', 'regular', 1, 1)`,
    )
    .run();
  const root = join(directory, "attachments");
  return { database, root, store: createAssetStore(database, root) };
}

describe("attachment assets", () => {
  it("stores bytes under the asset root and keeps the caller name out of the path", () => {
    const { root, store } = setup();
    const saved = store.put({
      threadId: "thread-1",
      name: "..\\..\\notes.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("hello"),
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.attachment.name).toBe("notes.txt");
    const names = readdirSync(root);
    expect(names).toEqual([`${saved.attachment.id}.bin`]);
    const excerpt = store.excerpt("thread-1", [saved.attachment.id]);
    expect(excerpt).toContain("hello");
    expect(excerpt).toContain("do not change permissions");
  });

  it("omits a file that is no longer the stored bytes", () => {
    const { root, store } = setup();
    const saved = store.put({
      threadId: "thread-1",
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("hello"),
    });
    if (!saved.ok) throw new Error(saved.summary);
    writeFileSync(join(root, `${saved.attachment.id}.bin`), "hellp");
    expect(store.excerpt("thread-1", [saved.attachment.id])).toContain(
      "missing, omitted",
    );
  });

  it("returns image bytes only while the stored digest still matches", () => {
    const { root, store } = setup();
    const saved = store.put({
      threadId: "thread-1",
      name: "dot.png",
      mediaType: "image/png",
      bytes: Buffer.from("hello"),
    });
    if (!saved.ok) throw new Error(saved.summary);
    expect(store.imagePayloads("thread-1", [saved.attachment.id])).toEqual([
      Buffer.from("hello").toString("base64"),
    ]);
    writeFileSync(join(root, `${saved.attachment.id}.bin`), "hellp");
    expect(store.imagePayloads("thread-1", [saved.attachment.id])).toEqual([]);
  });

  it("rejects an oversized file and sweeps orphans plus unreferenced copies", () => {
    const { database, root, store } = setup();
    const oversized = store.put({
      threadId: "thread-1",
      name: "big.bin",
      mediaType: "application/octet-stream",
      bytes: Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1),
    });
    expect(oversized).toMatchObject({ ok: false, code: "too_large" });
    const saved = store.put({
      threadId: "thread-1",
      name: "keep.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("keep"),
      now: 1,
    });
    if (!saved.ok) throw new Error(saved.summary);
    database
      .prepare(
        `INSERT INTO messages (
           id, thread_id, parent_id, role, content_json, status, created_at
         ) VALUES ('m1', 'thread-1', NULL, 'user', ?, 'complete', 1)`,
      )
      .run(JSON.stringify({ data: saved.attachment.id }));
    writeFileSync(join(root, "orphan.bin"), "nope");
    const stale = store.put({
      threadId: "thread-1",
      name: "old.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("old"),
      now: 1,
    });
    if (!stale.ok) throw new Error(stale.summary);
    store.sweep(ATTACHMENT_LIMITS.unreferencedTtlMs + 5);
    expect(readdirSync(root).sort()).toEqual([`${saved.attachment.id}.bin`]);
  });
});

describe("file page view", () => {
  it("reads a list page and ignores other payloads", () => {
    const page = readFilePage({
      summary: "Listed 1 entries.",
      detail: JSON.stringify({
        items: [{ path: "tmp:/a.txt", type: "file", size: 4 }],
        page: { nextCursor: "00000000-0000-4000-8000-000000000001" },
      }),
    });
    expect(page?.items[0]?.path).toBe("tmp:/a.txt");
    expect(page?.nextCursor).toBe("00000000-0000-4000-8000-000000000001");
    expect(readFilePage({ summary: "ok", detail: '{"scopes":[]}' })).toBeNull();
  });
});
