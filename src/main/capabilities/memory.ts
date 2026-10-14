import type {
  CommandDefinition,
  CommandModule,
  TrustedCommandBindings,
} from "./modules";
import {
  actionResultSchema,
  type ActionResult,
} from "../../shared/action-contract";
import {
  memoryAddArgsSchema,
  memoryGetArgsSchema,
  memoryListArgsSchema,
  memoryRemoveArgsSchema,
  memoryUpdateArgsSchema,
  type MemoryRecord,
} from "../../shared/memory";
import type { MemoryStore } from "../db/memory";

function packEntries(entries: readonly MemoryRecord[]): {
  detail: string;
  detailsAvailable?: boolean;
  totalItems: number;
} {
  const packed: unknown[] = [];
  for (const entry of entries) {
    const item = {
      id: entry.id,
      scope: entry.scope,
      threadId: entry.threadId,
      inclusion: entry.inclusion,
      source: entry.source,
      text: entry.text.slice(0, 500),
    };
    const next = JSON.stringify({ entries: [...packed, item] });
    if (next.length > 3800) break;
    packed.push(item);
  }
  return {
    detail: JSON.stringify({ entries: packed }),
    totalItems: entries.length,
    ...(packed.length < entries.length ? { detailsAvailable: true } : {}),
  };
}

function failure(action: string, code: string, summary: string): ActionResult {
  return { action, status: "error", code, summary };
}

export function memoryBindings(
  resolve: () => MemoryStore,
): TrustedCommandBindings["handlers"] {
  return {
    "memory.list": (args): ActionResult => {
      const parsed = memoryListArgsSchema.parse(args);
      const listed = resolve().list(parsed);
      const packed = packEntries(listed.entries);
      return {
        action: "memory.list",
        status: "success",
        summary: listed.more
          ? `Listed ${packed.totalItems} memories. More match.`
          : `Listed ${packed.totalItems} memories.`,
        detail: packed.detail,
        totalItems: packed.totalItems,
        ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
      };
    },
    "memory.get": (args): ActionResult => {
      const parsed = memoryGetArgsSchema.parse(args);
      const entries = resolve().get(parsed.ids);
      const packed = packEntries(entries);
      const missing = parsed.ids.length - entries.length;
      return {
        action: "memory.get",
        status: "success",
        summary:
          missing > 0
            ? `Returned ${entries.length} memories. ${missing} ids were missing.`
            : `Returned ${entries.length} memories.`,
        detail: packed.detail,
        totalItems: entries.length,
        ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
      };
    },
    "memory.add": (args, context): ActionResult => {
      const parsed = memoryAddArgsSchema.parse(args);
      const threadId =
        parsed.scope === "thread"
          ? (parsed.threadId ?? context.threadId)
          : parsed.threadId;
      const result = resolve().add({
        text: parsed.text,
        scope: parsed.scope,
        inclusion: parsed.inclusion,
        ...(threadId ? { threadId } : {}),
        actor: context.actor,
        originThreadId: context.threadId,
        originTurnId: context.turnId,
      });
      if (!result.ok) {
        return failure("memory.add", result.code, result.summary);
      }
      return {
        action: "memory.add",
        status: "success",
        summary: result.summary,
        ...(result.entry ? { data: { id: result.entry.id } } : {}),
        ...(result.entry
          ? {
              detail: JSON.stringify({
                id: result.entry.id,
                inclusion: result.entry.inclusion,
                scope: result.entry.scope,
              }),
            }
          : {}),
      };
    },
    "memory.update": (args, context): ActionResult => {
      const parsed = memoryUpdateArgsSchema.parse(args);
      const result = resolve().update({
        id: parsed.id,
        ...(parsed.text !== undefined ? { text: parsed.text } : {}),
        ...(parsed.inclusion !== undefined
          ? { inclusion: parsed.inclusion }
          : {}),
        actor: context.actor,
      });
      if (!result.ok) {
        return failure("memory.update", result.code, result.summary);
      }
      return {
        action: "memory.update",
        status: "success",
        summary: result.summary,
        data: { id: parsed.id },
      };
    },
    "memory.remove": (args, context): ActionResult => {
      const parsed = memoryRemoveArgsSchema.parse(args);
      const result = resolve().remove(parsed.id, context.actor);
      if (!result.ok) {
        return failure("memory.remove", result.code, result.summary);
      }
      return {
        action: "memory.remove",
        status: "success",
        summary: result.summary,
      };
    },
  };
}

export const memoryCommands: CommandDefinition[] = [
  {
    id: "memory.list",
    aliases: ["browse", "all"],
    description:
      "List saved memories. Filter by scope, inclusion, threadId, or a short query. On-demand text is not in the prompt until this or memory.get returns it.",
    kind: "read",
    approval: "none",
    args: memoryListArgsSchema,
    example: { scope: "global", inclusion: "on_demand", query: "notes" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "memory.list" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none",
    configurable: ["aliases"],
    requirements: ["Verbo backend storage and local platform services."],
    effect: "read",
  },
  {
    id: "memory.get",
    aliases: ["read", "show"],
    description: "Return selected memory records by id.",
    kind: "read",
    approval: "none",
    args: memoryGetArgsSchema,
    example: { ids: ["memory-id"] },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "memory.get" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none",
    configurable: ["aliases"],
    requirements: ["Verbo backend storage and local platform services."],
    effect: "read",
  },
  {
    id: "memory.add",
    aliases: ["remember", "save"],
    description:
      "Save a memory. Omitted inclusion is on_demand. Global always-on text shares a 512 estimated-token budget. Exact repeats are rejected. This does not grant a filesystem write.",
    kind: "mutation",
    approval: "none",
    args: memoryAddArgsSchema,
    example: {
      text: "Prefers short replies",
      scope: "global",
      inclusion: "always",
    },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "memory.add" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none",
    configurable: ["aliases"],
    requirements: ["Verbo backend storage and local platform services."],
    effect: "write",
  },
  {
    id: "memory.update",
    aliases: ["edit", "change"],
    description:
      "Change a memory's text or inclusion. Conflicts and the always-on budget are rejected instead of replacing another entry.",
    kind: "mutation",
    approval: "none",
    args: memoryUpdateArgsSchema,
    syntax: '{id, text} or {id, inclusion:"always"|"on_demand"}',
    example: { id: "memory-id", inclusion: "on_demand" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "memory.update" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none",
    configurable: ["aliases"],
    requirements: ["Verbo backend storage and local platform services."],
    effect: "write",
  },
  {
    id: "memory.remove",
    aliases: ["forget", "delete"],
    description: "Remove one memory by id.",
    kind: "mutation",
    approval: "none",
    args: memoryRemoveArgsSchema,
    example: { id: "memory-id" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "memory.remove" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none",
    configurable: ["aliases"],
    requirements: ["Verbo backend storage and local platform services."],
    effect: "write",
  },
];

export const memoryModule: CommandModule = {
  id: "memory",
  aliases: ["mem", "remembered", "memories"],
  description: "Saved notes for later turns",
  version: 1,
  scopes: [],
  commands: memoryCommands,
};
