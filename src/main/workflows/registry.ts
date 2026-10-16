import { conversationalWorkflow } from "./definitions/conversational";
import { commanderWorkflow } from "./definitions/commander";
import { obsidianWorkflow } from "./definitions/obsidian";
import { validateWorkflow } from "./validate";
import { createSchemaRegistry, type SchemaRegistry } from "./schemas";
import type { WorkflowDefinition } from "./definition";

export function createWorkflowRegistry(
  definitions: WorkflowDefinition[] = [
    conversationalWorkflow,
    commanderWorkflow,
    obsidianWorkflow,
  ],
  schemas: SchemaRegistry = createSchemaRegistry(),
): {
  get(id: string, version?: number): WorkflowDefinition;
  cards: () => {
    id: string;
    version: number;
    description: string;
    routing: string;
  }[];
  schemas: {
    get(id: string): import("zod").ZodType;
    has: (id: string) => boolean;
  };
} {
  const byKey = new Map<string, WorkflowDefinition>();
  for (const definition of definitions) {
    const key = `${definition.id}@${definition.version}`;
    if (byKey.has(key)) throw new Error(`Duplicate workflow version: ${key}`);
    byKey.set(key, definition);
  }
  const find = (id: string, version: number): WorkflowDefinition | undefined =>
    byKey.get(`${id}@${version}`);
  for (const definition of definitions)
    validateWorkflow(definition, {
      schemas,
      workflow: find,
      modelProfiles: [
        "decision",
        "conversational",
        "commander",
        "writer",
        "responder",
      ],
    });
  return {
    get(id: string, version = 1): WorkflowDefinition {
      const definition = find(id, version);
      if (!definition) throw new Error("Workflow version is unavailable.");
      return structuredClone(definition);
    },
    cards: () =>
      definitions.map(({ id, version, description, routing }) => ({
        id,
        version,
        description,
        routing,
      })),
    schemas,
  };
}
