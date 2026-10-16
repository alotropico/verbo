import type { DatabaseSync } from "node:sqlite";
import { validQuestionAnswer } from "../../shared/workflows";
import type { GlobalDecision } from "../agents/decision";
import {
  createWorkflowExecutionStore,
  type WorkflowExecution,
} from "../db/workflow-executions";

export function executionOnBranch(
  database: DatabaseSync,
  executionId: string,
  threadId: string,
  head: string | undefined,
): boolean {
  const finals = new Set(
    database
      .prepare(
        "SELECT assistant_message_id FROM workflow_execution_turns WHERE execution_id=?",
      )
      .all(executionId)
      .map((row) => String(row.assistant_message_id)),
  );
  const seen = new Set<string>();
  let cursor = head;
  while (cursor && !seen.has(cursor)) {
    if (finals.has(cursor)) return true;
    seen.add(cursor);
    const row = database
      .prepare("SELECT parent_id FROM messages WHERE thread_id=? AND id=?")
      .get(threadId, cursor);
    if (!row) return false;
    cursor = row.parent_id === null ? undefined : String(row.parent_id);
  }
  return false;
}

export function applyExecutionDisposition(input: {
  database: DatabaseSync;
  threadId: string;
  branchHead?: string;
  disposition: Exclude<GlobalDecision, { kind: "new" } | { kind: "clarify" }>;
  queuedInterruption: boolean;
  definitionVersion: number;
}): WorkflowExecution {
  const store = createWorkflowExecutionStore(input.database);
  const execution = store.read(input.disposition.executionId);
  if (
    !execution ||
    execution.threadId !== input.threadId ||
    !executionOnBranch(
      input.database,
      execution.id,
      input.threadId,
      input.branchHead,
    )
  )
    throw new Error("Execution does not belong to this conversation branch.");
  if (execution.revision !== input.disposition.expectedRevision)
    throw new Error(
      "Execution revision changed. Review the latest pending state.",
    );
  if (!["awaiting_input", "suspended"].includes(execution.status))
    throw new Error("Execution is no longer awaiting continuation.");
  if (
    execution.definitionVersion !== input.definitionVersion ||
    execution.stateSchemaVersion !== 1
  ) {
    store.update(execution.id, execution.revision, {
      status: "suspended",
      checkpoint: execution.checkpoint,
      reason: "version_mismatch",
    });
    throw new Error(
      "Execution version requires review; its meaning will not be migrated silently.",
    );
  }
  if (input.disposition.kind === "cancel")
    return store.update(execution.id, execution.revision, {
      status: "cancelled",
      checkpoint: { ...execution.checkpoint, status: "cancelled" },
      reason: "user_cancelled",
    });
  if (input.disposition.kind === "suspend" || input.queuedInterruption)
    return store.update(execution.id, execution.revision, {
      status: "suspended",
      checkpoint: execution.checkpoint,
      reason: input.queuedInterruption
        ? "queued_interruption"
        : "user_suspended",
    });
  const parameters = { ...execution.parameters };
  const question = execution.question;
  if (question) {
    const answer =
      ("answer" in input.disposition ? input.disposition.answer : undefined) ??
      (!question.required ? question.default : undefined);
    if (!validQuestionAnswer(question, answer))
      throw new Error(
        "The answer does not match the pending question's declared contract.",
      );
    parameters.answers = {
      ...(typeof parameters.answers === "object" && parameters.answers !== null
        ? parameters.answers
        : {}),
      [question.binding]: answer,
    };
  }
  const attempts = store.attempts(execution.id);
  if (
    attempts.some(
      (attempt) =>
        attempt.state === "uncertain" || attempt.state === "dispatched",
    )
  )
    throw new Error(
      "Dispatched effects require reconciliation before continuation. Existing effects will not be replayed.",
    );
  return store.update(execution.id, execution.revision, {
    status: "running",
    checkpoint: { ...execution.checkpoint, status: "running" },
    parameters,
    reason: "resumed",
  });
}
