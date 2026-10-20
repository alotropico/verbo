import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ActionResult } from "../../shared/action-contract";
import type { MemoryFailure, MemoryStore, MemorySuccess } from "../db/memory";
import type { RootStore } from "../db/registered-roots";
import type { ScopeStore } from "../db/scopes";
import { aloCallSync } from "./client";
import { aloContext } from "./context";
import type { BridgeRequest } from "./contracts";

export function aloData<T>(
  method: BridgeRequest["method"],
  args: unknown = {},
  threadId = "alo-settings",
): T {
  const result = aloCallSync({
    method,
    args,
    context: { actor: "ui", threadId },
  });
  if (
    method !== "operations.decide" &&
    result &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "error" &&
    "summary" in result
  )
    throw new Error(String(result.summary));
  return result as T;
}
export function createAloMemoryStore(
  database: DatabaseSync,
  budget: number,
): MemoryStore {
  const read = <T>(operation: string, args: unknown): T =>
    aloData("memory.store", { operation, args });
  const mutate = (
    action: string,
    args: Record<string, unknown>,
    actor: "model" | "ui" | "user_command",
    threadId = "settings",
    turnId?: string,
  ): MemorySuccess | MemoryFailure => {
    const result = aloCallSync({
      method: "invoke",
      name: action,
      args,
      context: aloContext(
        { actor, threadId, ...(turnId ? { turnId } : {}) },
        database,
        args,
      ),
    }) as ActionResult;
    if (result.status !== "success")
      return {
        ok: false,
        code: result.code ?? result.status,
        summary: result.summary,
      };
    const identified = z.object({ id: z.string() }).safeParse(result.data);
    const entry = identified.success
      ? read<ReturnType<MemoryStore["get"]>>("get", {
          ids: [identified.data.id],
        })[0]
      : undefined;
    return { ok: true, summary: result.summary, ...(entry ? { entry } : {}) };
  };
  return {
    budget,
    list: (filter) => read("list", filter),
    get: (ids) => read("get", { ids }),
    usage: (audience) => read("usage", { audience }),
    recentChanges: (limit) => read("changes", { limit }),
    snapshot: (threadId, audience) =>
      aloData("memory.snapshot", { threadId, audience }),
    add: ({ actor, originThreadId, originTurnId, ...args }) =>
      mutate(
        "memory.add",
        args,
        actor,
        originThreadId ?? args.threadId,
        originTurnId,
      ),
    update: ({ actor, ...args }) => mutate("memory.update", args, actor),
    remove: (id, actor) => mutate("memory.remove", { id }, actor),
  };
}
export function createAloScopeStore(database: DatabaseSync): ScopeStore {
  type ScopeRead = {
    scopes: ReturnType<ScopeStore["list"]>;
    generation: number;
    grants: ReturnType<ScopeStore["activeGrants"]>;
  };
  const read = (): ScopeRead => aloData<ScopeRead>("settings.scopes.read");
  return {
    list: () => read().scopes,
    generation: () => read().generation,
    activeGrants: () => read().grants,
    // Presentation of the existing optional picker choice stays in Verbo. Nothing is registered here.
    proposal: (root = process.cwd()) => {
      const path = join(root, ".tmp");
      return {
        alias: "tmp",
        path,
        saved: read().scopes.some(
          (scope) =>
            scope.aliases.includes("tmp") ||
            scope.path.toLowerCase() === path.toLowerCase(),
        ),
      };
    },
    apply: (args) => aloData("settings.scopes.apply", args),
    issueReadGrant: ({ actor, ...args }) =>
      aloCallSync({
        method: "settings.scopes.grant",
        args,
        context: aloContext(
          { actor, threadId: args.threadId ?? "file-selection" },
          database,
          args,
        ),
      }) as ReturnType<ScopeStore["issueReadGrant"]>,
  };
}
export function createAloRootStore(
  table: "registered_projects" | "ags_hosts",
): RootStore {
  const kind = table === "registered_projects" ? "projects" : "ags-hosts";
  return {
    list: () => aloData(`settings.${kind}.list`),
    add: (alias, path) => aloData(`settings.${kind}.add`, { alias, path }),
    remove: (id) => aloData(`settings.${kind}.remove`, { id }),
  };
}
export function aloExecutionReceipts(
  database: DatabaseSync,
  executionId: string,
  threadId: string,
): { id: string; result: unknown }[] {
  const receiptIds = database
    .prepare(
      "SELECT receipt_id FROM workflow_action_attempts WHERE execution_id=? ORDER BY created_at LIMIT 1000",
    )
    .all(executionId)
    .map((row) => String(row.receipt_id));
  return aloData("receipts.execution", { executionId, receiptIds }, threadId);
}
export function settleAloApproval(
  database: DatabaseSync,
  operationId: string,
  result: ActionResult,
): void {
  const state = [
    "effect_uncertain",
    "receipt_failed",
    "needs_review",
    "needs_reconciliation",
  ].includes(result.code ?? "")
    ? "uncertain"
    : result.status === "requires_confirmation"
      ? "dispatched"
      : ["error", "denied", "not_supported", "cancelled"].includes(
            result.status,
          )
        ? "blocked"
        : "completed";
  database
    .prepare(
      "UPDATE workflow_action_attempts SET state=?,operation_id=coalesce(?,operation_id),updated_at=? WHERE receipt_id=? AND state IN ('claimed','dispatched')",
    )
    .run(state, result.operationId ?? null, Date.now(), operationId);
}

