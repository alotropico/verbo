import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../shared/action-contract";
import type { OperationReview, OperationReviewFailure } from "../../shared/file-mutation";
import { aloData, settleAloApproval } from "../alo/data-client";
import { aloCall, AloCallError } from "../alo/client";
import type { ScopeStore } from "../db/scopes";
import type { AsyncMethods } from "../alo/async";
type OperationInput = {
  database: DatabaseSync;
  scopes?: ScopeStore | AsyncMethods<ScopeStore>;
  operationId: string;
  threadId: string;
  sessionId?: string;
  signal?: AbortSignal;
};
export async function reviewOperation(input: OperationInput): Promise<OperationReview | OperationReviewFailure> {
  return await aloData("operations.review", { operationId: input.operationId }, input.threadId);
}
export async function abandonPendingPlan(_database: DatabaseSync, operationId: string, threadId?: string): Promise<void> {
  if (!threadId) throw new Error("Cancellation needs its trusted thread ID.");
  await aloData("operations.abandon", { operationId }, threadId);
}
export async function decideOperation(input: OperationInput & { decision: "approve" | "deny" }): Promise<ActionResult> {
  let result: ActionResult;
  try {
    result = (await aloCall(
      {
        method: "operations.decide",
        args: { operationId: input.operationId, decision: input.decision },
        context: { actor: "ui", threadId: input.threadId },
      },
      input.signal,
    )) as ActionResult;
  } catch (error) {
    const dispatched = !(error instanceof AloCallError) || error.dispatched;
    const cancelled = input.signal?.aborted || (error instanceof AloCallError && error.code === "cancelled");
    result = {
      action: "operations.decide",
      operationId: input.operationId,
      receiptId: input.operationId,
      status: dispatched ? "partial" : cancelled ? "cancelled" : "error",
      code: dispatched ? "effect_uncertain" : cancelled ? "cancelled" : "alo_unavailable",
      summary: dispatched
        ? "Alo did not return the approval result. Inspect the operation before retrying; changes may be partial."
        : cancelled
          ? "The approval was cancelled before dispatch."
          : "Alo could not accept the approval. No approval effect was dispatched.",
    };
  }
  settleAloApproval(input.database, input.operationId, result);
  return result;
}
export async function cancelOperation(input: OperationInput): Promise<boolean> {
  return (await aloData<{ ok: boolean }>("operations.cancel", { operationId: input.operationId }, input.threadId)).ok;
}
