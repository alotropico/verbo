import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActionContext } from "../capabilities/registry";
import { activeInvocation } from "../agents/policy";
import type { BridgeRequest } from "./contracts";

/** Constructed only from trusted backend context, never model or renderer args. */
export function aloContext(
  context?: ActionContext,
  database?: DatabaseSync,
  args?: Record<string, unknown>,
): BridgeRequest["context"] {
  const candidates = [
    context?.threadId,
    typeof args?.threadId === "string" ? args.threadId : undefined,
  ].filter((id): id is string => !!id);
  const validatedThreadIds = database
    ? [...new Set(candidates)].filter(
        (id) => !!database.prepare("SELECT id FROM threads WHERE id=?").get(id),
      )
    : [];
  const correlation = {
    validatedThreadIds,
    ...(context?.turnId ? { turnId: context.turnId } : {}),
    ...(context?.receiptId ? { receiptId: context.receiptId } : {}),
    ...(context?.parentReceiptId
      ? { parentReceiptId: context.parentReceiptId }
      : {}),
    ...(context?.attribution ? { attribution: context.attribution } : {}),
  };
  const policy = activeInvocation() ?? context?.invocation;
  if (policy)
    return {
      actor: context?.actor ?? "model",
      threadId: context?.threadId ?? "alo-discovery",
      ...correlation,
      policy: {
        id: policy.id,
        agentId: policy.agentId,
        allowed: {
          modules: [...policy.allowed.modules],
          actions: [...policy.allowed.actions],
        },
        discoverable: {
          modules: [...policy.discoverable.modules],
          actions: [...policy.discoverable.actions],
        },
        exposed: policy.exposed,
        forbidden: [...policy.forbidden],
      },
    };
  if (context?.actor === "model")
    return {
      actor: "model",
      threadId: context.threadId,
      ...correlation,
      policy: {
        id: randomUUID(),
        agentId: "commander",
        exposed: false,
        allowed: { modules: [], actions: [] },
        discoverable: { modules: [], actions: [] },
        forbidden: [],
      },
    };
  return {
    actor: context?.actor ?? "ui",
    threadId: context?.threadId ?? "alo-settings",
    ...correlation,
  };
}
