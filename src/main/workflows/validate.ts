import { z } from "zod";
import {
  workflowDefinitionSchema,
  type BoundValue,
  type WorkflowDefinition,
} from "./definition";
import type { SchemaRegistry } from "./schemas";

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
};
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

export function referencePath(reference: string): string[] {
  const path = reference.split(".");
  if (
    path.some((part) => !part || forbidden.has(part)) ||
    !(path[0] === "input" || (path[0] === "steps" && path[2] === "output"))
  )
    throw new Error(`Invalid reference: ${reference}`);
  return path;
}

function schemaField(schema: JsonSchema, path: string[]): JsonSchema {
  if (!path.length) return schema;
  const [field, ...remaining] = path;
  const next = schema.properties?.[field!];
  if (!next) throw new Error(`Unknown schema field: ${path.join(".")}`);
  return schemaField(next, remaining);
}

function typeSet(schema: JsonSchema): Set<string> {
  if (schema.anyOf)
    return new Set(schema.anyOf.flatMap((item) => [...typeSet(item)]));
  if (schema.type)
    return new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (schema.enum) return new Set(schema.enum.map((value) => typeof value));
  if (schema.const !== undefined) return new Set([typeof schema.const]);
  return new Set();
}

function serializable(value: unknown, depth = 0): void {
  if (depth > 30) throw new Error("Definition nesting is too deep.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    for (const entry of value) serializable(entry, depth + 1);
    return;
  }
  if (
    typeof value !== "object" ||
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Definitions must contain only portable data.");
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error("Unsafe definition property.");
    serializable(entry, depth + 1);
  }
}

