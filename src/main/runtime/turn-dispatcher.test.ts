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
    expect(queue.activeTurn()?.phase).toBe("running");
    expect(queue.claim("thread-a").item).toBeNull();
    queue.complete("turn-1");
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

  it("starts a new chat after restart when another thread is only pinned", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    addThread(database, "thread-b");
    addMessage(database, "root", "thread-a", null);
    addMessage(database, "answer", "thread-a", "root");
    const saved = queue.enqueue({
      threadId: "thread-a",
      text: "old",
      branchAnchor: "answer",
      source: "typed",
      now: 1,
    });
    if (!saved.ok) throw new Error("enqueue failed");
    queue.releaseReservation(saved.item.id);
    addMessage(database, "regen", "thread-a", "root");
    expect(queue.snapshot("thread-a").items[0]?.status).toBe("pinned");
    const restarted = createTurnDispatcher(database);
    restarted.recover();
    expect(restarted.snapshot("thread-a").hold).toBe(false);
    const first = restarted.enqueue({
      threadId: "thread-b",
      text: "hello",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    expect(first).toMatchObject({ ok: true, start: true });
  });

  it("starts a new chat when the user sends after an interrupted turn", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    addThread(database, "thread-b");
    const running = queue.enqueue({
      threadId: "thread-a",
      text: "in flight",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    if (!running.ok) throw new Error("enqueue failed");
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
    const first = restarted.enqueue({
      threadId: "thread-b",
      text: "hello",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    expect(first).toMatchObject({ ok: true, start: true });
    expect(restarted.snapshot("thread-b").hold).toBe(false);
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

  it("keeps a follow-up queued when it moves above a pinned draft", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    const first = queue.enqueue({
      threadId: "thread-a",
      text: "hold",
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
    database
      .prepare(`UPDATE queued_turns SET status = 'pinned' WHERE id = ?`)
      .run(first.item.id);
    expect(
      queue.reorder({
        id: second.item.id,
        threadId: "thread-a",
        revision: second.item.revision,
        direction: "up",
      }).ok,
    ).toBe(true);
    const raised = queue.snapshot("thread-a").items;
    expect(raised.map((item) => [item.text, item.status])).toEqual([
      ["next", "queued"],
      ["hold", "pinned"],
    ]);
    const moved = raised[0];
    if (!moved) throw new Error("missing row");
    expect(
      queue.reorder({
        id: moved.id,
        threadId: "thread-a",
        revision: moved.revision,
        direction: "down",
      }).ok,
    ).toBe(true);
    expect(
      queue.snapshot("thread-a").items.map((item) => [item.text, item.status]),
    ).toEqual([
      ["hold", "pinned"],
      ["next", "queued"],
    ]);
  });

  it("sends a follow-up whose anchor is not stored yet", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    addMessage(database, "answer", "thread-a", null);
    const saved = queue.enqueue({
      threadId: "thread-a",
      text: "hello",
      branchAnchor: "still-on-the-client",
      source: "typed",
      now: 1,
    });
    expect(saved).toMatchObject({ ok: true, start: true });
    if (!saved.ok) return;
    const snapshot = queue.snapshot("thread-a");
    expect(snapshot.outgoingId).toBe(saved.item.id);
    expect(snapshot.items.map((item) => item.status)).toEqual(["queued"]);
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

  it("skips an edited row and keeps its identity after save", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    const first = queue.enqueue({
      threadId: "thread-a",
      text: "A",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    const second = queue.enqueue({
      threadId: "thread-a",
      text: "B",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    const third = queue.enqueue({
      threadId: "thread-a",
      text: "C",
      branchAnchor: null,
      source: "typed",
      now: 3,
    });
    if (!first.ok || !second.ok || !third.ok) throw new Error("enqueue failed");
    expect(
      queue.begin({
        queueItemId: first.item.id,
        threadId: "thread-a",
        turnId: "turn-a",
      }).ok,
    ).toBe(true);
    const editing = queue.beginEdit({
      id: second.item.id,
      threadId: "thread-a",
      revision: second.item.revision,
      composerText: "unsent",
      composerRefs: [],
    });
    expect(editing.ok).toBe(true);
    if (!editing.ok) return;
    expect(editing.item.id).toBe(second.item.id);
    queue.complete("turn-a");
    expect(queue.claim("thread-a").item?.text).toBe("C");
    const saved = queue.saveEdit({
      id: editing.item.id,
      threadId: "thread-a",
      revision: editing.item.revision,
      token: editing.item.editToken ?? "",
      text: "B2",
      attachmentRefs: [],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.item.id).toBe(second.item.id);
    expect(saved.item.sequence).toBe(second.item.sequence);
    expect(saved.item.text).toBe("B2");
    expect(saved.composerText).toBe("unsent");
    expect(
      queue.begin({
        queueItemId: third.item.id,
        threadId: "thread-a",
        turnId: "turn-c",
      }).ok,
    ).toBe(true);
    queue.complete("turn-c");
    expect(queue.claim("thread-a").item?.text).toBe("B2");
  });

  it("lets claim win over a late edit and rejects a stale save", () => {
    const { database, queue } = setup();
    addThread(database, "thread-a");
    const saved = queue.enqueue({
      threadId: "thread-a",
      text: "one",
      branchAnchor: null,
      source: "typed",
      now: 1,
    });
    if (!saved.ok) throw new Error("enqueue failed");
    expect(
      queue.beginEdit({
        id: saved.item.id,
        threadId: "thread-a",
        revision: saved.item.revision,
        composerText: "",
        composerRefs: [],
      }).ok,
    ).toBe(false);
    const later = queue.enqueue({
      threadId: "thread-a",
      text: "two",
      branchAnchor: null,
      source: "typed",
      now: 2,
    });
    if (!later.ok) throw new Error("enqueue failed");
    const opened = queue.beginEdit({
      id: later.item.id,
      threadId: "thread-a",
      revision: later.item.revision,
      composerText: "draft",
      composerRefs: [],
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok || !opened.item.editToken) return;
    expect(
      queue.saveEdit({
        id: later.item.id,
        threadId: "thread-a",
        revision: later.item.revision,
        token: opened.item.editToken,
        text: "two edited",
        attachmentRefs: [],
      }).ok,
    ).toBe(false);
    expect(
      queue.saveEdit({
        id: later.item.id,
        threadId: "thread-a",
        revision: opened.item.revision,
        token: opened.item.editToken,
        text: "two edited",
        attachmentRefs: [],
      }).ok,
    ).toBe(true);
  });
});