/** Reconcile app-owned attempt state from typed receipts, without replaying effects. */
export function reconcileAloAttempts(database: DatabaseSync): void {
  const attempts = database
    .prepare(
      "SELECT attempt.id,attempt.receipt_id,attempt.execution_id,execution.thread_id FROM workflow_action_attempts AS attempt JOIN workflow_executions AS execution ON execution.id=attempt.execution_id WHERE attempt.state='dispatched'",
    )
    .all();
  const groups = new Map<string, Map<string, ActionResult>>();
  for (const attempt of attempts) {
    const executionId = String(attempt.execution_id);
    if (groups.has(executionId)) continue;
    try {
      groups.set(
        executionId,
        new Map(
          aloExecutionReceipts(
            database,
            executionId,
            String(attempt.thread_id),
          ).map((receipt) => [receipt.id, receipt.result as ActionResult]),
        ),
      );
    } catch {
      groups.set(executionId, new Map());
    }
  }
  const states = attempts.map((attempt) => {
    const result = groups
      .get(String(attempt.execution_id))
      ?.get(String(attempt.receipt_id));
    let state = "uncertain";
    if (
      result &&
      ![
        "effect_uncertain",
        "receipt_failed",
        "needs_review",
        "needs_reconciliation",
      ].includes(result.code ?? "")
    ) {
      if (result.status === "requires_confirmation") {
        if (!result.operationId) return { id: String(attempt.id), state };
        try {
          const review = aloData<{ ok: boolean; status?: string }>(
            "operations.review",
            { operationId: result.operationId },
            String(attempt.thread_id),
          );
          state =
            review.ok && review.status === "pending" ? "blocked" : "uncertain";
        } catch {
          /* Unknown effects remain uncertain. */
        }
      } else
        state =
          result.status === "success" || result.status === "partial"
            ? "completed"
            : "blocked";
    }
    return { id: String(attempt.id), state };
  });
  database.exec("BEGIN");
  try {
    for (const row of states)
      database
        .prepare(
          "UPDATE workflow_action_attempts SET state=?,updated_at=? WHERE id=? AND state='dispatched'",
        )
        .run(row.state, Date.now(), row.id);
    database
      .prepare(
        "UPDATE workflow_executions SET status='suspended',reason='restart_requires_review',revision=revision+1,updated_at=? WHERE status='running'",
      )
      .run(Date.now());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
