import type { LatestInteraction } from "../../../shared/chat-ipc";

const STORAGE_KEY = "verbo:latest-exchange";

const byThread = new Map<string, LatestInteraction>();
const jsonByThread = new Map<string, string>();
let hydrated = false;
const listeners = new Set<() => void>();

function isInteraction(value: unknown): value is LatestInteraction {
  if (!value || typeof value !== "object") return false;
  const row = value as LatestInteraction;
  return (
    typeof row.assistantMessageId === "string" &&
    typeof row.threadId === "string" &&
    Array.isArray(row.rounds)
  );
}

function rememberLocal(value: LatestInteraction): void {
  byThread.set(value.threadId, value);
  jsonByThread.set(value.threadId, JSON.stringify(value, null, 2));
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (isInteraction(parsed)) {
      rememberLocal(parsed);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    for (const value of Object.values(parsed)) {
      if (isInteraction(value)) rememberLocal(value);
    }
  } catch {
    byThread.clear();
    jsonByThread.clear();
  }
}

function persist(): void {
  const payload: Record<string, LatestInteraction> = {};
  for (const [threadId, value] of byThread) payload[threadId] = value;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function rememberLatestExchange(value: LatestInteraction): void {
  hydrated = true;
  rememberLocal(value);
  persist();
  for (const listener of listeners) listener();
}

export function readThreadInteraction(
  threadId: string,
): LatestInteraction | null {
  hydrate();
  return byThread.get(threadId) ?? null;
}

export function interactionJson(threadId: string): string | null {
  hydrate();
  return jsonByThread.get(threadId) ?? null;
}

export function subscribeLatestExchange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
