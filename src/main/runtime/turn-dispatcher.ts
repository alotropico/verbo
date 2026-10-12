import type { DatabaseSync } from "node:sqlite";
import { createQueuedTurnStore } from "../db/queued-turns";
import type { AttachmentRef } from "../../shared/attachments";
import type {
  QueueClaimResult,
  QueueEnqueueResult,
  QueueMutationResult,
  QueueSnapshot,
  QueueSource,
  QueuedTurn,
} from "../../shared/turn-queue";

type Slot = {
  queueItemId: string | null;
  threadId: string;
  turnId: string | null;
  phase: "reserved" | "running" | "approval";
};

export type TurnDispatcher = {
  recover(): void;
  enqueue(input: {
    threadId: string;
    text: string;
    branchAnchor: string | null;
    source: QueueSource;
    attachmentRefs?: AttachmentRef[];
    now?: number;
  }): QueueEnqueueResult;
  claim(threadId: string): QueueClaimResult;
  begin(input: {
    queueItemId?: string;
    threadId: string;
    turnId: string;
  }): { ok: true } | { ok: false; summary: string };
  complete(turnId: string): void;
  fail(turnId: string): void;
  cancelIfRunning(turnId: string): void;
  awaitApproval(turnId: string): void;
  settleApproval(turnId: string): void;
  releaseReservation(id: string): void;
  queuedSource(id: string): QueueSource | null;
  completeReserved(id: string): boolean;
  remove(id: string): QueueMutationResult;
  acknowledge(id: string): QueueMutationResult;
  discard(id: string): QueueMutationResult;
  rebind(id: string): QueueMutationResult;
  sendAgain(id: string): QueueMutationResult;
  clearPending(threadId: string): QueueMutationResult;
  releaseHold(): void;
  snapshot(threadId: string): QueueSnapshot;
  acceptsImmediate(threadId: string): boolean;
};

