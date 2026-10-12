import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import { createTurnDispatcher, type TurnDispatcher } from "./turn-dispatcher";

function setup(): { database: DatabaseSync; queue: TurnDispatcher } {
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, VERBO_MIGRATIONS);
  return { database, queue: createTurnDispatcher(database) };
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

function addMessage(
  database: DatabaseSync,
  id: string,
  threadId: string,
  parentId: string | null,
): void {
  database
    .prepare(
      `INSERT INTO messages (
         id, thread_id, parent_id, role, content_json, status, created_at
       ) VALUES (?, ?, ?, 'user', '{}', 'complete', ?)`,
    )
    .run(id, threadId, parentId, Date.now());
  database
    .prepare(`UPDATE threads SET head_id = ? WHERE id = ?`)
    .run(id, threadId);
}

describe("turn dispatcher", () => {
  it("runs two follow-ups FIFO and keeps a single slot", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    const first = queue.enqueue({
      threadId: "thread-a",
      text: "one",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    expect(first).toMatchObject({ ok: true, start: true });
    const second = queue.enqueue({
      threadId: "thread-a",
      text: "two",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    expect(second).toMatchObject({ ok: true, start: false });
    if (!first.ok || !second.ok) return;
    expect(
      queue.begin({
        queueItemId: second.item.id,
        threadId: "thread-a",
        turnId: "turn-2",
      }),
    ).toEqual({ ok: false, summary: "Another turn is still running." });
    expect(
      queue.begin({
        queueItemId: first.item.id,
        threadId: "thread-a",
        turnId: "turn-1",
      }).ok,
    ).toBe(true);
    queue.complete("turn-1");
    const claimed = queue.claim("thread-a");
    expect(claimed.item?.text).toBe("two");
  });

  it("does not offer a removed draft to the model", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    const first = queue.enqueue({
      threadId: "thread-a",
      text: "one",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    const second = queue.enqueue({
      threadId: "thread-a",
      text: "two",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    if (!first.ok || !second.ok) throw new Error("enqueue failed");
    expect(queue.remove(second.item.id).ok).toBe(true);
    expect(
      queue.begin({
        queueItemId: first.item.id,
        threadId: "thread-a",
        turnId: "turn-1",
      }).ok,
    ).toBe(true);
    queue.complete("turn-1");
    expect(queue.claim("thread-a").item).toBeNull();
  });

  it("holds the slot through approval and pauses the thread after failure", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    const first = queue.enqueue({
      threadId: "thread-a",
      text: "change a file",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    const second = queue.enqueue({
      threadId: "thread-a",
      text: "next",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    if (!first.ok || !second.ok) throw new Error("enqueue failed");
    expect(
      queue.begin({
        queueItemId: first.item.id,
        threadId: "thread-a",
        turnId: "turn-1",
      }).ok,
    ).toBe(true);
    queue.awaitApproval("turn-1");
    expect(queue.claim("thread-a").item).toBeNull();
    queue.settleApproval("turn-1");
    expect(queue.claim("thread-a").item?.text).toBe("next");
    queue.releaseReservation(second.item.id);
    expect(
      queue.begin({
        queueItemId: second.item.id,
        threadId: "thread-a",
        turnId: "turn-2",
      }).ok,
    ).toBe(true);
    queue.fail("turn-2");
    const third = queue.enqueue({
      threadId: "thread-a",
      text: "after",
      branchAnchor: null,
      source: "typed",
      now: 3,
    });
    if (!third.ok) throw new Error("enqueue failed");
    expect(third.start).toBe(false);
    expect(queue.claim("thread-a").item).toBeNull();
    expect(queue.acknowledge(second.item.id).ok).toBe(true);
    expect(queue.claim("thread-a").item?.text).toBe("after");
  });

  it("keeps drafts across restart and does not replay a running turn", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    const running = queue.enqueue({
      threadId: "thread-a",
      text: "in flight",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    const waiting = queue.enqueue({
      threadId: "thread-a",
      text: "draft",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    if (!running.ok || !waiting.ok) throw new Error("enqueue failed");
    expect(
      queue.begin({
        queueItemId: running.item.id,
        threadId: "thread-a",
        turnId: "turn-1",
      }).ok,
    ).toBe(true);
    const restarted = createTurnDispatcher(database);
    restarted.recover();
    expect(restarted.snapshot("thread-a").hold).toBe(true);
    expect(restarted.claim("thread-a").item).toBeNull();
    const items = restarted.snapshot("thread-a").items.map((item) => ({
      text: item.text,
      status: item.status,
    }));
    expect(items).toEqual([
      { text: "in flight", status: "interrupted" },
      { text: "draft", status: "queued" },
    ]);
    restarted.releaseHold();
    expect(restarted.claim("thread-a").item).toBeNull();
    expect(restarted.discard(running.item.id).ok).toBe(true);
    expect(restarted.claim("thread-a").item?.text).toBe("draft");
  });

  it("lets the older thread go first without reordering inside a thread", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    addThread(database, "thread-b");
    const first = queue.enqueue({
      threadId: "thread-a",
      text: "a1",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    if (!first.ok) throw new Error("enqueue failed");
    expect(
      queue.begin({
        queueItemId: first.item.id,
        threadId: "thread-a",
        turnId: "turn-a",
      }).ok,
    ).toBe(true);
    const other = queue.enqueue({
      threadId: "thread-b",
      text: "b1",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    const later = queue.enqueue({
      threadId: "thread-a",
      text: "a2",
      branchAnchor: null,
      source: "typed",
      now: 3,
    });
    if (!other.ok || !later.ok) throw new Error("enqueue failed");
    expect(other.start).toBe(false);
    expect(later.start).toBe(false);
    queue.complete("turn-a");
    expect(queue.claim("thread-a")).toMatchObject({
      item: null,
      waitingForThreadId: "thread-b",
    });
    expect(queue.claim("thread-b").item?.text).toBe("b1");
  });

  it("pins a draft when the branch gains a sibling", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    addMessage(database, "root", "thread-a", null);
    addMessage(database, "answer", "thread-a", "root");
    const saved = queue.enqueue({
      threadId: "thread-a",
      text: "follow up",
      branchAnchor: "answer",
      source: "typed",
      now: 1,
    });
    if (!saved.ok) throw new Error("enqueue failed");
    queue.releaseReservation(saved.item.id);
    addMessage(database, "regen", "thread-a", "root");
    const claimed = queue.claim("thread-a");
    expect(claimed.item).toBeNull();
    expect(queue.snapshot("thread-a").items[0]?.status).toBe("pinned");
    expect(queue.rebind(saved.item.id).ok).toBe(true);
    expect(queue.claim("thread-a").item?.text).toBe("follow up");
  });

  it("closes a reserved local command so the next turn can start", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    const saved = queue.enqueue({
      threadId: "thread-a",
      text: "/help",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    if (!saved.ok) throw new Error("enqueue failed");
    expect(saved.start).toBe(true);
    expect(queue.queuedSource(saved.item.id)).toBe("typed");
    expect(queue.completeReserved(saved.item.id)).toBe(true);
    expect(queue.snapshot("thread-a").items).toEqual([]);
    const next = queue.enqueue({
      threadId: "thread-a",
      text: "after",
      branchAnchor: null,
      source: "voice",
      now: 2,
    });
    if (!next.ok) throw new Error("enqueue failed");
    expect(next.start).toBe(true);
    expect(queue.queuedSource(next.item.id)).toBe("voice");
  });
});
