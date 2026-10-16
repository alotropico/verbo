import { z } from "zod";
import { pendingQuestionSchema } from "../../shared/workflows";

export const requestInputSchema = z
  .object({
    request: z.string().min(1).max(500_000),
    target: z.string().max(200).nullable().optional(),
    answer: z.union([z.boolean(), z.string().max(8000)]).optional(),
  })
  .strict();
export const commanderOutputSchema = z
  .object({
    findings: z.array(z.string().max(2000)).max(30),
    receiptIds: z.array(z.string().max(128)).max(100),
    question: pendingQuestionSchema.optional(),
    contentRef: z.string().max(128).optional(),
    revision: z.string().max(128).optional(),
    path: z.string().max(1000).optional(),
  })
  .strict();
export const writerInputSchema = z
  .object({
    request: z.string().max(500_000),
    source: z.string().max(500_000).optional(),
    sourceRef: z.string().max(128).optional(),
    target: z.string().max(200).nullable().optional(),
    revision: z.string().max(128).optional(),
    path: z.string().max(1000).optional(),
  })
  .strict();
export const writerBodySchema = z
  .object({ body: z.string().min(1).max(500_000) })
  .strict();
export const writerOutputSchema = z
  .object({ contentRef: z.string().min(1).max(128) })
  .strict();
export const operationOutputSchema = z
  .object({ value: z.enum(["write", "edit", "move", "rename", "delete"]) })
  .strict();
export const commanderInputSchema = writerInputSchema
  .extend({
    body: z.string().max(500_000).optional(),
    contentRef: z.string().max(128).optional(),
    operation: z.string().max(100).optional(),
    answer: z.union([z.boolean(), z.string().max(8000)]).optional(),
  })
  .strict();

export function createSchemaRegistry(entries: Record<string, z.ZodType> = {}): {
  get(id: string): z.ZodType;
  has: (id: string) => boolean;
} {
  const schemas = new Map(
    Object.entries({
      "request.v1": requestInputSchema,
      "conversation.v1": writerOutputSchema,
      "writer.input.v1": writerInputSchema,
      "writer.output.v1": writerOutputSchema,
      "commander.input.v1": commanderInputSchema,
      "commander.output.v1": commanderOutputSchema,
      "obsidian.operation.v1": operationOutputSchema,
      ...entries,
    }),
  );
  return {
    get(id: string): z.ZodType {
      const schema = schemas.get(id);
      if (!schema) throw new Error(`Unknown schema: ${id}`);
      return schema;
    },
    has: (id: string) => schemas.has(id),
  };
}
export type SchemaRegistry = ReturnType<typeof createSchemaRegistry>;
