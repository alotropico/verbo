import type { LatestInteraction } from "../../../shared/chat-ipc";

const STORAGE_KEY = "verbo:latest-exchange";

let interaction: LatestInteraction | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as LatestInteraction;
    if (
      typeof parsed?.assistantMessageId === "string" &&
      Array.isArray(parsed.rounds)
    ) {
      interaction = parsed;
    }
  } catch {
    interaction = null;
  }
}

export function rememberLatestExchange(value: LatestInteraction): void {
  hydrated = true;
  interaction = value;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  for (const listener of listeners) listener();
}

export function readLatestExchange(): LatestInteraction | null {
  hydrate();
  return interaction;
}

export function subscribeLatestExchange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
