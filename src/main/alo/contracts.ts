import { z } from "zod";
import { actionResultSchema, actorKinds } from "../../shared/action-contract";
import { attributionSchema } from "../../shared/workflows";

export const BRIDGE_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const grant = z
  .object({
    modules: z.array(z.string().max(128)).max(64),
    actions: z.array(z.string().max(128)).max(128),
  })
  .strict();
export const wirePolicySchema = z
  .object({
    id: z.string().min(1).max(128),
    agentId: z.enum(["decision", "writer", "conversational", "commander"]),
    allowed: grant,
    discoverable: grant,
    exposed: z.boolean(),
    forbidden: z.array(z.string().max(128)).max(128),
  })
  .strict();
export const wireContextSchema = z
  .object({
    actor: z.enum(actorKinds),
    threadId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128).optional(),
    policy: wirePolicySchema.optional(),
    validatedThreadIds: z.array(z.string().min(1).max(128)).max(32).optional(),
    visionSupported: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    receiptId: z.string().min(1).max(128).optional(),
    parentReceiptId: z.string().min(1).max(128).optional(),
    attribution: attributionSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.actor !== "model" || value.policy !== undefined,
    "Model calls require a trusted invocation policy.",
  );
export const bridgeRequestSchema = z
  .object({
    version: z.literal(BRIDGE_VERSION),
    id: z.string().min(1).max(128),
    method: z.enum([
      "tool",
      "invoke",
      "catalog",
      "settings.read",
      "settings.save",
      "settings.reset",
      "settings.scopes.read",
      "settings.scopes.apply",
      "settings.entities.read",
      "settings.applications.save",
      "settings.applications.remove",
      "settings.project-preferences.save",
      "settings.project-import.save",
      "settings.projects.add",
      "settings.projects.remove",
      "settings.ags-hosts.add",
      "settings.ags-hosts.remove",
      "settings.ags-check.read",
      "settings.ags-check.save",
      "settings.ags-check.clear",
      "settings.obsidian.read",
      "settings.obsidian.save",
      "memory.snapshot",
      "memory.settings.read",
      "memory.settings.action",
      "receipts.read",
      "assets.text",
      "operations.review",
      "operations.decide",
      "operations.cancel",
      "operations.pending",
      "profile.backup",
      "profile.import",
      "memory.store",
      "settings.scopes.grant",
      "settings.projects.list",
      "settings.ags-hosts.list",
      "settings.project-import.read",
      "settings.applications.discover",
      "receipts.execution",
      "resources.list",
      "assets.put",
      "operations.abandon",
      "history.read",
      "history.record",
    ]),
    name: z.string().min(1).max(128).optional(),
    args: z.unknown().optional(),
    context: wireContextSchema,
  })
  .strict();
export const bridgeResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(BRIDGE_VERSION),
      id: z.string(),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      version: z.literal(BRIDGE_VERSION),
      id: z.string(),
      ok: z.literal(false),
      error: z.object({ code: z.string(), summary: z.string() }).strict(),
    })
    .strict(),
]);
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type WirePolicy = z.infer<typeof wirePolicySchema>;
export { actionResultSchema };
