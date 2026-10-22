import { app } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { actionResultSchema, type ActionResult } from "../../shared/action-contract";
import { activeInvocation, bindApprovalInvocation, withInvocation } from "../agents/policy";
import type { CapabilityRegistry } from "../capabilities/registry";
import { createAssetStore } from "../files/asset-store";
import { modelSupportsVision } from "../runtime/model-vision";
import { loadSettings } from "../services/settings-store";
import { aloCall, AloCallError, currentAloSignal } from "./client";
import { aloContext } from "./context";

const admissionSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    kind: z.enum(["read", "mutation"]),
    effect: z.string().optional(),
  }),
  z.object({ ok: z.literal(false), result: actionResultSchema }),
]);

/** Thin owner client; Verbo retains workflow admission and presentation. */
export function createAloRegistry(database?: DatabaseSync, defaultsOnly = false): CapabilityRegistry {
  const catalog = async (operation: string, args: Record<string, unknown> = {}): Promise<unknown> =>
    await aloCall({
      method: "catalog",
      args: { operation, ...args },
      context: aloContext(),
    });
  const registry: CapabilityRegistry = {
    nodes: async () => {
      if (defaultsOnly && !activeInvocation()) {
        const settings = (await aloCall({ method: "settings.read", context: { actor: "ui", threadId: "alo-settings" } })) as {
          defaults: Awaited<ReturnType<CapabilityRegistry["nodes"]>>;
        };
        return settings.defaults;
      }
      return (await catalog("nodes")) as Awaited<ReturnType<CapabilityRegistry["nodes"]>>;
    },
    metadata: async () => (await catalog("metadata")) as Awaited<ReturnType<NonNullable<CapabilityRegistry["metadata"]>>>,
    resolve: (name) => catalog("resolve", { name }) as Promise<Awaited<ReturnType<CapabilityRegistry["resolve"]>>>,
    normalize: (name, args) =>
      catalog("normalize", { name, args }) as Promise<{
        name: string;
        args: Record<string, unknown>;
      }>,
    list: (name) => catalog("list", { name }) as Promise<Awaited<ReturnType<CapabilityRegistry["list"]>>>,
    search: (query) => catalog("search", { query }) as Promise<Awaited<ReturnType<CapabilityRegistry["search"]>>>,
    describe: (ids) => catalog("describe", { ids }) as Promise<Awaited<ReturnType<CapabilityRegistry["describe"]>>>,
    invoke: (name, args, context) =>
      withInvocation(context.invocation, async (): Promise<ActionResult> => {
        const signal = context.signal ?? currentAloSignal();
        if (signal?.aborted)
          return {
            action: name,
            status: "cancelled",
            summary: "Operation cancelled.",
          };
        let admitted: z.infer<typeof admissionSchema>;
        try {
          admitted = admissionSchema.parse(
            await aloCall(
              {
                method: "catalog",
                args: { operation: "admit", name, args },
                context: aloContext(context, database, args),
              },
              signal,
            ),
          );
        } catch {
          return {
            action: name,
            status: signal?.aborted ? "cancelled" : "error",
            code: signal?.aborted ? "cancelled" : "alo_unavailable",
            summary: "Alo could not validate the command. No effect was dispatched.",
          };
        }
        if (!admitted.ok) return admitted.result;
        // Only a referenced, verified app upload crosses the ownership boundary.
        if (database && typeof admitted.args.contentRef === "string") {
          const ref = admitted.args.contentRef;
          const upload = database.prepare("SELECT name FROM attachments WHERE id=? AND thread_id=?").get(ref, context.threadId);
          if (upload) {
            try {
              const text = await createAssetStore(database, join(app.getPath("userData"), "attachments")).text(context.threadId, ref);
              if (text === null)
                return {
                  action: admitted.name,
                  status: "error",
                  code: "missing_content",
                  summary: "The referenced upload is unavailable.",
                };
              await aloCall(
                {
                  method: "assets.put",
                  args: { id: ref, name: String(upload.name), text },
                  context: { actor: "ui", threadId: context.threadId },
                },
                signal,
              );
            } catch {
              return {
                action: admitted.name,
                status: signal?.aborted ? "cancelled" : "error",
                code: signal?.aborted ? "cancelled" : "content_transfer_failed",
                summary: "The referenced upload could not be transferred. No effect was dispatched.",
              };
            }
          }
        }
        const policy = activeInvocation();
        const ledger = context.parentReceiptId || context.derivedDispatch ? undefined : policy?.ledger;
        let claim: Awaited<ReturnType<NonNullable<typeof ledger>["before"]>> | undefined;
        try {
          claim = await ledger?.before(admitted.name, admitted.args, admitted.kind);
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          return {
            action: admitted.name,
            status: signal?.aborted ? "cancelled" : "error",
            code: signal?.aborted ? "cancelled" : (failure.code ?? "workflow_admission_failed"),
            summary: failure.message ?? "The workflow could not admit this command. No effect was dispatched.",
          };
        }
        if (claim?.replay) return claim.replay;
        const receiptId = claim?.receiptId ?? context.receiptId ?? randomUUID();
        const attribution = context.attribution ?? policy?.attribution;
        const bound = {
          ...context,
          receiptId,
          ...(attribution
            ? {
                attribution: {
                  ...attribution,
                  ...(claim ? { attemptId: claim.id } : {}),
                },
              }
            : {}),
        };
        let result: ActionResult;
        try {
          const trusted = aloContext(bound, database, admitted.args);
          if (admitted.name === "files.inspect_image") {
            try {
              trusted.visionSupported = modelSupportsVision(loadSettings().model);
            } catch {
              trusted.visionSupported = false;
            }
          }
          result = actionResultSchema.parse(
            await aloCall(
              {
                method: "invoke",
                name: admitted.name,
                args: admitted.args,
                context: trusted,
              },
              signal,
            ),
          );
        } catch (error) {
          const uncertain =
            (!(error instanceof AloCallError) || error.dispatched) &&
            (admitted.kind === "mutation" || admitted.effect === "launch" || admitted.effect === "process");
          result = {
            action: admitted.name,
            receiptId,
            status: uncertain ? "partial" : signal?.aborted ? "cancelled" : "error",
            code: uncertain ? "effect_uncertain" : signal?.aborted ? "cancelled" : "alo_unavailable",
            summary: uncertain
              ? "Alo did not return a final receipt. Effects may be partial. Inspect the known receipt before any retry."
              : "Alo could not complete the command. No local fallback or retry was attempted.",
          };
        }
        if (result.status === "requires_confirmation" && result.operationId) bindApprovalInvocation(result.operationId, context.threadId);
        try {
          if (claim) ledger?.after(claim, result);
        } catch {
          return {
            ...result,
            status: "error",
            code: "receipt_failed",
            summary: "Workflow settlement failed. Recorded effects must not be replayed.",
          };
        }
        return result;
      }),
    forwardModelTool: (name, args, context) => {
      if (name === "actions.invoke") {
        const parsed = z
          .object({
            name: z.string().min(1).max(128),
            args: z.record(z.string(), z.unknown()).default({}),
          })
          .strict()
          .safeParse(args ?? {});
        if (parsed.success) return registry.invoke(parsed.data.name, parsed.data.args, context);
      }
      return aloCall({ method: "tool", name, args, context: aloContext(context, database) }, context.signal)
        .then((result) => actionResultSchema.parse(result))
        .catch(() => ({
          action: name,
          status: "error" as const,
          code: "alo_unavailable",
          summary: "Alo discovery is unavailable.",
        }));
    },
  };
  return registry;
}
