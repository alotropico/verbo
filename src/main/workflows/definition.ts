import { z } from "zod";
import { agentIdSchema } from "../../shared/workflows";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/);
const valueRef = z.object({ ref: z.string().min(1).max(300) }).strict();
const boundValue = z.union([
  valueRef,
  z.string().max(8000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const bindings = z.record(id, boundValue);
export const contextPatchSchema = z
  .object({
    instructions: z.string().max(8000).optional(),
    include: z.array(id).max(30).optional(),
    exclude: z.array(id).max(30).optional(),
    replace: z.array(id).max(30).optional(),
  })
  .strict();
export const capabilityPatchSchema = z
  .object({
    mode: z.enum(["inherit", "extend", "replace", "limit"]).default("inherit"),
    modules: z.array(id).max(30).optional(),
    actions: z.array(id).max(80).optional(),
  })
  .strict();
const stepBase = z.object({ id, end: z.literal(true).optional() });
const agent = stepBase
  .extend({
    type: z.literal("agent"),
    agentId: agentIdSchema.exclude(["decision"]),
    modelProfileId: id,
    input: bindings,
    inputSchemaId: id,
    outputSchemaId: id,
    context: contextPatchSchema.optional(),
    capabilities: capabilityPatchSchema.optional(),
  })
  .strict();
const decide = stepBase
  .extend({
    type: z.literal("decide"),
    choices: z
      .array(z.union([z.string().min(1).max(100), z.boolean()]))
      .min(1)
      .max(30),
    modelProfileId: id,
    input: bindings,
    inputSchemaId: id,
    outputSchemaId: id,
    context: contextPatchSchema.optional(),
  })
  .strict();
const branch = z
  .object({
    id,
    type: z.literal("branch"),
    value: valueRef,
    cases: z
      .array(
        z
          .object({
            when: z.union([z.string().max(100), z.boolean()]),
            goto: id,
          })
          .strict(),
      )
      .min(1)
      .max(30),
    exhaustive: z.boolean().default(false),
  })
  .strict();
const workflow = stepBase
  .extend({
    type: z.literal("workflow"),
    workflowId: id,
    version: z.number().int().positive(),
    input: bindings,
    inputSchemaId: id,
    outputSchemaId: id,
  })
  .strict();
export const workflowDefinitionSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    description: z.string().min(1).max(1000),
    routing: z.string().min(1).max(2000),
    inputSchemaId: id,
    outputSchemaId: id,
    context: contextPatchSchema.optional(),
    steps: z
      .array(z.discriminatedUnion("type", [agent, decide, branch, workflow]))
      .min(1)
      .max(100),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowStep = WorkflowDefinition["steps"][number];
export type ValueRef = z.infer<typeof valueRef>;
export type BoundValue = z.infer<typeof boundValue>;
export type ContextPatch = z.infer<typeof contextPatchSchema>;
export type CapabilityPatch = z.infer<typeof capabilityPatchSchema>;
