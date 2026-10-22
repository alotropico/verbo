import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ActionResult } from "../../shared/action-contract";
import type { MemoryFailure, MemoryStore, MemorySuccess } from "../db/memory";
import type { RootStore } from "../db/registered-roots";
import type { ScopeStore } from "../db/scopes";
import { aloCall } from "./client";
import type { AsyncMethods } from "./async";
import { aloContext } from "./context";
import type { BridgeRequest } from "./contracts";

/** UI reads and writes must not block Electron while Alo opens its database. */
export async function aloData<T>(method: BridgeRequest["method"], args: unknown = {}, threadId = "alo-settings"): Promise<T> {
  const result = await aloCall({
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
export const aloDataAsync = aloData;
export function createAloMemoryStore(database: DatabaseSync, budget: number): AsyncMethods<MemoryStore> {
  const read = async <T>(operation: string, args: unknown): Promise<T> => await aloData("memory.store", { operation, args });
  const mutate = async (
    action: string,
    args: Record<string, unknown>,
    actor: "model" | "ui" | "user_command",
    threadId = "settings",
    turnId?: string,
  ): Promise<MemorySuccess | MemoryFailure> => {
    const result = (await aloCall({
      method: "invoke",
      name: action,
      args,
      context: aloContext({ actor, threadId, ...(turnId ? { turnId } : {}) }, database, args),
    })) as ActionResult;
    if (result.status !== "success")
      return {
        ok: false,
        code: result.code ?? result.status,
        summary: result.summary,
      };
    const identified = z.object({ id: z.string() }).safeParse(result.data);
    const entry = identified.success
      ? (
          await read<ReturnType<MemoryStore["get"]>>("get", {
            ids: [identified.data.id],
          })
        )[0]
      : undefined;
    return { ok: true, summary: result.summary, ...(entry ? { entry } : {}) };
  };
  return {
    budget,
    list: (filter) => read("list", filter),
    get: (ids) => read("get", { ids }),
    usage: (audience) => read("usage", { audience }),
    recentChanges: (limit) => read("changes", { limit }),
    snapshot: async (threadId, audience) => await aloData("memory.snapshot", { threadId, audience }),
    add: ({ actor, originThreadId, originTurnId, ...args }) =>
      mutate("memory.add", args, actor, originThreadId ?? args.threadId, originTurnId),
    update: ({ actor, ...args }) => mutate("memory.update", args, actor),
    remove: (id, actor) => mutate("memory.remove", { id }, actor),
  };
}
export function createAloScopeStore(database: DatabaseSync): AsyncMethods<ScopeStore> {
  type ScopeRead = {
    scopes: ReturnType<ScopeStore["list"]>;
    generation: number;
    grants: ReturnType<ScopeStore["activeGrants"]>;
  };
  const read = async (): Promise<ScopeRead> => await aloData<ScopeRead>("settings.scopes.read");
  return {
    list: async () => (await read()).scopes,
    generation: async () => (await read()).generation,
    activeGrants: async () => (await read()).grants,
    // Presentation of the existing optional picker choice stays in Verbo. Nothing is registered here.
    proposal: async (root = process.cwd()) => {
      const path = join(root, ".tmp");
      return {
        alias: "tmp",
        path,
        saved: (await read()).scopes.some((scope) => scope.aliases.includes("tmp") || scope.path.toLowerCase() === path.toLowerCase()),
      };
    },
    apply: async (args) => await aloData("settings.scopes.apply", args),
    issueReadGrant: async ({ actor, ...args }) =>
      (await aloCall({
        method: "settings.scopes.grant",
        args,
        context: aloContext({ actor, threadId: args.threadId ?? "file-selection" }, database, args),
      })) as ReturnType<ScopeStore["issueReadGrant"]>,
  };
}
export function createAloRootStore(table: "registered_projects" | "ags_hosts"): AsyncMethods<RootStore> {
  const kind = table === "registered_projects" ? "projects" : "ags-hosts";
  return {
    list: async () => await aloData(`settings.${kind}.list`),
    add: async (alias, path) => await aloData(`settings.${kind}.add`, { alias, path }),
    remove: async (id) => await aloData(`settings.${kind}.remove`, { id }),
  };
}
export async function aloExecutionReceipts(
  database: DatabaseSync,
  executionId: string,
  threadId: string,
): Promise<{ id: string; result: unknown }[]> {
  const receiptIds = database
    .prepare("SELECT receipt_id FROM workflow_action_attempts WHERE execution_id=? ORDER BY created_at LIMIT 1000")
    .all(executionId)
    .map((row) => String(row.receipt_id));
  return await aloData("receipts.execution", { executionId, receiptIds }, threadId);
}
export function settleAloApproval(database: DatabaseSync, operationId: string, result: ActionResult): void {
  const state = ["effect_uncertain", "receipt_failed", "needs_review", "needs_reconciliation"].includes(result.code ?? "")
    ? "uncertain"
    : result.status === "requires_confirmation"
      ? "dispatched"
      : ["error", "denied", "not_supported", "cancelled"].includes(result.status)
        ? "blocked"
        : "completed";
  database
    .prepare(
      "UPDATE workflow_action_attempts SET state=?,operation_id=coalesce(?,operation_id),updated_at=? WHERE receipt_id=? AND state IN ('claimed','dispatched')",
    )
    .run(state, result.operationId ?? null, Date.now(), operationId);
}

/** Reconcile app-owned attempt state from typed receipts, without replaying effects. */
export async function reconcileAloAttempts(database: DatabaseSync): Promise<void> {
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
          (await aloExecutionReceipts(database, executionId, String(attempt.thread_id))).map((receipt) => [
            receipt.id,
            receipt.result as ActionResult,
          ]),
        ),
      );
    } catch {
      groups.set(executionId, new Map());
    }
  }
  const states: { id: string; state: string }[] = [];
  for (const attempt of attempts) {
    const result = groups.get(String(attempt.execution_id))?.get(String(attempt.receipt_id));
    let state = "uncertain";
    if (result && !["effect_uncertain", "receipt_failed", "needs_review", "needs_reconciliation"].includes(result.code ?? "")) {
      if (result.status === "requires_confirmation") {
        if (!result.operationId) {
          states.push({ id: String(attempt.id), state });
          continue;
        }
        try {
          const review = await aloData<{ ok: boolean; status?: string }>(
            "operations.review",
            { operationId: result.operationId },
            String(attempt.thread_id),
          );
          state = review.ok && review.status === "pending" ? "blocked" : "uncertain";
        } catch {
          /* Unknown effects remain uncertain. */
        }
      } else state = result.status === "success" || result.status === "partial" ? "completed" : "blocked";
    }
    states.push({ id: String(attempt.id), state });
  }
  database.exec("BEGIN");
  try {
    for (const row of states)
      database
        .prepare("UPDATE workflow_action_attempts SET state=?,updated_at=? WHERE id=? AND state='dispatched'")
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
