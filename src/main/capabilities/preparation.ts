import { AsyncLocalStorage } from "node:async_hooks";
import { withBoundCommand } from "../agents/policy";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ActionResult } from "../../shared/action-contract";
import {
  createOperationStore,
  type NewOperationItem,
  type StoredPlan,
} from "../db/operations";
import { operationSession } from "../files/mutation-ports";
import type { ActionContext, CapabilityRegistry } from "./registry";

export const preparedEffectSchema = z
  .object({
    action: z.string().min(1).max(160),
    args: z.record(z.string(), z.json()),
    signature: z.string().length(64),
    snapshot: z.json(),
    summary: z.string().min(1).max(500),
    automatic: z.boolean(),
    readOnly: z.literal(true).optional(),
    risks: z.array(z.string().max(500)).max(8).default([]),
    details: z.string().max(32768).optional(),
  })
  .strict();
export type PreparedEffect = z.infer<typeof preparedEffectSchema>;
export type EffectPreparation = Pick<
  PreparedEffect,
  "snapshot" | "summary" | "automatic"
> & { risks?: string[]; details?: string; readOnly?: true };
export type PreparationRequest = {
  action: string;
  signature: string;
  effects: PreparedEffect[];
  reads: ActionResult[];
  aggregate?: string;
  context: ActionContext;
};
export type PreparationOwner = {
  submit: (
    request: PreparationRequest,
    registry: CapabilityRegistry,
  ) => Promise<ActionResult>;
  consume: (
    effect: PreparedEffect,
    context: ActionContext,
  ) => "missing" | "invalid" | { index: number };
};

export function stableCommandJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
export function commandFingerprint(value: unknown): string {
  return createHash("sha256").update(stableCommandJson(value)).digest("hex");
}

type Grant = {
  database: DatabaseSync;
  effect: PreparedEffect;
  context: ActionContext;
  consumed: boolean;
  index: number;
};
const grants = new AsyncLocalStorage<Grant>();
const envelopeSchema = z
  .object({
    effect: preparedEffectSchema,
    parent: z
      .object({
        action: z.string(),
        signature: z.string().length(64),
        aggregate: z.string().optional(),
        reads: z.array(z.json()).max(100),
      })
      .strict(),
  })
  .strict();

function failed(
  action: string,
  code: string,
  summary: string,
  operationId?: string,
): ActionResult {
  return {
    action,
    status: code === "cancelled" ? "cancelled" : "error",
    code,
    summary: summary.slice(0, 500),
    ...(operationId ? { operationId } : {}),
  };
}
function immutableItem(item: NewOperationItem): NewOperationItem {
  return {
    kind: item.kind,
    sourcePath: item.sourcePath,
    destinationPath: item.destinationPath,
    sourceDisplay: item.sourceDisplay,
    destinationDisplay: item.destinationDisplay,
    content: item.content,
    format: item.format,
    beforeJson: item.beforeJson,
    expectedJson: item.expectedJson,
  };
}

/** Uses the existing immutable operation store and decision surface; grants never enter IPC. */
export function createPreparationOwner(
  database: DatabaseSync,
): PreparationOwner {
  return {
    consume(effect, context) {
      const grant = grants.getStore();
      if (!grant) return "missing";
      if (
        grant.consumed ||
        grant.database !== database ||
        grant.context.actor !== context.actor ||
        grant.context.threadId !== context.threadId ||
        grant.context.turnId !== context.turnId ||
        stableCommandJson(grant.effect) !== stableCommandJson(effect)
      )
        return "invalid";
      grant.consumed = true;
      return { index: grant.index };
    },
    async submit(request, registry) {
      if (request.context.signal?.aborted)
        return failed(
          request.action,
          "cancelled",
          "The command was cancelled.",
        );
      if (!request.effects.length || request.effects.length > 32)
        return failed(
          request.action,
          "command_limit",
          "Operation failed: invalid prepared child count.",
        );
      const parent = {
        action: request.action,
        signature: request.signature,
        ...(request.aggregate ? { aggregate: request.aggregate } : {}),
        reads: request.reads,
      };
      const content = request.effects.map((effect, index) =>
        JSON.stringify(
          envelopeSchema.parse({
            effect,
            parent: index ? { ...parent, reads: [] } : parent,
          }),
        ),
      );
      if (content.some((value) => Buffer.byteLength(value) > 128 * 1024))
        return failed(
          request.action,
          "command_limit",
          "Operation failed: preparation is too large.",
        );
      const automatic =
        (request.context.actor !== "model" ||
          request.effects.every((effect) => effect.readOnly === true)) &&
        request.effects.every((effect) => effect.automatic);
      const summary = `${automatic ? "Running" : "Review"} ${request.effects.length} command${request.effects.length === 1 ? "" : "s"}.`;
      const store = createOperationStore(database);
      const items = request.effects.map((effect, index): NewOperationItem => ({
        kind: "command",
        sourcePath: null,
        destinationPath: null,
        sourceDisplay: effect.action,
        destinationDisplay: effect.summary,
        content: content[index]!,
        format: null,
        beforeJson: "{}",
        expectedJson: JSON.stringify({ diff: effect.details }),
      }));
      const plan = store.insert({
        id: request.context.receiptId,
        threadId: request.context.threadId,
        ...(request.context.turnId ? { turnId: request.context.turnId } : {}),
        sessionId: operationSession(),
        actor: request.context.actor,
        actionId: request.action,
        fingerprint: commandFingerprint(items.map(immutableItem)),
        scopeGeneration: 0,
        approval: automatic ? "auto" : "required",
        risks: [
          ...new Set(request.effects.flatMap((effect) => effect.risks)),
        ].slice(0, 20),
        summary,
        items,
        now: Date.now(),
      });
      // Reads were dispatched before the operation ID existed. Preserve their parent linkage.
      for (const read of request.reads)
        if (read.receiptId)
          database
            .prepare(
              "UPDATE command_receipts SET parent_receipt_id = ? WHERE id = ? AND thread_id = ? AND parent_receipt_id = ?",
            )
            .run(
              plan.id,
              read.receiptId,
              plan.threadId,
              request.context.receiptId ?? null,
            );
      if (automatic)
        return decidePreparedOperation({
          database,
          registry,
          operationId: plan.id,
          threadId: plan.threadId,
          sessionId: plan.sessionId,
          decision: "approve",
          signal: request.context.signal,
        });
      return {
        action: request.action,
        status: "requires_confirmation",
        code: "approval_required",
        summary,
        operationId: plan.id,
        totalItems: request.effects.length,
        preview: request.effects
          .slice(0, 8)
          .map((effect) => `${effect.action}: ${effect.summary}`.slice(0, 500)),
        detailsAvailable: true,
      };
    },
  };
}

