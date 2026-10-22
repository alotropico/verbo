import type { DatabaseSync } from "node:sqlite";
import { actionResultSchema } from "../../shared/action-contract";
import { aloData } from "../alo/data-client";
import { CommandFailure } from "../capabilities/command-failure";
import { commandFingerprint } from "../capabilities/preparation";
import { createWorkflowExecutionStore } from "../db/workflow-executions";
import type { InvocationPolicy } from "./policy";

export function createActionLedger(input: {
  database: DatabaseSync;
  executionId: string;
  stepRunId: string;
  resuming: boolean;
  preconditions: Record<string, unknown>;
}): NonNullable<InvocationPolicy["ledger"]> {
  const store = createWorkflowExecutionStore(input.database);
  const previous = store.attempts(input.executionId).filter((attempt) => attempt.step_run_id === input.stepRunId);
  let ordinal = previous.reduce((max, attempt) => Math.max(max, Number(attempt.ordinal) + 1), 0);
  return {
    async before(action, args, kind) {
      const digest = commandFingerprint(args);
      if (input.resuming && kind === "mutation") {
        if (previous.some((attempt) => attempt.state === "uncertain" || attempt.state === "dispatched"))
          throw new CommandFailure(
            "needs_reconciliation",
            "A prior effect is uncertain. Inspect its receipts and environment before any new mutation.",
          );
        const completed = previous.find(
          (attempt) => attempt.action_id === action && attempt.args_digest === digest && attempt.state === "completed",
        );
        if (completed) {
          const thread = input.database.prepare("SELECT thread_id FROM workflow_executions WHERE id=?").get(input.executionId);
          const remote = thread
            ? await aloData<{ result: unknown } | null>(
                "receipts.read",
                { receiptId: String(completed.receipt_id) },
                String(thread.thread_id),
              )
            : undefined;
          const row = remote ? { result_json: JSON.stringify(remote.result) } : undefined;
          if (!row) throw new CommandFailure("receipt_missing", "The completed mutation's receipt is missing; it must not be replayed.");
          return {
            id: String(completed.id),
            receiptId: String(completed.receipt_id),
            replay: actionResultSchema.parse(JSON.parse(String(row.result_json))),
          };
        }
      }
      const claim = store.claimAttempt({
        executionId: input.executionId,
        stepRunId: input.stepRunId,
        ordinal: ordinal++,
        actionId: action,
        digest,
        preconditions: input.preconditions,
      });
      if (!claim.fresh) throw new CommandFailure("attempt_conflict", "This attempt slot is already claimed and needs reconciliation.");
      store.transitionAttempt(claim.id, "claimed", "dispatched");
      return claim;
    },
    after(claim, result) {
      // Receipt persistence is authoritative and normally settles this in its transaction.
      // A missing receipt after dispatch remains uncertain rather than permitting replay.
      const state = ["receipt_failed", "effect_uncertain", "needs_review", "needs_reconciliation"].includes(result.code ?? "")
        ? "uncertain"
        : result.status === "requires_confirmation"
          ? "dispatched"
          : result.status === "success" || result.status === "partial"
            ? "completed"
            : "blocked";
      input.database
        .prepare(
          "UPDATE workflow_action_attempts SET state=?,operation_id=coalesce(?,operation_id),updated_at=? WHERE id=? AND state='dispatched'",
        )
        .run(state, result.operationId ?? null, Date.now(), claim.id);
    },
  };
}
