import type { AttachmentRef } from "@shared/attachments";

export type QueueEditLock = {
  id: string;
  revision: number;
  token: string;
  threadId: string;
  attachmentRefs: AttachmentRef[];
};

type Listener = () => void;

let current: QueueEditLock | null = null;
const listeners = new Set<Listener>();

export function getQueueEdit(): QueueEditLock | null {
  return current;
}

export function setQueueEdit(next: QueueEditLock | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeQueueEdit(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let skippedHistoryAppends = 0;

export function suppressHistoryAppends(count: number): void {
  skippedHistoryAppends += count;
}

export function takeHistorySuppress(): boolean {
  if (skippedHistoryAppends <= 0) return false;
  skippedHistoryAppends -= 1;
  return true;
}
