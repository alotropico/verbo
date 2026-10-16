import { z } from "zod";

export const agentIdSchema = z.enum([
  "decision",
  "conversational",
  "writer",
  "commander",
]);
export type AgentId = z.infer<typeof agentIdSchema>;
export const executionStatusSchema = z.enum([
  "running",
  "awaiting_input",
  "suspended",
  "completed",
  "failed",
  "cancelled",
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export const workflowIdSchema = z.enum([
  "conversational",
  "commander",
  "obsidian",
]);
export type EntryWorkflowId = z.infer<typeof workflowIdSchema>;

export const attributionSchema = z
  .object({
    executionId: z.string().uuid(),
    workflowId: z.string().max(80),
    definitionVersion: z.number().int().positive(),
    stepId: z.string().max(80),
    stepRunId: z.string().uuid(),
    invocationId: z.string().uuid().optional(),
    agentId: agentIdSchema.optional(),
    modelProfileId: z.string().max(80).optional(),
    attemptId: z.string().uuid().optional(),
  })
  .strict();
export type WorkflowAttribution = z.infer<typeof attributionSchema>;

export const pendingQuestionSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    required: z.boolean(),
    expected: z.discriminatedUnion("type", [
      z.object({ type: z.literal("boolean") }).strict(),
      z
        .object({
          type: z.literal("enum"),
          values: z.array(z.string().max(200)).min(1).max(30),
        })
        .strict(),
      z
        .object({
          type: z.literal("text"),
          maxLength: z.number().int().min(1).max(8000),
        })
        .strict(),
    ]),
    binding: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
    default: z.union([z.string().max(8000), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.required && value.default !== undefined)
      context.addIssue({
        code: "custom",
        message: "A required question cannot have a default.",
      });
    if (
      value.default !== undefined &&
      !validQuestionAnswer(value, value.default)
    )
      context.addIssue({
        code: "custom",
        message: "Default does not match the question contract.",
      });
  });
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

export function validQuestionAnswer(
  question: Pick<PendingQuestion, "expected">,
  value: unknown,
): value is string | boolean {
  if (question.expected.type === "boolean") return typeof value === "boolean";
  if (question.expected.type === "enum")
    return (
      typeof value === "string" && question.expected.values.includes(value)
    );
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= question.expected.maxLength
  );
}

export const stepResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), output: z.unknown() }).strict(),
  z
    .object({
      status: z.literal("awaiting_input"),
      question: pendingQuestionSchema,
      output: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      status: z.enum(["failed", "cancelled", "not_supported", "blocked"]),
      code: z.string().min(1).max(100),
      summary: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type StepResult = z.infer<typeof stepResultSchema>;

export const stageEventSchema = z
  .object({
    attribution: attributionSchema,
    state: z.enum([
      "started",
      "succeeded",
      "awaiting_input",
      "failed",
      "cancelled",
      "blocked",
      "not_supported",
      "suspended",
    ]),
    label: z.string().max(160),
    summary: z.string().max(2000).optional(),
  })
  .strict();
export type WorkflowStage = z.infer<typeof stageEventSchema>;

export const routingStageSchema = z
  .object({
    invocationId: z.string().uuid(),
    agentId: z.literal("decision"),
    modelProfileId: z.literal("decision"),
    state: z.enum(["started", "succeeded", "failed", "cancelled"]),
    workflowId: workflowIdSchema.optional(),
    disposition: z.string().max(40).optional(),
  })
  .strict();
export type RoutingStage = z.infer<typeof routingStageSchema>;

export const verifiedOutcomeSchema = z
  .object({
    version: z.literal(1),
    executionId: z.string().uuid(),
    workflowId: z.string().max(80),
    status: z.enum([
      "completed",
      "awaiting_input",
      "partial",
      "blocked",
      "failed",
      "cancelled",
    ]),
    requestMessageId: z.string().max(128),
    findings: z.array(z.string().max(2000)).max(30),
    question: pendingQuestionSchema.optional(),
    receiptIds: z.array(z.string().max(128)).max(100),
    uncertainReceiptIds: z.array(z.string().max(128)).max(100),
    errors: z
      .array(
        z
          .object({ code: z.string().max(100), summary: z.string().max(2000) })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type VerifiedOutcome = z.infer<typeof verifiedOutcomeSchema>;

export type ExecutionSummary = {
  id: string;
  workflowId: string;
  definitionVersion: number;
  revision: number;
  status: ExecutionStatus;
  branchAnchorId: string | null;
  currentStepId: string | null;
  question?: PendingQuestion;
  reason?: string;
};
