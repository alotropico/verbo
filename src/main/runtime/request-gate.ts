type Job = {
  priority: number;
  order: number;
  run: () => Promise<void>;
};

export type RequestGate = {
  schedule: <T>(
    priority: number,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
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

  function schedule<T>(
    priority: number,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let started = false;
      const onAbort = (): void => {
        if (started) return;
        const index = pending.indexOf(job);
        if (index >= 0) pending.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      const job: Job = {
        priority,
        order: order++,
        run: () => {
          started = true;
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(signal.reason);
            return Promise.resolve();
          }
          return Promise.resolve().then(task).then(resolve, reject);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.push(job);
      pump();
    });
  }

  return { schedule };
}

export const CHAT_REQUEST_PRIORITY = 0;
export const BACKGROUND_REQUEST_PRIORITY = 1;
