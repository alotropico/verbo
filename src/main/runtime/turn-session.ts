import type { ChatEvent } from "../../shared/chat-ipc";

export type LiveTurn = {
  turnId: string;
  threadId: string;
  queueItemId: string | null;
  assistantMessageId: string;
  userMessageId?: string;
  userText: string;
  operationId: string | null;
  abort: AbortController;
  finalizing?: boolean;
};

type Session = {
  live: LiveTurn;
  events: ChatEvent[];
  listeners: Set<(event: ChatEvent) => void>;
};

const sessions = new Map<string, Session>();
const byThread = new Map<string, string>();
let cancelHandler: ((turnId: string) => void) | null = null;

export function setTurnCancelHandler(
  handler: ((turnId: string) => void) | null,
): void {
  cancelHandler = handler;
}

export function openLiveTurn(live: LiveTurn): void {
  const previous = byThread.get(live.threadId);
  if (previous && previous !== live.turnId) sessions.delete(previous);
  sessions.set(live.turnId, { live, events: [], listeners: new Set() });
  byThread.set(live.threadId, live.turnId);
}

export function publishLive(turnId: string, event: ChatEvent): void {
  const session = sessions.get(turnId);
  if (!session) return;
  const sequence = session.events.length + 1;
  const delivered: ChatEvent = {
    ...event,
    deliveryId: `${turnId}:${sequence}`,
    sequence,
  };
  session.events.push(delivered);
  for (const listener of session.listeners) {
    try {
      listener(delivered);
    } catch {
      session.listeners.delete(listener);
    }
  }
}

export function liveEvents(turnId: string): readonly ChatEvent[] {
  return sessions.get(turnId)?.events ?? [];
}

export function subscribeLive(
  turnId: string,
  listener: (event: ChatEvent) => void,
): () => void {
  const session = sessions.get(turnId);
  if (!session) return () => undefined;
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

export function liveTurnForThread(threadId: string): LiveTurn | null {
  const turnId = byThread.get(threadId);
  if (!turnId) return null;
  return sessions.get(turnId)?.live ?? null;
}

export function noteLiveOperation(turnId: string, operationId: string): void {
  const session = sessions.get(turnId);
  if (session) session.live.operationId = operationId;
}

export function closeLiveTurn(turnId: string): void {
  const session = sessions.get(turnId);
  if (!session) return;
  sessions.delete(turnId);
  if (byThread.get(session.live.threadId) === turnId) {
    byThread.delete(session.live.threadId);
  }
}

export function liveById(turnId: string): LiveTurn | null {
  return sessions.get(turnId)?.live ?? null;
}

export function requestTurnCancel(turnId?: string): boolean {
  const id =
    turnId ??
    [...sessions.keys()].find((key) => {
      const phase = sessions.get(key)?.live;
      return phase !== undefined;
    });
  const session = id ? sessions.get(id) : undefined;
  if (!id || !session) return false;
  if (session.live.finalizing) return false;
  session.live.abort.abort();
  cancelHandler?.(id);
  return true;
}
