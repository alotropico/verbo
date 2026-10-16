import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { actionResultSchema } from "../../shared/action-contract";
import {
  verifiedOutcomeSchema,
  type VerifiedOutcome,
} from "../../shared/workflows";
import type { WorkflowExecution } from "../db/workflow-executions";

export function freezeWorkflowOutcome(
  database: DatabaseSync,
  execution: WorkflowExecution,
): VerifiedOutcome {
  const receipts = database
    .prepare(
      `SELECT DISTINCT receipt.id,receipt.result_json FROM command_receipts AS receipt
    LEFT JOIN workflow_action_attempts AS attempt ON attempt.receipt_id=receipt.id
    WHERE attempt.execution_id=? OR json_extract(receipt.attribution_json,'$.executionId')=? ORDER BY receipt.started_at LIMIT 100`,
    )
    .all(execution.id, execution.id)
    .map((row) => ({
      id: String(row.id),
      result: actionResultSchema.parse(JSON.parse(String(row.result_json))),
    }));
  const attempts = database
    .prepare(
      "SELECT state,receipt_id FROM workflow_action_attempts WHERE execution_id=?",
    )
    .all(execution.id);
  const uncertain = [
    ...new Set(
      attempts
        .filter(
          (attempt) =>
            attempt.state === "dispatched" || attempt.state === "uncertain",
        )
        .map((attempt) => String(attempt.receipt_id)),
    ),
  ];
  const successes = receipts.filter(
    (receipt) =>
      receipt.result.status === "success" ||
      receipt.result.status === "partial",
  );
  const failures = receipts.filter((receipt) =>
    ["error", "denied", "not_supported", "cancelled"].includes(
      receipt.result.status,
    ),
  );
  const result = execution.checkpoint.result;
  const errors = failures.map(({ result }) => ({
    code: result.code ?? result.status,
    summary: result.summary.slice(0, 2000),
  }));
  if (
    result &&
    result.status !== "succeeded" &&
    result.status !== "awaiting_input" &&
    !errors.some((error) => error.code === result.code)
  )
    errors.push({ code: result.code, summary: result.summary });
  const noEvidence =
    execution.workflowId !== "conversational" &&
    execution.status === "completed" &&
    receipts.length === 0;
  if (noEvidence)
    errors.push({
      code: "no_verified_results",
      summary: "No registered command has a verified receipt for this request.",
    });
  const status =
    execution.status === "awaiting_input"
      ? "awaiting_input"
      : execution.status === "cancelled"
        ? "cancelled"
        : noEvidence
          ? "blocked"
          : uncertain.length || failures.length
            ? successes.length
              ? "partial"
              : "blocked"
            : execution.status === "completed"
              ? "completed"
              : execution.status === "failed"
                ? successes.length
                  ? "partial"
                  : "failed"
                : "blocked";
  return Object.freeze(
    verifiedOutcomeSchema.parse({
      version: 1,
      executionId: execution.id,
      workflowId: execution.workflowId,
      status,
      requestMessageId: execution.requestMessageId,
      findings: receipts
        .map(({ result }) => result.summary.slice(0, 2000))
        .slice(0, 30),
      ...(result?.status === "awaiting_input"
        ? { question: result.question }
        : {}),
      receiptIds: receipts.map((receipt) => receipt.id),
      uncertainReceiptIds: uncertain,
      errors: errors.slice(0, 30),
    }),
  );
}

export const presentationSchema = z
  .object({
    status: verifiedOutcomeSchema.shape.status,
    receiptIds: z.array(z.string()).max(100),
    sentences: z
      .array(
        z
          .object({
            text: z.string().min(1).max(1000),
            findingIndex: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(10),
    question: z.string().max(2000).optional(),
  })
  .strict();
export type WorkflowPresentation = z.infer<typeof presentationSchema>;

/** Conservative prose admission: every statement must use a frozen finding verbatim. */
export function validatePresentation(
  outcome: VerifiedOutcome,
  candidate: unknown,
): string | undefined {
  const parsed = presentationSchema.safeParse(candidate);
  if (!parsed.success) return;
  const value = parsed.data;
  if (
    value.status !== outcome.status ||
    value.receiptIds.some((id) => !outcome.receiptIds.includes(id)) ||
    new Set(value.receiptIds).size !== value.receiptIds.length
  )
    return;
  if (outcome.question?.text !== value.question) return;
  if (!value.sentences.length && !value.question) return;
  if (
    value.sentences.some(
      (sentence) => outcome.findings[sentence.findingIndex] !== sentence.text,
    )
  )
    return;
  if (
    outcome.errors.length &&
    !value.sentences.some((sentence) =>
      outcome.errors.some((error) => error.summary === sentence.text),
    )
  )
    return;
  if (outcome.uncertainReceiptIds.length) return;
  return [...value.sentences.map((sentence) => sentence.text), value.question]
    .filter(Boolean)
    .join("\n\n");
}

export function deterministicPresentation(outcome: VerifiedOutcome): string {
  const status = {
    completed: "The requested work completed.",
    awaiting_input: "The workflow is waiting for your input.",
    partial: "Some work completed; the remaining work needs attention.",
    blocked: "The workflow could not complete.",
    failed: "The workflow stopped with an error.",
    cancelled: "You stopped the workflow. Completed effects are retained.",
  }[outcome.status];
  return [
    status,
    ...outcome.findings,
    ...outcome.errors
      .filter((error) => !outcome.findings.includes(error.summary))
      .map((error) => error.summary),
    ...(outcome.uncertainReceiptIds.length
      ? [
          "Some dispatched effects are uncertain. Inspect their receipts before retrying; they will not be replayed automatically.",
        ]
      : []),
    outcome.question?.text,
  ]
    .filter(Boolean)
    .join("\n\n");
}
