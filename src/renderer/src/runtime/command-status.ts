import type { LocalCommandResult } from "@shared/local-commands";

let notice: LocalCommandResult | null = null;
const listeners = new Set<() => void>();

export function publishCommandStatus(next: LocalCommandResult | null): void {
  notice = next;
  for (const listener of listeners) listener();
}

export function subscribeCommandStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readCommandStatus(): LocalCommandResult | null {
  return notice;
}
