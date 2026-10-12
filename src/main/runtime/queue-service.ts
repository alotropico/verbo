import { getDatabase } from "../db/database";
import { createTurnDispatcher, type TurnDispatcher } from "./turn-dispatcher";

const listeners = new Set<() => void>();
let singleton: TurnDispatcher | null = null;

export function subscribeTurnQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function turnDispatcher(): TurnDispatcher {
  if (!singleton) {
    singleton = createTurnDispatcher(getDatabase(), () => {
      for (const listener of listeners) listener();
    });
    singleton.recover();
  }
  return singleton;
}