/** Validate the complete graph before admitting even its first action. Jumps are forward-only in V1. */
export function validateWorkflow(
  value: unknown,
  input: {
    schemas: SchemaRegistry;
    workflow?: (
      id: string,
      version: number,
    ) =>
      Pick<WorkflowDefinition, "inputSchemaId" | "outputSchemaId"> | undefined;
    modelProfiles?: readonly string[];
    modules?: readonly string[];
    actions?: readonly string[];
  },
): WorkflowDefinition {
  serializable(value);
  const definition = workflowDefinitionSchema.parse(value);
  const { schemas } = input;
  schemas.get(definition.inputSchemaId);
  schemas.get(definition.outputSchemaId);
  const ids = new Map<string, number>();
  definition.steps.forEach((step, index) => {
    if (step.id.includes(".") || ids.has(step.id))
      throw new Error(`Duplicate or ambiguous step ID: ${step.id}`);
    ids.set(step.id, index);
  });
  const incoming = definition.steps.map(() => [] as Set<string>[]);
  incoming[0]!.push(new Set());
  const json = (id: string): JsonSchema =>
    z.toJSONSchema(schemas.get(id), { unrepresentable: "any" }) as JsonSchema;
  const sourceSchema = (ref: string, available: Set<string>): JsonSchema => {
    const path = referencePath(ref);
    if (path[0] === "input")
      return schemaField(json(definition.inputSchemaId), path.slice(1));
    const id = path[1]!;
    if (!available.has(id))
      throw new Error(
        `Producer ${id} is not available on every incoming path.`,
      );
    const producer = definition.steps[ids.get(id)!]!;
    if (producer.type === "branch")
      throw new Error("Branch steps do not produce output.");
    return schemaField(json(producer.outputSchemaId), path.slice(3));
  };
  const validateBindings = (
    bindings: Record<string, BoundValue>,
    schemaId: string,
    available: Set<string>,
  ): void => {
    const destination = json(schemaId);
    for (const key of destination.required ?? [])
      if (!Object.hasOwn(bindings, key))
        throw new Error(`Missing required input binding: ${key}`);
    for (const [key, value] of Object.entries(bindings)) {
      const field = destination.properties?.[key];
      if (!field) throw new Error(`Unknown input binding: ${key}`);
      if (typeof value === "object" && value !== null) {
        const source = sourceSchema(value.ref, available);
        const allowed = typeSet(field);
        if (
          allowed.size &&
          [...typeSet(source)].some(
            (type) =>
              !allowed.has(type) &&
              !(type === "integer" && allowed.has("number")),
          )
        )
          throw new Error(`Incompatible binding: ${key}`);
      } else {
        const allowed = typeSet(field);
        const type = value === null ? "null" : typeof value;
        if (
          allowed.size &&
          !allowed.has(type) &&
          !(
            type === "number" &&
            allowed.has("integer") &&
            Number.isInteger(value)
          )
        )
          throw new Error(`Incompatible literal binding: ${key}`);
        if (field.enum && !field.enum.includes(value))
          throw new Error(`Invalid literal enum binding: ${key}`);
      }
    }
  };
  for (let index = 0; index < definition.steps.length; index += 1) {
    const step = definition.steps[index]!;
    const paths = incoming[index]!;
    if (!paths.length) throw new Error(`Unreachable step: ${step.id}`);
    const available = new Set(
      [...paths[0]!].filter((id) => paths.every((path) => path.has(id))),
    );
    const next = new Set(available);
    const edges: number[] = [];
    if (step.type === "branch") {
      const source = sourceSchema(step.value.ref, available);
      const domain =
        source.enum ??
        (source.type === "boolean"
          ? [true, false]
          : source.const !== undefined
            ? [source.const]
            : undefined);
      const cases = new Set<string>();
      for (const entry of step.cases) {
        const key = JSON.stringify(entry.when);
        if (cases.has(key)) throw new Error("Duplicate branch condition.");
        cases.add(key);
        if (domain && !domain.includes(entry.when))
          throw new Error("Branch condition is outside the declared domain.");
        const target = ids.get(entry.goto);
        if (target === undefined || target <= index)
          throw new Error("Missing target or cyclic/backward jump.");
        edges.push(target);
      }
      const exhaustive =
        domain && domain.every((entry) => cases.has(JSON.stringify(entry)));
      if (step.exhaustive && !exhaustive)
        throw new Error("Unsafe branch must cover its finite declared domain.");
      if (!exhaustive) edges.push(index + 1);
    } else {
      schemas.get(step.inputSchemaId);
      schemas.get(step.outputSchemaId);
      validateBindings(step.input, step.inputSchemaId, available);
      if (step.type === "workflow") {
        const referenced = input.workflow?.(step.workflowId, step.version);
        if (
          !referenced ||
          referenced.inputSchemaId !== step.inputSchemaId ||
          referenced.outputSchemaId !== step.outputSchemaId
        )
          throw new Error(
            "Referenced workflow/version contracts are unavailable or incompatible.",
          );
      } else {
        if (
          input.modelProfiles &&
          !input.modelProfiles.includes(step.modelProfileId)
        )
          throw new Error("Unknown model profile.");
        if (step.type === "agent") {
          if (
            step.agentId !== "commander" &&
            ((step.capabilities?.modules?.length ?? 0) ||
              (step.capabilities?.actions?.length ?? 0))
          )
            throw new Error("Tool-free agent cannot have command grants.");
          for (const module of step.capabilities?.modules ?? [])
            if (input.modules && !input.modules.includes(module))
              throw new Error("Unknown capability module.");
          for (const action of step.capabilities?.actions ?? [])
            if (input.actions && !input.actions.includes(action))
              throw new Error("Unknown capability action.");
        } else {
          if (new Set(step.choices).size !== step.choices.length)
            throw new Error("Duplicate decision choice.");
          const domain = schemaField(json(step.outputSchemaId), ["value"]);
          if (
            !domain.enum ||
            domain.enum.length !== step.choices.length ||
            step.choices.some((choice) => !domain.enum!.includes(choice))
          )
            throw new Error("Decision choices must match the output domain.");
        }
      }
      next.add(step.id);
      if (!step.end) edges.push(index + 1);
    }
    for (const edge of edges)
      if (edge < definition.steps.length) incoming[edge]!.push(new Set(next));
  }
  return definition;
}
