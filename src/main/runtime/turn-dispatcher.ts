import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createComposerBufferStore } from "../db/composer-buffer";
import { createQueuedTurnStore } from "../db/queued-turns";
import type { AttachmentRef } from "../../shared/attachments";
import type {
  QueueClaimResult,
  QueueEditResult,
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
  begin(input: { queueItemId?: string; threadId: string; turnId: string }):
    | { ok: true; attached?: boolean; turnId?: string }
    | {
        ok: false;
        summary: string;
      };
  complete(turnId: string): void;
  fail(turnId: string): void;
  cancelIfRunning(turnId: string): void;
  awaitApproval(turnId: string): void;
  settleApproval(turnId: string): void;
  activeTurn(): { turnId: string; phase: Slot["phase"] } | null;
  setServiceHold(message: string | null): void;
  setOnPromoted(handler: ((item: QueuedTurn) => void) | null): void;
  beginEdit(input: {
    id: string;
    threadId: string;
    revision: number;
    composerText: string;
    composerRefs: AttachmentRef[];
  }): QueueEditResult;
  saveEdit(input: {
    id: string;
    threadId: string;
    revision: number;
    token: string;
    text: string;
    attachmentRefs: AttachmentRef[];
  }): QueueEditResult;
  cancelEdit(input: {
    id: string;
    threadId: string;
    token: string;
  }): QueueEditResult;
  reorder(input: {
    id: string;
    threadId: string;
    revision: number;
    direction: "up" | "down";
  }): QueueMutationResult;
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
  const composer = createComposerBufferStore(database);
  let slot: Slot | null = null;
  let hold = false;
  let serviceHold: string | null = null;
  let recovered = false;
  let onPromoted: ((item: QueuedTurn) => void) | null = null;

  const changed = (): void => emit?.();

  function readyHead(): QueuedTurn | null {
    store.markStaleBranches(Date.now());
    if (hold || serviceHold || slot) return null;
    return store.nextQueuedHead();
  }

  function promote(): void {
    const next = readyHead();
    if (!next) return;
    reserve(next);
    changed();
    onPromoted?.(next);
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
      hold = store.hasInterrupted();
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
      if (hold) hold = false;
      const next = readyHead();
      const stored = store.get(item.id) ?? item;
      if (next?.id === item.id && stored.status === "queued") {
        reserve(stored);
        changed();
        return { ok: true, item: stored, start: true };
      }
      changed();
      promote();
      return { ok: true, item: stored, start: false };
    },
    claim(threadId: string): QueueClaimResult {
      if (
        slot?.threadId === threadId &&
        slot.phase === "reserved" &&
        slot.queueItemId
      ) {
        return {
          item: store.get(slot.queueItemId),
          hold: false,
          waitingForThreadId: null,
        };
      }
      if (slot && slot.threadId !== threadId) {
        return { item: null, hold, waitingForThreadId: slot.threadId };
      }
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
    begin(input: { queueItemId?: string; threadId: string; turnId: string }):
      | { ok: true; attached?: boolean; turnId?: string }
      | {
          ok: false;
          summary: string;
        } {
      const now = Date.now();
      if (input.queueItemId) {
        const row = store.get(input.queueItemId);
        if (!row || row.threadId !== input.threadId) {
          return { ok: false, summary: "That queued message is gone." };
        }
        if (slot && slot.queueItemId !== row.id) {
          return { ok: false, summary: "Another turn is still running." };
        }
        if (
          slot &&
          slot.queueItemId === row.id &&
          slot.turnId &&
          slot.phase !== "reserved"
        ) {
          return { ok: true, attached: true, turnId: slot.turnId };
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
      promote();
    },
    fail(turnId: string): void {
      if (!slot || slot.turnId !== turnId) return;
      const id = slot.queueItemId;
      slot = null;
      if (id) store.setStatus(id, "failed", Date.now(), false);
      changed();
    },
    cancelIfRunning(turnId: string): void {
      if (
        !slot ||
        slot.turnId !== turnId ||
        (slot.phase !== "running" && slot.phase !== "approval")
      ) {
        return;
      }
      if (slot.queueItemId) {
        store.setStatus(slot.queueItemId, "cancelled", Date.now());
      }
      slot = null;
      changed();
      promote();
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
        store.setStatus(slot.queueItemId, "running", Date.now());
      }
      slot = { ...slot, phase: "running" };
      changed();
    },
    activeTurn(): { turnId: string; phase: Slot["phase"] } | null {
      if (!slot?.turnId || slot.phase === "reserved") return null;
      return { turnId: slot.turnId, phase: slot.phase };
    },
    setServiceHold(message: string | null): void {
      serviceHold = message;
      changed();
      if (!message) promote();
    },
    setOnPromoted(handler: ((item: QueuedTurn) => void) | null): void {
      onPromoted = handler;
    },
    beginEdit(input): QueueEditResult {
      if (slot?.queueItemId === input.id) {
        return {
          ok: false,
          summary: "That message already started.",
        };
      }
      const row = store.get(input.id);
      if (!row || row.threadId !== input.threadId) {
        return { ok: false, summary: "That queued message is gone." };
      }
      if (row.status === "editing" && row.editToken) {
        const kept = composer.read(input.threadId);
        return {
          ok: true,
          item: row,
          composerText: kept?.text ?? "",
          composerRefs: kept?.attachmentRefs ?? [],
        };
      }
      const now = Date.now();
      if (!store.beginEdit(input.id, randomUUID(), input.revision, now)) {
        return {
          ok: false,
          summary: "That message can no longer be edited.",
        };
      }
      composer.keep(
        input.threadId,
        input.composerText,
        input.composerRefs,
        now,
      );
      const saved = store.get(input.id);
      if (!saved?.editToken) {
        return { ok: false, summary: "That message can no longer be edited." };
      }
      changed();
      return {
        ok: true,
        item: saved,
        composerText: input.composerText,
        composerRefs: input.composerRefs,
      };
    },
    saveEdit(input): QueueEditResult {
      const now = Date.now();
      if (
        !store.saveEdit({
          id: input.id,
          token: input.token,
          revision: input.revision,
          text: input.text,
          attachmentRefs: input.attachmentRefs,
          now,
        })
      ) {
        return {
          ok: false,
          summary: "That edit is out of date. Reload the queue and try again.",
        };
      }
      const saved = store.get(input.id);
      const restored = composer.take(input.threadId);
      changed();
      if (!slot && !hold && !serviceHold) promote();
      if (!saved) {
        return { ok: false, summary: "That queued message is gone." };
      }
      return {
        ok: true,
        item: saved,
        composerText: restored.text,
        composerRefs: restored.attachmentRefs,
      };
    },
    cancelEdit(input): QueueEditResult {
      const now = Date.now();
      if (!store.cancelEdit(input.id, input.token, now)) {
        return { ok: false, summary: "That edit is no longer open." };
      }
      const saved = store.get(input.id);
      const restored = composer.take(input.threadId);
      changed();
      if (!saved) {
        return { ok: false, summary: "That queued message is gone." };
      }
      return {
        ok: true,
        item: saved,
        composerText: restored.text,
        composerRefs: restored.attachmentRefs,
      };
    },
    reorder(input): QueueMutationResult {
      const row = store.get(input.id);
      if (!row || row.threadId !== input.threadId) {
        return { ok: false, summary: "That queued message is gone." };
      }
      if (slot?.queueItemId === input.id) {
        return { ok: false, summary: "That message already started." };
      }
      if (
        !store.reorder(input.id, input.direction, input.revision, Date.now())
      ) {
        return {
          ok: false,
          summary: "That message can no longer be reordered.",
        };
      }
      changed();
      return { ok: true, summary: "Queue order updated." };
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
      const row = store.get(id);
      const editing = row?.status === "editing" ? row.threadId : null;
      const ok = store.cancel(id, Date.now(), [
        "queued",
        "editing",
        "pinned",
        "failed",
        "interrupted",
      ]);
      if (!ok) {
        return { ok: false, summary: "That message can no longer be removed." };
      }
      if (slot?.queueItemId === id && slot.phase === "reserved") slot = null;
      const restored = editing ? composer.take(editing) : null;
      changed();
      return {
        ok: true,
        summary: "Removed from the queue.",
        ...(restored
          ? {
              composerText: restored.text,
              composerRefs: restored.attachmentRefs,
            }
          : {}),
      };
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
      promote();
    },
    snapshot(threadId: string): QueueSnapshot {
      const outgoingId =
        slot?.threadId === threadId &&
        slot.phase === "reserved" &&
        slot.queueItemId
          ? slot.queueItemId
          : null;
      const stale = outgoingId
        ? store.markStaleBranches(Date.now(), outgoingId)
        : store.markStaleBranches(Date.now());
      const next =
        !hold && !serviceHold && !slot ? store.nextQueuedHead() : null;
      if (stale) changed();
      const reservedElsewhere =
        slot && slot.threadId !== threadId ? slot.threadId : null;
      return {
        items: store.visible(threadId),
        outgoingId,
        hold,
        waitingForThreadId:
          reservedElsewhere ??
          (next && next.threadId !== threadId ? next.threadId : null),
        serviceHold,
      };
    },
    acceptsImmediate(threadId: string): boolean {
      if (hold || serviceHold || slot || !store.threadExists(threadId))
        return false;
      if (store.visible(threadId).length > 0) return false;
      return store.nextQueuedHead() === null;
    },
  };
}
