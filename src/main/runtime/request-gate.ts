type Job = {
  priority: number;
  order: number;
  run: () => Promise<void>;
};

export type RequestGate = {
  schedule: <T>(priority: number, task: () => Promise<T>) => Promise<T>;
};

/** Lower priority numbers run first. A running request is not preempted. */
export function createRequestGate(): RequestGate {
  let active = false;
  let order = 0;
  const pending: Job[] = [];

  function pump(): void {
    if (active) return;
    pending.sort(
      (left, right) =>
        left.priority - right.priority || left.order - right.order,
    );
    const next = pending.shift();
    if (!next) return;
    active = true;
    void next.run().finally(() => {
      active = false;
      pump();
    });
  }

  function schedule<T>(priority: number, task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      pending.push({
        priority,
        order: order++,
        run: () => task().then(resolve, reject),
      });
      pump();
    });
  }

  return { schedule };
}

export const CHAT_REQUEST_PRIORITY = 0;
export const BACKGROUND_REQUEST_PRIORITY = 1;
