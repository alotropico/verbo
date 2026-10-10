import { z } from "zod";

export const actionStatuses = [
  "success",
  "error",
  "requires_confirmation",
  "denied",
  "partial",
  "cancelled",
  "not_supported",
] as const;

export const actorKinds = ["user_command", "model", "ui"] as const;

export const turnLimitsSchema = z.object({
  maxRounds: z.number().int().positive().max(8).default(8),
  maxToolRequests: z.number().int().positive().max(20).default(20),
  maxPendingMutationApprovals: z.literal(1).default(1),
});

export const DEFAULT_TURN_LIMITS = turnLimitsSchema.parse({});

/** Model and renderer payloads cannot claim an actor or an approval. */
export const actionRequestSchema = z
  .object({
    name: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()).default({}),
    threadId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const actionResultSchema = z
  .object({
    action: z.string().min(1).max(128),
    status: z.enum(actionStatuses),
    summary: z.string().max(4000),
    operationId: z.string().min(1).max(128).optional(),
    code: z.string().min(1).max(64).optional(),
    detail: z.string().max(4000).optional(),
    preview: z.array(z.string().max(500)).max(20).optional(),
    totalItems: z.number().int().nonnegative().optional(),
    detailsAvailable: z.boolean().optional(),
  })
  .strict();

/** Review names a stored plan. The human decision is recorded by main, not by this payload. */
export const approvalReviewSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(128),
  })
  .strict();

export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type ActionResult = z.infer<typeof actionResultSchema>;
export type ActorKind = (typeof actorKinds)[number];
