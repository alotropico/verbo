import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  actionResultSchema,
  type ActionResult,
} from "../../shared/action-contract";
import { evaluateTrace } from "../../shared/execution-trace";
import {
  verifiedOutcomeSchema,
  type VerifiedOutcome,
} from "../../shared/workflows";
import { aloExecutionReceipts } from "../alo/data-client";
import type { WorkflowExecution } from "../db/workflow-executions";

const LISTED_PATHS = "Listed paths:\n";

/** Preserve query facts from verified receipts instead of trusting model prose. */
export function commandResultFindings(result: ActionResult): string[] {
  const findings = [result.summary.slice(0, 2000)];
  if (
    !["files.list", "files.search", "files.next"].includes(result.action) ||
    !["success", "partial"].includes(result.status)
  )
    return findings;
  try {
    const detail = JSON.parse(result.detail ?? "{}");
    const paths: unknown[] = Array.isArray(detail.paths)
      ? detail.paths
      : Array.isArray(detail.items)
        ? detail.items
            .filter(
              (item: { type?: string }) =>
                item && ["directory", "file"].includes(item.type ?? ""),
            )
            .map((item: { path?: unknown }) => item.path)
        : [];
    let group = LISTED_PATHS;
    for (const path of paths) {
      if (typeof path !== "string" || path.length > 1024) continue;
      const line = path + "\n";
      if (group.length + line.length > 1900) {
        findings.push(group.trimEnd());
        group = LISTED_PATHS;
      }
      group += line;
    }
    if (group !== LISTED_PATHS) findings.push(group.trimEnd());
  } catch {
    /* A malformed detail never supplies facts. */
  }
  return findings;
}

/** Finished reads need no input for a completion statement or an extra summary. */
export function isListingCompletionStatement(
  result: ActionResult | undefined,
  text: string,
  request = "",
): boolean {
  if (
    !result ||
    result.status !== "success" ||
    !["files.list", "files.search", "files.next"].includes(result.action)
  )
    return false;
  const trimmed = text.trim();
  const completion =
    /^(?:(?:the|all|your)\s+)?(?:(?:directory|directories|folder|folders|file|files|list|listing|query|search|task|work|request)\s+){0,3}(?:(?:is|are|has been|have been)\s+)?(?:complete|completed|done|finished|listed)\b/iu.exec(
      trimmed,
    );
  const completionStatement =
    completion &&
    !trimmed.slice(completion[0].length).trimStart().startsWith("?");
  // A summary offer is additional work, not a parameter needed by the completed query.
  // Keep it when the user explicitly requested a question or confirmation.
  const summaryOffer =
    !/\b(?:ask|question|confirm)\b/iu.test(request) &&
    /^(?:would you like|do you (?:want|need))\s+(?:me to (?:provide|give|show|write)\s+)?(?:a|an|the)\s+(?:summary|overview|breakdown|explanation)\s+(?:of|for|about)\s+(?:(?:the|this|your)\s+)?(?:directory|folder|file|listing|results|structure)\b/iu.test(
      trimmed,
    );
  if (!completionStatement && !summaryOffer) return false;
  try {
    const detail = JSON.parse(result.detail ?? "{}");
    return detail.page?.hasMore === false && detail.scan?.complete === true;
  } catch {
    return false;
  }
}

export function freezeWorkflowOutcome(
  database: DatabaseSync,
  execution: WorkflowExecution,
): VerifiedOutcome {
  const receipts = aloExecutionReceipts(
    database,
    execution.id,
    execution.threadId,
  ).map((receipt) => ({
    id: receipt.id,
    result: actionResultSchema.parse(receipt.result),
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
  const trace = evaluateTrace({
    turnId: execution.id,
    calls: receipts.map((receipt, order) => ({
      id: receipt.id,
      toolName: "actions.invoke",
      order,
      result: receipt.result,
      uncertainAttempt:
        uncertain.includes(receipt.id) &&
        receipt.result.status !== "requires_confirmation",
    })),
    workflow: {
      executionId: execution.id,
      workflowId: execution.workflowId,
      status: execution.status,
    },
    clock: { assumeReady: true },
    ...(result?.status === "awaiting_input"
      ? { question: result.question.text }
      : {}),
  });
  const root = trace.nodes.find((node) => node.kind === "workflow");
  const status =
    execution.status === "awaiting_input"
      ? "awaiting_input"
      : execution.status === "cancelled" || root?.outcome === "cancelled"
        ? "cancelled"
        : root?.outcome === "succeeded"
          ? "completed"
          : root?.outcome === "partial"
            ? "partial"
            : root?.outcome === "failed"
              ? "failed"
              : "blocked";
  return Object.freeze(
    verifiedOutcomeSchema.parse({
      version: 1,
      executionId: execution.id,
      workflowId: execution.workflowId,
      status,
      requestMessageId: execution.requestMessageId,
      findings: receipts
        .flatMap(({ result }) => commandResultFindings(result))
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
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();
export type WorkflowPresentation = z.infer<typeof presentationSchema>;

export const PRESENTATION_INSTRUCTION =
  "Write a short chat reply from this readable report. Use one to three paragraphs. Phrase the status, findings, errors, and question; do not invent effects, paths, or counts. If question is present, ask it verbatim. If uncertainty is true, say those effects are uncertain and will not be replayed. Do not include identifiers, receipt ids, execution ids, or step ids. Return JSON with only a text field.";

/** Admit phrasing that keeps the required question and leaks no diagnostic identifier. */
export function validatePresentation(
  outcome: VerifiedOutcome,
  candidate: unknown,
): string | undefined {
  const parsed = presentationSchema.safeParse(candidate);
  if (!parsed.success) return;
  const text = parsed.data.text;
  if (
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(
      text,
    )
  )
    return;
  const identifiers = [
    outcome.executionId,
    ...outcome.receiptIds,
    ...outcome.uncertainReceiptIds,
  ].filter((id) => id.length >= 8);
  if (identifiers.some((id) => text.toLowerCase().includes(id.toLowerCase())))
    return;
  if (outcome.question && !text.includes(outcome.question.text)) return;
  for (const finding of outcome.findings) {
    if (!finding.startsWith(LISTED_PATHS)) continue;
    if (
      finding
        .slice(LISTED_PATHS.length)
        .split("\n")
        .some((path) => !text.includes(path))
    )
      return;
  }
  return text;
}

/** Model-facing facts. Diagnostic identifiers stay out of this object. */
export function readableReportInput(outcome: VerifiedOutcome): {
  status: VerifiedOutcome["status"];
  findings: string[];
  errors: string[];
  question?: string;
  uncertainty: boolean;
} {
  const identifiers = [
    outcome.executionId,
    ...outcome.receiptIds,
    ...outcome.uncertainReceiptIds,
  ];
  const visible = (value: string): boolean =>
    !identifiers.some((id) => id.length >= 8 && value.includes(id));
  return {
    status: outcome.status,
    findings: outcome.findings.filter(visible),
    errors: outcome.errors.map((error) => error.summary).filter(visible),
    ...(outcome.question ? { question: outcome.question.text } : {}),
    uncertainty: outcome.uncertainReceiptIds.length > 0,
  };
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
