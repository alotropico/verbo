import { randomUUID } from "node:crypto";

const PICK_TTL_MS = 15 * 60 * 1000;

type PendingPick = {
  path: string;
  expiresAt: number;
};

const picks = new Map<string, PendingPick>();

export function rememberPick(path: string, now = Date.now()): string {
  const id = randomUUID();
  picks.set(id, { path, expiresAt: now + PICK_TTL_MS });
  return id;
}

export function consumePick(id: string, now = Date.now()): string | null {
  const found = picks.get(id);
  picks.delete(id);
  if (!found || found.expiresAt <= now) return null;
  return found.path;
}

export function resetPicks(): void {
  picks.clear();
}
