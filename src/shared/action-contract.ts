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

export const activityCategories = [
  "search",
  "read",
  "change",
  "other",
] as const;
export type ActivityCategory = (typeof activityCategories)[number];

export const actionSubjectSchema = z
  .object({
    role: z.enum(["source", "destination"]),
    path: z.string().min(1).max(1024),
  })
  .strict();
export type ActionSubject = z.infer<typeof actionSubjectSchema>;

export const actorKinds = ["user_command", "model", "ui"] as const;

export const turnLimitsSchema = z.object({
  maxRounds: z.number().int().positive().max(32).default(32),
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
    receiptId: z.string().min(1).max(128).optional(),
    resourceCount: z.number().int().nonnegative().optional(),
    activity: z.enum(activityCategories).optional(),
    subjects: z.array(actionSubjectSchema).max(40).optional(),
    data: z
      .json()
      .refine(
        (value) => JSON.stringify(value).length <= 16000,
        "Command data exceeds its bound.",
      )
      .optional(),
  })
  .strict();

/** Review names a stored plan. Confirm carries the card's approve or deny choice. */
export const approvalReviewSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(128),
  })
  .strict();

export const approvalDecisionSchema = approvalReviewSchema
  .extend({
    decision: z.enum(["approve", "deny"]),
  })
  .strict();

export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type ActionResult = z.infer<typeof actionResultSchema>;
export type ActorKind = (typeof actorKinds)[number];
