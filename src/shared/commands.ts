import { z } from "zod";
import type { CommandMetadata } from "./command-metadata";

export const commandSegmentSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
export const commandPathSchema = z
  .string()
  .max(128)
  .refine(
    (value) =>
      value
        .split(".")
        .every((segment) => commandSegmentSchema.safeParse(segment).success),
    "Use lowercase command segments separated by dots.",
  );
export const commandAliasesSchema = z
  .array(commandSegmentSchema)
  .max(12)
  .refine(
    (values) => new Set(values).size === values.length,
    "Aliases must be unique.",
  );
export const commandNodeSchema = z
  .object({
    id: commandPathSchema,
    aliases: commandAliasesSchema,
    description: z.string().min(1).max(2000),
  })
  .strict();
export type CommandNode = z.infer<typeof commandNodeSchema>;

const referenceSchema = z
  .object({
    from: z.enum(["input", "step", "item"]),
    step: commandSegmentSchema.optional(),
    path: z.array(commandSegmentSchema).max(8).default([]),
  })
  .strict();
export const commandBindingSchema = z.union([
  z.object({ literal: z.unknown() }).strict(),
  referenceSchema,
]);
export type CommandBinding = z.infer<typeof commandBindingSchema>;
export const commandStepSchema = z
  .object({
    id: commandSegmentSchema,
    command: commandPathSchema,
    args: z.record(commandSegmentSchema, commandBindingSchema),
    forEach: referenceSchema.optional(),
    when: z
      .object({
        step: commandSegmentSchema,
        status: z.enum(["success", "partial", "error"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export const commandExecutionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("handler"), handler: commandPathSchema }).strict(),
  z.object({ type: z.literal("process"), process: commandPathSchema }).strict(),
  z
    .object({
      type: z.literal("composite"),
      steps: z.array(commandStepSchema).min(1).max(32),
      onFailure: z.enum(["stop", "continue"]).default("stop"),
      aggregate: commandPathSchema,
    })
    .strict(),
]);
export type CommandExecution = z.infer<typeof commandExecutionSchema>;

export const commandOverrideSchema = z
  .object({
    nodeId: commandPathSchema,
    version: z.literal(1),
    aliases: commandAliasesSchema,
  })
  .strict();
export type CommandOverride = z.infer<typeof commandOverrideSchema>;
export type CommandSettings = {
  metadata: CommandMetadata[];

  nodes: CommandNode[];
  defaults: CommandNode[];
  entries: Array<{
    id: string;
    description?: string;
    kind?: "read" | "mutation" | "category";
    approval?: "none" | "required";
    args?: unknown;
    syntax?: string;
    example?: Record<string, unknown>;
  }>;
};

export type CommandResolution =
  | { ok: true; id: string }
  | {
      ok: false;
      code: "unknown_action" | "ambiguous_command";
      candidates: string[];
    };

/** Canonical IDs win. Aliases are exact, case-insensitive segments; no fuzzy execution. */
export function createCommandResolver(
  nodes: CommandNode[],
): (name: string) => CommandResolution {
  const byId = new Map<string, CommandNode>();
  const siblings = new Map<string, Map<string, string>>();
  for (const raw of nodes) {
    const node = commandNodeSchema.parse(raw);
    if (byId.has(node.id))
      throw new Error(`Duplicate command node: ${node.id}`);
    byId.set(node.id, node);
    const segments = node.id.split(".");
    const segment = segments.pop()!;
    const parent = segments.join(".");
    const names = siblings.get(parent) ?? new Map<string, string>();
    for (const name of [segment, ...node.aliases]) {
      if (names.has(name))
        throw new Error(`Command alias collision: ${parent}.${name}`);
      names.set(name, node.id);
    }
    siblings.set(parent, names);
  }
  for (const node of byId.values()) {
    const parent = node.id.split(".").slice(0, -1).join(".");
    if (parent && !byId.has(parent))
      throw new Error(`Missing command scope: ${parent}`);
  }
  return (raw: string): CommandResolution => {
    const name = raw.trim().toLowerCase();
    if (byId.has(name)) return { ok: true, id: name };
    if (!commandPathSchema.safeParse(name).success)
      return { ok: false, code: "unknown_action", candidates: [] };
    if (!name.includes(".")) {
      const candidates = [...byId.values()]
        .filter(
          (node) =>
            node.id.split(".").at(-1) === name || node.aliases.includes(name),
        )
        .map((node) => node.id)
        .sort();
      if (candidates.length === 1) return { ok: true, id: candidates[0] };
      if (candidates.length > 1)
        return { ok: false, code: "ambiguous_command", candidates };
    }
    let parent = "";
    for (const segment of name.split(".")) {
      const next = siblings.get(parent)?.get(segment);
      if (!next) return { ok: false, code: "unknown_action", candidates: [] };
      parent = next;
    }
    return { ok: true, id: parent };
  };
}
