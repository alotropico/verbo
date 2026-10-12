import type { ActionResult } from "../../shared/action-contract";

type Waiter = {
  turnId: string;
  resolve: (result: ActionResult) => void;
  reject: (error: Error) => void;
};

const waiters = new Map<string, Waiter>();

export function waitForApproval(
  operationId: string,
  turnId: string,
  signal?: AbortSignal,
): Promise<ActionResult> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      waiters.delete(operationId);
      reject(new DOMException("The turn was cancelled.", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    waiters.set(operationId, {
      turnId,
      resolve: (result) => {
        signal?.removeEventListener("abort", abort);
        waiters.delete(operationId);
        resolve(result);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", abort);
        waiters.delete(operationId);
        reject(error);
      },
    });
  });
}

export function resolveApproval(
  operationId: string,
  result: ActionResult,
): boolean {
  const waiter = waiters.get(operationId);
  if (!waiter) return false;
  waiter.resolve(result);
  return true;
}

export function approvalTurn(operationId: string): string | null {
  return waiters.get(operationId)?.turnId ?? null;
}
