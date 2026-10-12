import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActionHistoryEntry } from "../../shared/actions-overview";

type AuditRow = {
  action_id: string;
  actor: string;
  result_status: string;
  result_summary: string;
  result_code: string | null;
  created_at: number;
};

export function recentActionAudits(
  database: DatabaseSync,
  limit = 40,
): ActionHistoryEntry[] {
  const rows = database
    .prepare(
      `SELECT action_id, actor, result_status, result_summary, result_code, created_at
       FROM action_audit
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as AuditRow[];
  return rows.map((row) => ({
    actionId: row.action_id,
    actor: row.actor,
    status: row.result_status,
    summary: row.result_summary,
    ...(row.result_code ? { code: row.result_code } : {}),
    createdAt: row.created_at,
  }));
}

export function recordActionAudit(
  database: DatabaseSync,
  input: {
    actor: string;
    actionId: string;
    request: string;
    summary: string;
    status: string;
    code?: string;
    now?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO action_audit (
         id, actor, action_id, thread_id, request_summary, result_summary,
         result_status, result_code, operation_id, created_at
       ) VALUES (?, ?, ?, 'settings', ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      randomUUID(),
      input.actor,
      input.actionId,
      input.request.slice(0, 240),
      input.summary.slice(0, 240),
      input.status,
      input.code ?? null,
      input.now ?? Date.now(),
    );
}
