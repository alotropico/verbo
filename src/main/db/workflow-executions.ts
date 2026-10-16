import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  executionStatusSchema,
  verifiedOutcomeSchema,
  type ExecutionSummary,
  type VerifiedOutcome,
  type StepResult,
} from "../../shared/workflows";
import type { WorkflowCheckpoint } from "../workflows/interpreter";

const checkpointSchema = z
  .object({
    currentStepId: z.string().nullable(),
    outputs: z.record(z.string(), z.unknown()),
    status: z.enum([
      "running",
      "completed",
      "awaiting_input",
      "failed",
      "cancelled",
    ]),
    result: z.unknown().optional(),
  })
  .strict();
export type WorkflowExecution = ExecutionSummary & {
  stateSchemaVersion: number;
  requestMessageId: string;
  threadId: string;
  parameters: Record<string, unknown>;
  targets: Record<string, unknown>;
  currentStepRunId: string | null;
  checkpoint: WorkflowCheckpoint;
  outcome?: VerifiedOutcome;
};

function compact(value: unknown, limit = 64_000): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit)
    throw new Error(
      "Workflow checkpoint is too large; retain content through managed references.",
    );
  return json;
}

export function createWorkflowExecutionStore(database: DatabaseSync): {
  read: (id: string) => WorkflowExecution | undefined;
  update: (
    id: string,
    revision: number,
    patch: {
      status: WorkflowExecution["status"];
      checkpoint: WorkflowCheckpoint;
      reason?: string;
      outcome?: VerifiedOutcome;
      parameters?: Record<string, unknown>;
      targets?: Record<string, unknown>;
      currentStepRunId?: string | null;
    },
  ) => WorkflowExecution;
  create(input: {
    id?: string;
    workflowId: string;
    definitionVersion: number;
    threadId: string;
    branchAnchorId: string | null;
    requestMessageId: string;
    parameters: Record<string, unknown>;
    firstStepId: string;
    targets?: Record<string, unknown>;
  }): WorkflowExecution;
  list(threadId: string): WorkflowExecution[];
  linkTurn(input: {
    executionId: string;
    turnId: string;
    userMessageId: string;
    assistantMessageId: string;
    relation: "start" | "resume" | "clarify" | "cancel";
  }): void;
  beginStep(
    execution: WorkflowExecution,
    stepId: string,
    turnId: string,
    schemaId: string,
  ): { execution: WorkflowExecution; stepRunId: string };
  settle(
    execution: WorkflowExecution,
    checkpoint: WorkflowCheckpoint,
  ): WorkflowExecution;
  claimAttempt(input: {
    executionId: string;
    stepRunId: string;
    ordinal: number;
    actionId: string;
    digest: string;
    preconditions: Record<string, unknown>;
    receiptId?: string;
  }): { id: string; receiptId: string; state: string; fresh: boolean };
  transitionAttempt(
    id: string,
    from: "claimed" | "dispatched",
    to: "dispatched" | "completed" | "blocked" | "uncertain",
    operationId?: string,
  ): void;
  attempts(
    executionId: string,
  ): Record<string, import("node:sqlite").SQLOutputValue>[];
  pin(executionId: string, attachmentId: string): void;
  reconcileInterrupted(): void;
  result(stepRunId: string): StepResult | undefined;
} {
  function read(id: string): WorkflowExecution | undefined {
    const row = database
      .prepare("SELECT * FROM workflow_executions WHERE id=?")
      .get(id);
    if (!row) return;
    const checkpoint = checkpointSchema.parse(
      JSON.parse(String(row.checkpoint_json)),
    ) as WorkflowCheckpoint;
    return {
      id: String(row.id),
      workflowId: String(row.workflow_id),
      definitionVersion: Number(row.definition_version),
      stateSchemaVersion: Number(row.state_schema_version),
      threadId: String(row.thread_id),
      branchAnchorId:
        row.branch_anchor_id === null ? null : String(row.branch_anchor_id),
      requestMessageId: String(row.request_message_id),
      revision: Number(row.revision),
      status: executionStatusSchema.parse(row.status),
      currentStepId:
        row.current_step_id === null ? null : String(row.current_step_id),
      currentStepRunId:
        row.current_step_run_id === null
          ? null
          : String(row.current_step_run_id),
      parameters: JSON.parse(String(row.parameters_json)),
      targets: JSON.parse(String(row.targets_json)),
      checkpoint,
      ...(row.outcome_json
        ? {
            outcome: verifiedOutcomeSchema.parse(
              JSON.parse(String(row.outcome_json)),
            ),
          }
        : {}),
      ...(checkpoint.result?.status === "awaiting_input"
        ? { question: checkpoint.result.question }
        : {}),
      ...(row.reason ? { reason: String(row.reason) } : {}),
    };
  }
  function transaction<T>(task: () => T): T {
    database.exec("SAVEPOINT workflow_state");
    try {
      const result = task();
      database.exec("RELEASE workflow_state");
      return result;
    } catch (error) {
      database.exec("ROLLBACK TO workflow_state; RELEASE workflow_state");
      throw error;
    }
  }
  function update(
    id: string,
    revision: number,
    patch: {
      status: WorkflowExecution["status"];
      checkpoint: WorkflowCheckpoint;
      reason?: string;
      outcome?: VerifiedOutcome;
      parameters?: Record<string, unknown>;
      targets?: Record<string, unknown>;
      currentStepRunId?: string | null;
    },
  ): WorkflowExecution {
    const current = read(id);
    if (!current || current.revision !== revision)
      throw new Error("Execution revision conflict.");
    const result = database
      .prepare(
        `UPDATE workflow_executions SET status=?, checkpoint_json=?, current_step_id=?,
      current_step_run_id=?, reason=?, outcome_json=?, parameters_json=?, targets_json=?, revision=revision+1,updated_at=? WHERE id=? AND revision=?`,
      )
      .run(
        patch.status,
        compact(patch.checkpoint),
        patch.checkpoint.currentStepId,
        patch.currentStepRunId === undefined
          ? current.currentStepRunId
          : patch.currentStepRunId,
        patch.reason ?? null,
        patch.outcome
          ? compact(verifiedOutcomeSchema.parse(patch.outcome))
          : current.outcome
            ? compact(current.outcome)
            : null,
        compact(patch.parameters ?? current.parameters),
        compact(patch.targets ?? current.targets),
        Date.now(),
        id,
        revision,
      );
    if (result.changes !== 1) throw new Error("Execution revision conflict.");
    return read(id)!;
  }
  return {
    read,
    update,
    create(input: {
      id?: string;
      workflowId: string;
      definitionVersion: number;
      threadId: string;
      branchAnchorId: string | null;
      requestMessageId: string;
      parameters: Record<string, unknown>;
      firstStepId: string;
      targets?: Record<string, unknown>;
    }): WorkflowExecution {
      const id = input.id ?? randomUUID();
      const checkpoint: WorkflowCheckpoint = {
        currentStepId: input.firstStepId,
        outputs: {},
        status: "running",
      };
      database
        .prepare(
          `INSERT INTO workflow_executions(id,workflow_id,definition_version,thread_id,branch_anchor_id,request_message_id,parameters_json,targets_json,current_step_id,checkpoint_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'running',?,?)`,
        )
        .run(
          id,
          input.workflowId,
          input.definitionVersion,
          input.threadId,
          input.branchAnchorId,
          input.requestMessageId,
          compact(input.parameters),
          compact(input.targets ?? {}),
          input.firstStepId,
          compact(checkpoint),
          Date.now(),
          Date.now(),
        );
      return read(id)!;
    },
    list(threadId: string): WorkflowExecution[] {
      return database
        .prepare(
          "SELECT id FROM workflow_executions WHERE thread_id=? ORDER BY updated_at DESC LIMIT 50",
        )
        .all(threadId)
        .map((row) => read(String(row.id))!);
    },
    linkTurn(input: {
      executionId: string;
      turnId: string;
      userMessageId: string;
      assistantMessageId: string;
      relation: "start" | "resume" | "clarify" | "cancel";
    }): void {
      database
        .prepare(
          "INSERT INTO workflow_execution_turns VALUES(?,?,?,?,?,?) ON CONFLICT(execution_id,turn_id) DO NOTHING",
        )
        .run(
          input.executionId,
          input.turnId,
          input.userMessageId,
          input.assistantMessageId,
          input.relation,
          Date.now(),
        );
    },
    beginStep(
      execution: WorkflowExecution,
      stepId: string,
      turnId: string,
      schemaId: string,
    ): { execution: WorkflowExecution; stepRunId: string } {
      return transaction(() => {
        const current = read(execution.id);
        if (
          !current ||
          current.revision !== execution.revision ||
          current.currentStepId !== stepId ||
          current.status !== "running"
        )
          throw new Error("Stale or inactive step claim.");
        if (current.currentStepRunId)
          return { execution: current, stepRunId: current.currentStepRunId };
        const stepRunId = randomUUID();
        const count = database
          .prepare(
            "SELECT COUNT(*) AS total FROM workflow_step_results WHERE execution_id=? AND step_id=?",
          )
          .get(current.id, stepId);
        database
          .prepare(
            "INSERT INTO workflow_step_results(id,execution_id,step_id,ordinal,turn_id,schema_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?)",
          )
          .run(
            stepRunId,
            current.id,
            stepId,
            Number(count?.total ?? 0),
            turnId,
            schemaId,
            Date.now(),
            Date.now(),
          );
        return {
          execution: update(current.id, current.revision, {
            status: "running",
            checkpoint: current.checkpoint,
            currentStepRunId: stepRunId,
          }),
          stepRunId,
        };
      });
    },
    settle(
      execution: WorkflowExecution,
      checkpoint: WorkflowCheckpoint,
    ): WorkflowExecution {
      return transaction(() => {
        const result = checkpoint.result;
        if (!result || !execution.currentStepRunId)
          throw new Error("No active step result to settle.");
        const current = read(execution.id);
        if (!current || current.revision !== execution.revision)
          throw new Error("Execution revision conflict.");
        database
          .prepare(
            "UPDATE workflow_step_results SET status=?, result_json=?, updated_at=? WHERE id=? AND execution_id=?",
          )
          .run(
            result.status,
            compact(result),
            Date.now(),
            execution.currentStepRunId,
            execution.id,
          );
        return update(execution.id, execution.revision, {
          status: checkpoint.status,
          checkpoint,
          currentStepRunId:
            result.status === "awaiting_input"
              ? execution.currentStepRunId
              : null,
        });
      });
    },
    claimAttempt(input: {
      executionId: string;
      stepRunId: string;
      ordinal: number;
      actionId: string;
      digest: string;
      preconditions: Record<string, unknown>;
      receiptId?: string;
    }) {
      return transaction(() => {
        const execution = read(input.executionId);
        if (
          !execution ||
          execution.status !== "running" ||
          execution.currentStepRunId !== input.stepRunId
        )
          throw new Error("Action attempt has no active trusted step.");
        const prior = database
          .prepare(
            "SELECT * FROM workflow_action_attempts WHERE execution_id=? AND step_run_id=? AND ordinal=?",
          )
          .get(input.executionId, input.stepRunId, input.ordinal);
        if (prior) {
          if (
            prior.action_id !== input.actionId ||
            prior.args_digest !== input.digest
          )
            throw new Error(
              "Attempt slot is bound to a different action; explicit reconciliation is required.",
            );
          return {
            id: String(prior.id),
            receiptId: String(prior.receipt_id),
            state: String(prior.state),
            fresh: false,
          };
        }
        const id = randomUUID();
        const receiptId = input.receiptId ?? randomUUID();
        database
          .prepare(
            "INSERT INTO workflow_action_attempts VALUES(?,?,?,?,?,?,?,'claimed',?,NULL,?,?)",
          )
          .run(
            id,
            input.executionId,
            input.stepRunId,
            input.ordinal,
            input.actionId,
            input.digest,
            compact(input.preconditions),
            receiptId,
            Date.now(),
            Date.now(),
          );
        return { id, receiptId, state: "claimed", fresh: true };
      });
    },
    transitionAttempt(
      id: string,
      from: "claimed" | "dispatched",
      to: "dispatched" | "completed" | "blocked" | "uncertain",
      operationId?: string,
    ): void {
      const result = database
        .prepare(
          "UPDATE workflow_action_attempts SET state=?,operation_id=coalesce(?,operation_id),updated_at=? WHERE id=? AND state=?",
        )
        .run(to, operationId ?? null, Date.now(), id, from);
      if (result.changes !== 1)
        throw new Error("Action attempt transition conflict.");
    },
    attempts(executionId: string) {
      return database
        .prepare(
          "SELECT * FROM workflow_action_attempts WHERE execution_id=? ORDER BY created_at,ordinal",
        )
        .all(executionId);
    },
    pin(executionId: string, attachmentId: string): void {
      if (
        !database
          .prepare(
            "SELECT 1 FROM attachments JOIN workflow_executions ON workflow_executions.id=? WHERE attachments.id=? AND attachments.thread_id=workflow_executions.thread_id",
          )
          .get(executionId, attachmentId)
      )
        throw new Error(
          "Workflow content does not belong to this conversation or is unavailable.",
        );
      database
        .prepare(
          "INSERT INTO workflow_content_refs VALUES(?,?) ON CONFLICT DO NOTHING",
        )
        .run(executionId, attachmentId);
    },
    reconcileInterrupted(): void {
      transaction(() => {
        database
          .prepare(
            `UPDATE workflow_action_attempts SET state=CASE
              WHEN NOT EXISTS(SELECT 1 FROM command_receipts WHERE id=workflow_action_attempts.receipt_id) THEN 'uncertain'
              WHEN (SELECT json_extract(result_json,'$.code') FROM command_receipts WHERE id=workflow_action_attempts.receipt_id) IN ('effect_uncertain','receipt_failed') THEN 'uncertain'
              WHEN (SELECT json_extract(result_json,'$.status') FROM command_receipts WHERE id=workflow_action_attempts.receipt_id)='requires_confirmation' THEN
                CASE WHEN EXISTS(SELECT 1 FROM operation_plans WHERE id=workflow_action_attempts.operation_id AND status='pending') THEN 'blocked' ELSE 'uncertain' END
              WHEN (SELECT json_extract(result_json,'$.status') FROM command_receipts WHERE id=workflow_action_attempts.receipt_id) IN ('success','partial') THEN 'completed'
              ELSE 'blocked' END,updated_at=? WHERE state='dispatched'`,
          )
          .run(Date.now());
        database
          .prepare(
            "UPDATE workflow_executions SET status='suspended',reason='restart_requires_review',revision=revision+1,updated_at=? WHERE status='running'",
          )
          .run(Date.now());
      });
    },
    result(stepRunId: string): StepResult | undefined {
      const row = database
        .prepare("SELECT result_json FROM workflow_step_results WHERE id=?")
        .get(stepRunId);
      return row?.result_json
        ? (JSON.parse(String(row.result_json)) as StepResult)
        : undefined;
    },
  };
}
