import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActorKind } from "../../shared/action-contract";
import { FILE_MUTATION_LIMITS } from "../../shared/file-mutation";

export type PlanStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "partial"
  | "cancelled"
  | "denied"
  | "expired"
  | "failed"
  | "needs_review";

export type ItemStatus =
  "planned" | "uncertain" | "succeeded" | "failed" | "not_attempted";

export type NewOperationItem = {
  kind: string;
  sourcePath: string | null;
  destinationPath: string | null;
  sourceDisplay: string | null;
  destinationDisplay: string | null;
  content: string | null;
  format: string | null;
  beforeJson: string;
  expectedJson: string;
};

export type StoredPlan = {
  id: string;
  threadId: string;
  turnId: string | null;
  sessionId: string;
  actor: ActorKind;
  actionId: string;
  fingerprint: string;
  scopeGeneration: number;
  status: PlanStatus;
  approval: "auto" | "required";
  risks: string[];
  summary: string;
  errorCode: string | null;
  errorSummary: string | null;
  cancelRequested: boolean;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  finishedAt: number | null;
};

export type StoredOperationItem = NewOperationItem & {
  id: string;
  operationId: string;
  index: number;
  afterJson: string | null;
  status: ItemStatus;
  errorCode: string | null;
  errorSummary: string | null;
};

type PlanRow = {
  id: string;
  thread_id: string;
  turn_id: string | null;
  session_id: string;
  actor: ActorKind;
  action_id: string;
  fingerprint: string;
  scope_generation: number;
  status: PlanStatus;
  approval: "auto" | "required";
  risk_json: string;
  summary: string;
  error_code: string | null;
  error_summary: string | null;
  cancel_requested: number;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  finished_at: number | null;
};

type ItemRow = {
  id: string;
  operation_id: string;
  item_index: number;
  kind: string;
  source_path: string | null;
  destination_path: string | null;
  source_display: string | null;
  destination_display: string | null;
  content: string | null;
  format: string | null;
  before_json: string;
  after_json: string | null;
  expected_json: string;
  status: ItemStatus;
  error_code: string | null;
  error_summary: string | null;
};

function mapPlan(row: PlanRow): StoredPlan {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    actor: row.actor,
    actionId: row.action_id,
    fingerprint: row.fingerprint,
    scopeGeneration: row.scope_generation,
    status: row.status,
    approval: row.approval,
    risks: JSON.parse(row.risk_json) as string[],
    summary: row.summary,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    finishedAt: row.finished_at,
  };
}

function mapItem(row: ItemRow): StoredOperationItem {
  return {
    id: row.id,
    operationId: row.operation_id,
    index: row.item_index,
    kind: row.kind,
    sourcePath: row.source_path,
    destinationPath: row.destination_path,
    sourceDisplay: row.source_display,
    destinationDisplay: row.destination_display,
    content: row.content,
    format: row.format,
    beforeJson: row.before_json,
    afterJson: row.after_json,
    expectedJson: row.expected_json,
    status: row.status,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
  };
}

const PLAN_COLUMNS = `id, thread_id, turn_id, session_id, actor, action_id, fingerprint,
  scope_generation, status, approval, risk_json, summary, error_code, error_summary,
  cancel_requested, created_at, expires_at, decided_at, finished_at`;