export function createTurnDispatcher(
  database: DatabaseSync,
  emit?: () => void,
): TurnDispatcher {
  const store = createQueuedTurnStore(database);
  let slot: Slot | null = null;
  let hold = false;
  let recovered = false;

  const changed = (): void => emit?.();

  function readyHead(): QueuedTurn | null {
    store.markStaleBranches(Date.now());
    if (hold || slot) return null;
    return store.nextQueuedHead();
  }

  function reserve(item: QueuedTurn): void {
    slot = {
      queueItemId: item.id,
      threadId: item.threadId,
      turnId: null,
      phase: "reserved",
    };
  }

  return {
    recover(): void {
      if (recovered) return;
      recovered = true;
      store.recoverInterrupted(Date.now());
      slot = null;
      hold = store.hasUnfinished();
      if (hold) changed();
    },
    enqueue(input: {
      threadId: string;
      text: string;
      branchAnchor: string | null;
      source: QueueSource;
      attachmentRefs?: AttachmentRef[];
      now?: number;
    }): QueueEnqueueResult {
      if (!store.threadExists(input.threadId)) {
        return { ok: false, summary: "That conversation is not saved yet." };
      }
      const item = store.insert({
        threadId: input.threadId,
        text: input.text,
        branchAnchor: input.branchAnchor,
        source: input.source,
        ...(input.attachmentRefs
          ? { attachmentRefs: input.attachmentRefs }
          : {}),
        now: input.now ?? Date.now(),
      });
      const next = readyHead();
      const stored = store.get(item.id) ?? item;
      if (next?.id === item.id && stored.status === "queued") {
        reserve(stored);
        changed();
        return { ok: true, item: stored, start: true };
      }
      changed();
      return { ok: true, item: stored, start: false };
    },
    claim(threadId: string): QueueClaimResult {
      const next = readyHead();
      if (!next || next.threadId !== threadId) {
        return {
          item: null,
          hold,
          waitingForThreadId:
            next && next.threadId !== threadId ? next.threadId : null,
        };
      }
      reserve(next);
      changed();
      return { item: next, hold: false, waitingForThreadId: null };
    },
    begin(input: {
      queueItemId?: string;
      threadId: string;
      turnId: string;
    }): { ok: true } | { ok: false; summary: string } {
      const now = Date.now();
      if (input.queueItemId) {
        const row = store.get(input.queueItemId);
        if (!row || row.threadId !== input.threadId) {
          return { ok: false, summary: "That queued message is gone." };
        }
        if (slot && slot.queueItemId !== row.id) {
          return { ok: false, summary: "Another turn is still running." };
        }
        if (row.status !== "queued") {
          return {
            ok: false,
            summary: "That queued message is no longer waiting.",
          };
        }
        if (!slot && store.nextQueuedHead()?.id !== row.id) {
          return { ok: false, summary: "That message is not next." };
        }
        if (!store.markRunning(row.id, input.turnId, now)) {
          return {
            ok: false,
            summary: "That queued message is no longer waiting.",
          };
        }
        slot = {
          queueItemId: row.id,
          threadId: row.threadId,
          turnId: input.turnId,
          phase: "running",
        };
        changed();
        return { ok: true };
      }
      if (slot || store.hasUnfinished()) {
        return { ok: false, summary: "Another turn is still waiting." };
      }
      slot = {
        queueItemId: null,
        threadId: input.threadId,
        turnId: input.turnId,
        phase: "running",
      };
      changed();
      return { ok: true };
    },
    complete(turnId: string): void {
      if (!slot || slot.turnId !== turnId || slot.phase === "reserved") return;
      if (slot.queueItemId) {
        store.setStatus(slot.queueItemId, "completed", Date.now());
      }
      slot = null;
      changed();
    },
    fail(turnId: string): void {
      if (!slot || slot.turnId !== turnId) return;
      const id = slot.queueItemId;
      slot = null;
      if (id) store.setStatus(id, "failed", Date.now(), false);
      changed();
    },
    cancelIfRunning(turnId: string): void {
      if (!slot || slot.turnId !== turnId || slot.phase !== "running") return;
      if (slot.queueItemId) {
        store.setStatus(slot.queueItemId, "cancelled", Date.now());
      }
      slot = null;
      changed();
    },
    awaitApproval(turnId: string): void {
      if (!slot || slot.turnId !== turnId || slot.phase !== "running") return;
      if (slot.queueItemId) {
        store.setStatus(slot.queueItemId, "awaiting_approval", Date.now());
      }
      slot = { ...slot, phase: "approval" };
      changed();
    },
    settleApproval(turnId: string): void {
      if (!slot || slot.turnId !== turnId || slot.phase !== "approval") return;
      if (slot.queueItemId) {
        store.setStatus(slot.queueItemId, "completed", Date.now());
      }
      slot = null;
      changed();
    },
    releaseReservation(id: string): void {
      if (!slot || slot.queueItemId !== id || slot.phase !== "reserved") return;
      slot = null;
      changed();
    },
    queuedSource(id: string): QueueSource | null {
      return store.get(id)?.source ?? null;
    },
    completeReserved(id: string): boolean {
      if (!slot || slot.queueItemId !== id || slot.phase !== "reserved") {
        return false;
      }
      const marked = store.setStatus(id, "completed", Date.now());
      slot = null;
      changed();
      return marked;
    },
    remove(id: string): QueueMutationResult {
      const ok = store.cancel(id, Date.now(), ["queued", "pinned"]);
      if (!ok) {
        return { ok: false, summary: "That message can no longer be removed." };
      }
      if (slot?.queueItemId === id && slot.phase === "reserved") slot = null;
      changed();
      return { ok: true, summary: "Removed from the queue." };
    },
    acknowledge(id: string): QueueMutationResult {
      if (!store.acknowledge(id, Date.now())) {
        return { ok: false, summary: "That message is not paused." };
      }
      changed();
      return { ok: true, summary: "Queue resumed." };
    },
    discard(id: string): QueueMutationResult {
      const ok = store.cancel(id, Date.now(), [
        "queued",
        "pinned",
        "failed",
        "interrupted",
      ]);
      if (!ok) {
        return {
          ok: false,
          summary: "That message can no longer be discarded.",
        };
      }
      if (slot?.queueItemId === id && slot.phase === "reserved") slot = null;
      changed();
      return { ok: true, summary: "Discarded." };
    },
    rebind(id: string): QueueMutationResult {
      const row = store.get(id);
      if (!row || row.status !== "pinned") {
        return { ok: false, summary: "That message is not pinned." };
      }
      if (!store.rebind(id, store.headId(row.threadId), Date.now())) {
        return { ok: false, summary: "That message is not pinned." };
      }
      changed();
      return { ok: true, summary: "Rebound to the current branch." };
    },
    sendAgain(id: string): QueueMutationResult {
      if (!store.sendAgain(id, Date.now())) {
        return {
          ok: false,
          summary: "That message is not an interrupted draft.",
        };
      }
      hold = false;
      store.markStaleBranches(Date.now());
      changed();
      return {
        ok: true,
        summary: "The draft will send when the queue reaches it.",
      };
    },
    clearPending(threadId: string): QueueMutationResult {
      const count = store.clearPending(threadId, Date.now());
      if (slot?.threadId === threadId && slot.phase === "reserved") slot = null;
      changed();
      return {
        ok: true,
        summary:
          count === 0 ? "Nothing was pending." : "Cleared the pending queue.",
      };
    },
    releaseHold(): void {
      if (!hold) return;
      hold = false;
      changed();
    },
    snapshot(threadId: string): QueueSnapshot {
      const stale = store.markStaleBranches(Date.now());
      const next = !hold && !slot ? store.nextQueuedHead() : null;
      if (stale) changed();
      return {
        items: store.visible(threadId),
        hold,
        waitingForThreadId:
          next && next.threadId !== threadId ? next.threadId : null,
      };
    },
    acceptsImmediate(threadId: string): boolean {
      if (hold || slot || !store.threadExists(threadId)) return false;
      if (store.visible(threadId).length > 0) return false;
      return store.nextQueuedHead() === null;
    },
  };
}
