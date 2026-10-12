export function timestampMs(value: unknown): number {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : 0;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
  }
  return 0;
}

type Activity = {
  at: number;
  count: number;
};

const activity = new Map<string, Activity>();
const listeners = new Set<() => void>();

export function noteThreadActivity(
  threadId: string,
  at: number,
  count: number,
): void {
  const current = activity.get(threadId);
  if (current?.at === at && current.count === count) return;
  activity.set(threadId, { at, count });
  listeners.forEach((listener) => listener());
}

export function threadActivity(threadId: string): Activity | undefined {
  return activity.get(threadId);
}

export function subscribeThreadActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