// The store shape is exported below as OperationStore.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createOperationStore(database: DatabaseSync) {
  function removePlans(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(", ");
    database
      .prepare(`DELETE FROM operation_items WHERE operation_id IN (${marks})`)
      .run(...ids);
    database
      .prepare(`DELETE FROM operation_plans WHERE id IN (${marks})`)
      .run(...ids);
  }

  function purge(now: number): void {
    const expired = database
      .prepare(
        `SELECT id FROM operation_plans
         WHERE expires_at <= ? AND status IN ('expired', 'denied', 'failed')`,
      )
      .all(now) as { id: string }[];
    removePlans(expired.map((row) => row.id));
    const extra = database
      .prepare(
        `SELECT id FROM operation_plans
         WHERE status IN ('succeeded', 'partial', 'cancelled', 'denied', 'failed', 'expired')
         ORDER BY created_at ASC`,
      )
      .all() as { id: string }[];
    if (extra.length > FILE_MUTATION_LIMITS.maxPlans) {
      removePlans(
        extra
          .slice(0, extra.length - FILE_MUTATION_LIMITS.maxPlans)
          .map((row) => row.id),
      );
    }
    const audit = database
      .prepare(`SELECT id FROM action_audit ORDER BY created_at ASC`)
      .all() as { id: string }[];
    if (audit.length > FILE_MUTATION_LIMITS.maxAuditRows) {
      const drop = audit
        .slice(0, audit.length - FILE_MUTATION_LIMITS.maxAuditRows)
        .map((row) => row.id);
      const marks = drop.map(() => "?").join(", ");
      database
        .prepare(`DELETE FROM action_audit WHERE id IN (${marks})`)
        .run(...drop);
    }
  }

  return {
    purge,
    insert(input: {
      id?: string;
      threadId: string;
      turnId?: string;
      sessionId: string;
      actor: ActorKind;
      actionId: string;
      fingerprint: string;
      scopeGeneration: number;
      approval: "auto" | "required";
      risks: string[];
      summary: string;
      items: NewOperationItem[];
      now: number;
    }): StoredPlan {
      purge(input.now);
      const id = input.id ?? randomUUID();
      const expiresAt = input.now + FILE_MUTATION_LIMITS.planTtlMs;
      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO operation_plans (
               id, thread_id, turn_id, session_id, actor, action_id, fingerprint,
               scope_generation, status, approval, risk_json, summary, cancel_requested,
               created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            id,
            input.threadId,
            input.turnId ?? null,
            input.sessionId,
            input.actor,
            input.actionId,
            input.fingerprint,
            input.scopeGeneration,
            input.approval,
            JSON.stringify(input.risks),
            input.summary,
            input.now,
            expiresAt,
          );
        const insertItem = database.prepare(
          `INSERT INTO operation_items (
             id, operation_id, item_index, kind, source_path, destination_path,
             source_display, destination_display, content, format, before_json,
             expected_json, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
        );
        input.items.forEach((item, index) => {
          insertItem.run(
            randomUUID(),
            id,
            index,
            item.kind,
            item.sourcePath,
            item.destinationPath,
            item.sourceDisplay,
            item.destinationDisplay,
            item.content,
            item.format,
            item.beforeJson,
            item.expectedJson,
          );
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      const stored = this.get(id);
      if (!stored) throw new Error("The operation plan was not stored.");
      return stored;
    },
    get(id: string): StoredPlan | null {
      const row = database
        .prepare(`SELECT ${PLAN_COLUMNS} FROM operation_plans WHERE id = ?`)
        .get(id) as PlanRow | undefined;
      return row ? mapPlan(row) : null;
    },
    items(id: string): StoredOperationItem[] {
      const rows = database
        .prepare(
          `SELECT id, operation_id, item_index, kind, source_path, destination_path,
                  source_display, destination_display, content, format, before_json,
                  after_json, expected_json, status, error_code, error_summary
           FROM operation_items WHERE operation_id = ? ORDER BY item_index ASC`,
        )
        .all(id) as ItemRow[];
      return rows.map(mapItem);
    },
    claim(id: string, now: number): boolean {
      const result = database
        .prepare(
          `UPDATE operation_plans
           SET status = 'executing', decided_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, id);
      return result.changes === 1;
    },
    deny(id: string, now: number): boolean {
      const result = database
        .prepare(
          `UPDATE operation_plans
           SET status = 'denied', decided_at = ?, finished_at = ?, error_code = 'denied'
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, now, id);
      if (result.changes !== 1) return false;
      database
        .prepare(
          `UPDATE operation_items SET status = 'not_attempted'
           WHERE operation_id = ? AND status = 'planned'`,
        )
        .run(id);
      return true;
    },
    requestCancel(id: string): boolean {
      const result = database
        .prepare(
          `UPDATE operation_plans SET cancel_requested = 1
           WHERE id = ? AND status IN ('pending', 'executing')`,
        )
        .run(id);
      return result.changes === 1;
    },
    cancelRequested(id: string): boolean {
      const row = database
        .prepare(`SELECT cancel_requested FROM operation_plans WHERE id = ?`)
        .get(id) as { cancel_requested: number } | undefined;
      return row?.cancel_requested === 1;
    },
    markItem(
      itemId: string,
      patch: {
        status: ItemStatus;
        errorCode?: string | null;
        errorSummary?: string | null;
        afterJson?: string | null;
      },
    ): void {
      database
        .prepare(
          `UPDATE operation_items
           SET status = ?, error_code = ?, error_summary = ?,
               after_json = COALESCE(?, after_json)
           WHERE id = ?`,
        )
        .run(
          patch.status,
          patch.errorCode ?? null,
          patch.errorSummary ?? null,
          patch.afterJson ?? null,
          itemId,
        );
    },
    markRemaining(operationId: string, fromIndex: number): void {
      database
        .prepare(
          `UPDATE operation_items SET status = 'not_attempted'
           WHERE operation_id = ? AND item_index >= ? AND status IN ('planned', 'uncertain')`,
        )
        .run(operationId, fromIndex);
    },
    finish(
      id: string,
      status: PlanStatus,
      code: string | null,
      summary: string,
      now: number,
    ): void {
      database
        .prepare(
          `UPDATE operation_plans
           SET status = ?, error_code = ?, error_summary = ?, summary = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(code ? status : status, code, summary, summary, now, id);
    },
    interruptedIds(): string[] {
      const rows = database
        .prepare(
          `SELECT DISTINCT operation_plans.id
           FROM operation_plans
           LEFT JOIN operation_items ON operation_items.operation_id = operation_plans.id
           WHERE operation_plans.status = 'executing'
              OR operation_items.status = 'uncertain'`,
        )
        .all() as { id: string }[];
      return rows.map((row) => row.id);
    },
    audit(input: {
      actor: ActorKind;
      actionId: string;
      threadId: string;
      requestSummary: string;
      resultSummary: string;
      resultStatus: string;
      resultCode?: string;
      operationId?: string;
      now: number;
    }): void {
      database
        .prepare(
          `INSERT INTO action_audit (
             id, actor, action_id, thread_id, request_summary, result_summary,
             result_status, result_code, operation_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.actor,
          input.actionId,
          input.threadId,
          input.requestSummary.slice(0, 500),
          input.resultSummary.slice(0, 500),
          input.resultStatus,
          input.resultCode ?? null,
          input.operationId ?? null,
          input.now,
        );
    },
    auditsFor(operationId: string): number {
      const row = database
        .prepare(
          `SELECT COUNT(*) AS count FROM action_audit WHERE operation_id = ?`,
        )
        .get(operationId) as { count: number };
      return row.count;
    },
  };
}

export type OperationStore = ReturnType<typeof createOperationStore>;
