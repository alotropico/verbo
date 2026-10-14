import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import { createTurnDispatcher } from "../runtime/turn-dispatcher";
import { createVoiceDraftService } from "./draft-service";

function setup(): {
  database: DatabaseSync;
  service: ReturnType<typeof createVoiceDraftService>;
  queue: ReturnType<typeof createTurnDispatcher>;
} {
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, VERBO_MIGRATIONS);
  const queue = createTurnDispatcher(database);
  return { database, queue, service: createVoiceDraftService(database, queue) };
}

function addThread(database: DatabaseSync, id: string): void {
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO threads (id, title, status, created_at, updated_at)
       VALUES (?, ?, 'regular', ?, ?)`,
    )
    .run(id, id, now, now);
}

describe("voice drafts", () => {
  it("keeps an idle segment until send, then holds speech while a turn runs", () => {
    const { database, service, queue } = setup();
    addThread(database, "thread-a");
    const first = service.commit({
      threadId: "thread-a",
      text: "hello",
      branchAnchor: null,
    });
    expect(first).toMatchObject({
      ok: true,
      kind: "draft",
      draft: { text: "hello" },
    });
    const sent = service.send({ threadId: "thread-a", branchAnchor: null });
    expect(sent).toMatchObject({
      ok: true,
      kind: "submitted",
      start: true,
      item: { text: "hello", source: "voice" },
    });
    if (!sent.ok || sent.kind !== "submitted") return;
    expect(
      queue.begin({
        queueItemId: sent.item.id,
        threadId: "thread-a",
        turnId: "turn-1",
      }).ok,
    ).toBe(true);
    expect(
      service.commit({
        threadId: "thread-a",
        text: "still talking",
        branchAnchor: null,
        captureMode: "control",
      }),
    ).toEqual({ ok: true, kind: "ignored" });
    expect(
      service.commit({
        threadId: "thread-a",
        text: "stop",
        branchAnchor: null,
        captureMode: "control",
      }),
    ).toEqual({ ok: true, kind: "control", name: "stop" });
    expect(
      service.commit({
        threadId: "thread-a",
        text: "please stop now",
        branchAnchor: null,
        captureMode: "control",
      }),
    ).toEqual({ ok: true, kind: "ignored" });
    expect(
      service.commit({
        threadId: "thread-a",
        text: "started earlier",
        branchAnchor: null,
        captureMode: "dictation",
      }),
    ).toMatchObject({
      ok: true,
      kind: "draft",
      draft: { text: "started earlier" },
    });
    expect(service.read("thread-a")).toMatchObject({
      draft: { text: "started earlier" },
    });
  });

  it("does not queue ordinary speech while a turn or earlier item is ahead", () => {
    const { database, service, queue } = setup();
    addThread(database, "thread-a");
    const typed = queue.enqueue({
      threadId: "thread-a",
      text: "typed first",
      branchAnchor: null,
      source: "typed",
    });
    expect(typed.ok).toBe(true);
    if (!typed.ok) return;
    expect(
      queue.begin({
        queueItemId: typed.item.id,
        threadId: "thread-a",
        turnId: "turn-typed",
      }).ok,
    ).toBe(true);
    const later = queue.enqueue({
      threadId: "thread-a",
      text: "typed second",
      branchAnchor: null,
      source: "typed",
    });
    expect(later.ok).toBe(true);
    expect(
      service.commit({
        threadId: "thread-a",
        text: "alpha",
        branchAnchor: null,
        captureMode: "control",
      }),
    ).toEqual({ ok: true, kind: "ignored" });
    expect(service.read("thread-a")).toMatchObject({ draft: { text: "" } });
    expect(
      queue.snapshot("thread-a").items.some((item) => item.source === "voice"),
    ).toBe(false);
    service.save({ threadId: "thread-a", text: "kept from before" });
    queue.complete("turn-typed");
    expect(service.read("thread-a")).toMatchObject({
      draft: { text: "kept from before" },
    });
    if (!later.ok) return;
    expect(
      queue.begin({
        queueItemId: later.item.id,
        threadId: "thread-a",
        turnId: "turn-typed-2",
      }).ok,
    ).toBe(true);
  });

  it("does not queue a standalone voice command or attach another thread", () => {
    const { database, service, queue } = setup();
    addThread(database, "thread-a");
    addThread(database, "thread-b");
    service.save({ threadId: "thread-a", text: "keep me" });
    expect(
      service.commit({
        threadId: "thread-a",
        text: "clear chat",
        branchAnchor: null,
      }),
    ).toEqual({ ok: true, kind: "command", name: "new" });
    expect(service.read("thread-a")).toMatchObject({
      draft: { text: "keep me" },
    });
    expect(queue.snapshot("thread-a").items).toEqual([]);
    expect(
      service.commit({
        threadId: "thread-a",
        text: '"clear chat"',
        branchAnchor: null,
      }),
    ).toMatchObject({
      ok: true,
      kind: "draft",
      draft: { text: 'keep me "clear chat"' },
    });
    expect(
      service.send({ threadId: "thread-a", branchAnchor: null }),
    ).toMatchObject({
      ok: true,
      kind: "submitted",
      item: { text: 'keep me "clear chat"', source: "voice" },
    });
    expect(service.read("thread-b")).toMatchObject({ draft: { text: "" } });
    expect(queue.snapshot("thread-b").items).toEqual([]);
  });

  it("keeps a stopped draft until send or discard, and waits out a restart hold", () => {
    const { database, service, queue } = setup();
    addThread(database, "thread-a");
    const running = queue.enqueue({
      threadId: "thread-a",
      text: "in flight",
      branchAnchor: null,
      source: "typed",
    });
    if (!running.ok) throw new Error("enqueue failed");
    queue.begin({
      queueItemId: running.item.id,
      threadId: "thread-a",
      turnId: "turn-run",
    });
    service.save({ threadId: "thread-a", text: "unsent" });
    queue.recover();
    expect(
      service.flush({ threadId: "thread-a", branchAnchor: null }),
    ).toMatchObject({ ok: true, kind: "draft" });
    const sent = service.send({ threadId: "thread-a", branchAnchor: null });
    expect(sent).toMatchObject({
      ok: true,
      kind: "submitted",
      start: false,
      item: { text: "unsent", source: "voice" },
    });
    expect(service.read("thread-a")).toMatchObject({ draft: { text: "" } });
    service.save({ threadId: "thread-a", text: "editable" });
    expect(service.discard("thread-a")).toMatchObject({
      draft: { text: "" },
    });
    expect(service.send({ threadId: "thread-a", branchAnchor: null })).toEqual({
      ok: false,
      summary: "The voice draft is empty.",
    });
  });
});
