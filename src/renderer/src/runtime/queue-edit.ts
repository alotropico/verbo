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

export function getQueueEdit(threadId?: string): QueueEditLock | null {
  return threadId === undefined || current?.threadId === threadId
    ? current
    : null;
}

export function setQueueEdit(next: QueueEditLock | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function clearQueueEdit(lock: QueueEditLock): void {
  if (current?.id === lock.id && current.token === lock.token)
    setQueueEdit(null);
}

const composerRestores = new Map<string, string>();
export function keepQueueComposerRestore(threadId: string, text: string): void {
  composerRestores.set(threadId, text);
}
export function takeQueueComposerRestore(threadId: string): string | undefined {
  const text = composerRestores.get(threadId);
  composerRestores.delete(threadId);
  return text;
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
