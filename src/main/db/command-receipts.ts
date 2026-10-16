import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../shared/action-contract";
import {
  commandResourceSchema,
  type CommandReceipt,
  type CommandResource,
} from "../../shared/command-receipts";
import type { ActionContext } from "../capabilities/registry";
import { createOperationStore } from "./operations";
import { finalizeCommandResources } from "../files/resource-events";
import { createScopeStore } from "./scopes";
import { resolveFileReference } from "../files/path-policy";
import { lstatSync } from "node:fs";
import { readLiveReferences, saveLiveReferences } from "../files/asset-store";
import { activeInvocation } from "../agents/policy";

export function persistCommandReceipt(
  database: DatabaseSync,
  input: {
    result: ActionResult;
    context: ActionContext;
    startedAt: number;
    resources: CommandResource[];
  },
): ActionResult {
  const { result, context } = input;
  const id =
    result.operationId ?? result.receiptId ?? context.receiptId ?? randomUUID();
  const native = result.operationId
    ? createOperationStore(database).items(result.operationId)
    : [];
  const resources = [...input.resources];
  for (const item of native) {
    if (item.status !== "succeeded") continue;
    if (item.kind === "copy" && item.sourcePath)
      resources.push({ path: item.sourcePath, event: "read", available: true });
    if (item.kind === "trash" && item.sourcePath)
      resources.push({
        path: item.sourcePath,
        event: "remove",
        available: false,
      });
    else {
      const path =
        item.kind === "edit" ? item.sourcePath : item.destinationPath;
      if (path)
        resources.push({
          path,
          event:
            item.kind === "move" || item.kind === "rename" ? "move" : "write",
          available: true,
          ...(item.sourcePath ? { from: item.sourcePath } : {}),
        });
    }
  }
  const finalized = finalizeCommandResources(resources).map((resource) =>
    commandResourceSchema.parse(resource),
  );
  const projected = {
    ...result,
    receiptId: id,
    resourceCount: finalized.length,
  };
  // Compact facts survive native plan pruning; file contents/undo payloads stay
  // in the native plan service and never enter this durable chat projection.
  const children = native.map((item) => ({
    index: item.index,
    kind: item.kind,
    from: item.sourceDisplay,
    to: item.destinationDisplay,
    status: item.status,
    code: item.errorCode,
    summary: item.errorSummary,
  }));
  database.exec("SAVEPOINT command_receipt");
  try {
    database
      .prepare(
        `INSERT INTO command_receipts
    (id, action_id, thread_id, turn_id, actor, result_json, children_json, started_at, finished_at, parent_receipt_id, attribution_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET result_json=excluded.result_json, children_json=excluded.children_json,
      finished_at=excluded.finished_at`,
      )
      .run(
        id,
        result.action,
        context.threadId,
        context.turnId ?? null,
        context.actor,
        JSON.stringify(projected),
        JSON.stringify(children),
        input.startedAt,
        Date.now(),
        context.parentReceiptId ?? null,
        (context.attribution ?? activeInvocation()?.attribution)
          ? JSON.stringify(
              context.attribution ?? activeInvocation()?.attribution,
            )
          : null,
      );
    saveLiveReferences(database, id, context.threadId, finalized);
    database
      .prepare(
        `UPDATE workflow_action_attempts SET state=CASE
      WHEN ?='requires_confirmation' THEN 'dispatched'
      WHEN ? IN ('effect_uncertain','receipt_failed') THEN 'uncertain'
      WHEN ? IN ('error','denied','not_supported','cancelled') THEN 'blocked'
      ELSE 'completed' END,operation_id=coalesce(?,operation_id),updated_at=? WHERE receipt_id=? AND state IN ('claimed','dispatched')`,
      )
      .run(
        result.status,
        result.code ?? null,
        result.status,
        result.operationId ?? null,
        Date.now(),
        id,
      );
    database.exec("RELEASE command_receipt");
  } catch (error) {
    database.exec("ROLLBACK TO command_receipt; RELEASE command_receipt");
    throw error;
  }
  return projected;
}

export function readCommandReceipt(
  database: DatabaseSync,
  id: string,
  threadId: string,
  offset = 0,
): CommandReceipt | null {
  const row = database
    .prepare(`SELECT * FROM command_receipts WHERE id = ? AND thread_id = ?`)
    .get(id, threadId) as
    | {
        id: string;
        action_id: string;
        result_json: string;
        children_json: string;
        started_at: number;
        finished_at: number;
      }
    | undefined;
  if (!row) return null;
  const resources = readLiveReferences(database, id, threadId);
  const nativeChildren = JSON.parse(row.children_json) as unknown[];
  const links = database
    .prepare(
      "SELECT id, action_id, result_json FROM command_receipts WHERE parent_receipt_id = ? AND thread_id = ? ORDER BY rowid",
    )
    .all(id, threadId)
    .map((child) => {
      const result = JSON.parse(String(child.result_json)) as ActionResult;
      const index =
        result.data &&
        typeof result.data === "object" &&
        !Array.isArray(result.data) &&
        typeof result.data.itemIndex === "number"
          ? result.data.itemIndex
          : undefined;
      return {
        receiptId: child.id,
        action: child.action_id,
        status: result.status,
        summary: result.summary.slice(0, 300),
        ...(result.code ? { code: result.code } : {}),
        ...(index !== undefined ? { index } : {}),
      };
    });
  const represented = new Set<number>();
  const children = nativeChildren.map((child) => {
    if (
      typeof child !== "object" ||
      child === null ||
      !("index" in child) ||
      typeof child.index !== "number"
    )
      return child;
    const link = links.find((link) => link.index === child.index);
    if (!link) return child;
    represented.add(child.index);
    return { ...child, receiptId: link.receiptId, action: link.action };
  });
  return {
    id,
    action: row.action_id,
    result: JSON.parse(row.result_json) as ActionResult,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.finished_at - row.started_at,
    resources: resources.slice(offset, offset + 100).map((resource) => {
      const scopes = createScopeStore(database);
      const resolved = resolveFileReference({
        reference: resource.path,
        purpose: "read",
        actor: "ui",
        scopes: scopes.list(),
        grants: scopes
          .activeGrants()
          .filter((grant) => !grant.threadId || grant.threadId === threadId),
      });
      if (!resolved.ok)
        return {
          ...resource,
          available: false,
          unavailableReason: resolved.summary,
        };
      try {
        const stat = lstatSync(resolved.path.absolute);
        if (!stat.isFile() || stat.isSymbolicLink())
          return {
            ...resource,
            available: false,
            unavailableReason: "That file is no longer available.",
          };
        if (
          (resource.size !== undefined && resource.size !== stat.size) ||
          (resource.mtimeMs !== undefined && resource.mtimeMs !== stat.mtimeMs)
        )
          return {
            ...resource,
            available: false,
            unavailableReason:
              "That file changed after this receipt was recorded.",
          };
        return { ...resource, available: true };
      } catch {
        return {
          ...resource,
          available: false,
          unavailableReason: "That file no longer exists.",
        };
      }
    }),
    totalResources: resources.length,
    more: offset + 100 < resources.length,
    children: [
      ...children,
      ...links.filter(
        (link) => link.index === undefined || !represented.has(link.index),
      ),
    ],
  };
}
