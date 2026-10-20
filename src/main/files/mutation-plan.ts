import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../shared/action-contract";
import type {
  OperationReview,
  OperationReviewFailure,
} from "../../shared/file-mutation";
import { aloData, settleAloApproval } from "../alo/data-client";
import type { ScopeStore } from "../db/scopes";
type OperationInput = {
  database: DatabaseSync;
  scopes?: ScopeStore;
  operationId: string;
  threadId: string;
  sessionId?: string;
};
export function reviewOperation(
  input: OperationInput,
): OperationReview | OperationReviewFailure {
  return aloData(
    "operations.review",
    { operationId: input.operationId },
    input.threadId,
  );
}
export function abandonPendingPlan(
  _database: DatabaseSync,
  operationId: string,
  threadId?: string,
): void {
  if (!threadId) throw new Error("Cancellation needs its trusted thread ID.");
  aloData("operations.abandon", { operationId }, threadId);
}
export async function decideOperation(
  input: OperationInput & { decision: "approve" | "deny" },
): Promise<ActionResult> {
  const result = aloData<ActionResult>(
    "operations.decide",
    { operationId: input.operationId, decision: input.decision },
    input.threadId,
  );
  settleAloApproval(input.database, input.operationId, result);
  return result;
}
export function cancelOperation(input: OperationInput): boolean {
  return aloData<{ ok: boolean }>(
    "operations.cancel",
    { operationId: input.operationId },
    input.threadId,
  ).ok;
}