export async function decidePreparedOperation(input: {
  database: DatabaseSync;
  registry: CapabilityRegistry;
  operationId: string;
  threadId: string;
  sessionId: string;
  decision: "approve" | "deny";
  signal?: AbortSignal;
}): Promise<ActionResult> {
  const store = createOperationStore(input.database);
  const plan = store.get(input.operationId);
  if (!plan)
    return failed(
      "commands",
      "missing",
      "That operation is no longer available.",
    );
  if (plan.threadId !== input.threadId)
    return failed(
      plan.actionId,
      "wrong_thread",
      "That plan belongs to another conversation.",
    );
  if (
    plan.sessionId !== input.sessionId ||
    plan.sessionId !== operationSession()
  )
    return failed(
      plan.actionId,
      "wrong_session",
      "That plan belongs to another session.",
    );
  if (plan.status !== "pending")
    return failed(
      plan.actionId,
      plan.status === "needs_review" ? "needs_review" : "replayed",
      "That operation will not be replayed.",
    );
  const reject = (code: string, summary: string): ActionResult => {
    store.markRemaining(plan.id, 0);
    store.finish(
      plan.id,
      code === "expired"
        ? "expired"
        : code === "cancelled"
          ? "cancelled"
          : "failed",
      code,
      summary,
      Date.now(),
    );
    return failed(plan.actionId, code, summary, plan.id);
  };
  if (plan.expiresAt <= Date.now())
    return reject("expired", "That plan expired. Make a new plan.");
  if (plan.cancelRequested || input.signal?.aborted)
    return reject("cancelled", "The command was cancelled.");
  if (input.decision === "deny") {
    if (!store.deny(plan.id, Date.now()))
      return failed(
        plan.actionId,
        "replayed",
        "That operation will not be replayed.",
      );
    return {
      action: plan.actionId,
      status: "denied",
      code: "denied",
      summary: "The command was denied.",
      operationId: plan.id,
    };
  }
  const items = store.items(plan.id);
  if (
    !items.length ||
    items.length > 32 ||
    items.some(
      (item) => item.kind !== "command" || item.status !== "planned",
    ) ||
    commandFingerprint(items.map(immutableItem)) !== plan.fingerprint
  )
    return reject(
      "stale_plan",
      "The stored commands changed. Make a new plan.",
    );
  const parsed = items.map((item) => {
    try {
      return envelopeSchema.safeParse(JSON.parse(item.content ?? "null"));
    } catch {
      return envelopeSchema.safeParse(null);
    }
  });
  if (parsed.some((item) => !item.success))
    return reject(
      "stale_plan",
      "The stored commands are invalid. Make a new plan.",
    );
  const envelopes = parsed.map((item) => item.data!);
  const parent = envelopes[0]!.parent;
  if (
    parent.action !== plan.actionId ||
    input.registry.preparationSignature?.(plan.actionId) !== parent.signature ||
    envelopes.some(
      (envelope, index) =>
        stableCommandJson({ ...envelope.parent, reads: [] }) !==
          stableCommandJson({ ...parent, reads: [] }) ||
        (index > 0 && envelope.parent.reads.length > 0),
    )
  )
    return reject(
      "stale_plan",
      "The command definition changed. Make a new plan.",
    );
  const context = planContext(plan, input.signal);
  for (const { effect } of envelopes) {
    try {
      const current = await withBoundCommand(effect.action, effect.args, () =>
        input.registry.prepareEffect?.(effect.action, effect.args, context),
      );
      if (!current || stableCommandJson(current) !== stableCommandJson(effect))
        return reject(
          "stale_target",
          "An application or target changed. Make a new plan.",
        );
    } catch {
      return reject(
        "stale_target",
        "An application or target is no longer available. Make a new plan.",
      );
    }
  }
  // Async preflight may yield to a duplicate decision, cancellation or expiry.
  const refreshed = store.get(plan.id);
  if (!refreshed || refreshed.status !== "pending")
    return failed(
      plan.actionId,
      "replayed",
      "That operation will not be replayed.",
    );
  if (refreshed.cancelRequested || input.signal?.aborted)
    return reject("cancelled", "The command was cancelled.");
  if (refreshed.expiresAt <= Date.now())
    return reject("expired", "That plan expired. Make a new plan.");
  if (!store.claim(plan.id, Date.now()))
    return failed(
      plan.actionId,
      "replayed",
      "That operation will not be replayed.",
    );
  const children = parent.reads as ActionResult[];
  let succeeded = 0;
  let last: ActionResult | undefined;
  const started = Date.now();
  for (const [index, envelope] of envelopes.entries()) {
    if (
      store.cancelRequested(plan.id) ||
      input.signal?.aborted ||
      Date.now() - started > 60_000
    ) {
      last = failed(
        envelope.effect.action,
        "cancelled",
        "The command was cancelled or reached its time limit.",
      );
      store.markRemaining(plan.id, index);
      break;
    }
    const item = items[index]!;
    // Persist uncertainty before starting an external effect. Restart never replays it.
    store.markItem(item.id, { status: "uncertain" });
    last = await grants.run(
      {
        database: input.database,
        effect: envelope.effect,
        context,
        consumed: false,
        index,
      },
      () =>
        withBoundCommand(envelope.effect.action, envelope.effect.args, () =>
          input.registry.invoke(envelope.effect.action, envelope.effect.args, {
            ...context,
            parentReceiptId: plan.id,
          }),
        ),
    );
    children.push(last);
    store.markItem(item.id, {
      status: last.status === "success" ? "succeeded" : "failed",
      ...(last.code ? { errorCode: last.code } : {}),
      errorSummary: last.summary,
      afterJson: JSON.stringify({
        receiptId: last.receiptId,
        status: last.status,
      }),
    });
    if (last.status !== "success") {
      store.markRemaining(plan.id, index + 1);
      break;
    }
    succeeded += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const complete = succeeded === items.length;
  let aggregate: ActionResult | undefined;
  try {
    aggregate = parent.aggregate
      ? input.registry.aggregatePrepared?.(
          parent.aggregate,
          plan.actionId,
          children,
        )
      : last;
  } catch {
    aggregate = failed(
      plan.actionId,
      "aggregate_failed",
      "Commands settled, but their result could not be summarized. Do not replay them.",
    );
  }
  const settledItems = store.items(plan.id);
  const result: ActionResult = {
    ...(aggregate ??
      failed(plan.actionId, "command_failed", "Operation failed.")),
    action: plan.actionId,
    operationId: plan.id,
    status: complete
      ? (aggregate?.status ?? "success")
      : succeeded
        ? "partial"
        : last?.status === "cancelled"
          ? "cancelled"
          : "error",
    ...(complete ? {} : { code: last?.code ?? "command_failed" }),
    summary: complete
      ? (aggregate?.summary ?? "Commands completed.")
      : `Operation failed: ${last?.summary ?? "command did not complete"}`.slice(
          0,
          500,
        ),
    data: {
      ...(aggregate?.data &&
      typeof aggregate.data === "object" &&
      !Array.isArray(aggregate.data)
        ? aggregate.data
        : {}),
      succeeded,
      failed: settledItems.filter((item) => item.status === "failed").length,
      notAttempted: settledItems.filter(
        (item) => item.status === "not_attempted",
      ).length,
    },
  };
  store.finish(
    plan.id,
    complete
      ? "succeeded"
      : succeeded
        ? "partial"
        : result.status === "cancelled"
          ? "cancelled"
          : "failed",
    result.code ?? null,
    result.summary,
    Date.now(),
  );
  store.audit({
    actor: plan.actor,
    actionId: plan.actionId,
    threadId: plan.threadId,
    requestSummary: `approve ${plan.id}`,
    resultSummary: result.summary,
    resultStatus: result.status,
    ...(result.code ? { resultCode: result.code } : {}),
    operationId: plan.id,
    now: Date.now(),
  });
  return result;
}

function planContext(plan: StoredPlan, signal?: AbortSignal): ActionContext {
  return {
    actor: plan.actor,
    threadId: plan.threadId,
    ...(plan.turnId ? { turnId: plan.turnId } : {}),
    ...(signal ? { signal } : {}),
  };
}
