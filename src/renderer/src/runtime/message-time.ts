const sentAt = new Map<string, number>();
const listeners = new Set<() => void>();

export function rememberMessageTime(id: string, at: number): void {
  if (!Number.isFinite(at) || sentAt.get(id) === at) return;
  sentAt.set(id, at);
  listeners.forEach((listener) => listener());
}

export function messageSentAt(id: string | undefined): number | undefined {
  if (!id) return undefined;
  return sentAt.get(id);
}

export function subscribeMessageTimes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
