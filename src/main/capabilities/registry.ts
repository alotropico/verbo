import { z } from "zod";
import type { PreparedEffect } from "./preparation";
import { CommandFailure } from "./command-failure";
import type { CommandMetadata } from "../../shared/command-metadata";
import { randomUUID } from "node:crypto";
import type { CommandResource } from "../../shared/command-receipts";
import { collectCommandResources } from "../files/resource-events";
import {
  actionResultSchema,
  type ActionResult,
  type ActorKind,
} from "../../shared/action-contract";
import { ACTION_ALIASES, LOCAL_COMMANDS } from "../../shared/local-commands";
import {
  createCommandResolver,
  type CommandNode,
  type CommandResolution,
} from "../../shared/commands";
import {
  PERMANENT_MODEL_TOOLS,
  type PermanentModelTool,
} from "../../shared/model-tools";

export {
  PERMANENT_MODEL_TOOLS as MODEL_TOOL_NAMES,
  type PermanentModelTool as ModelToolName,
};

const LIST_LIMIT = 20;
const SEARCH_LIMIT = 20;
const DESCRIBE_LIMIT = 8;
const DETAIL_LIMIT = 4000;

export type ActionContext = {
  actor: ActorKind;
  threadId: string;
  turnId?: string;
  signal?: AbortSignal;
  /** Trusted backend correlation; never accepted in command arguments. */
  parentReceiptId?: string;
  receiptId?: string;
  onProgress?: (message: string) => void;
};

export type Capability = {
  id: string;
  description: string;
  kind: "read" | "mutation";
  args: z.ZodType;
  /** Call shape when the JSON schema hides required fields or allowed values. */
  syntax?: string;
  example: Record<string, unknown>;
  approval: "none" | "required";
  aliases?: string[];
  tags?: string[];
  parameterHelp?: Record<string, string>;
  execute: (
    args: Record<string, unknown>,
    context: ActionContext,
  ) => ActionResult | Promise<ActionResult>;
};

export type CapabilityRegistry = {
  metadata?: () => CommandMetadata[];
  /** Backend preparation hooks are not model tools or renderer IPC. */
  prepareEffect?: (
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ) => Promise<PreparedEffect>;
  preparationSignature?: (name: string) => string | undefined;
  aggregatePrepared?: (
    name: string,
    action: string,
    children: ActionResult[],
  ) => ActionResult;
  nodes: () => CommandNode[];
  resolve: (name: string) => CommandResolution;
  list: (path?: string) => ListResult;
  search: (query: string) => SearchResult;
  describe: (ids: string[]) => DescribeResult;
  invoke: (
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ) => Promise<ActionResult>;
};

type Child = {
  id: string;
  description: string;
  kind: "read" | "mutation" | "category";
  syntax?: string;
};

export type SearchMatch = {
  id: string;
  description: string;
  kind: "read" | "mutation" | "command";
  syntax?: string;
  aliases?: string[];
  reasons?: string[];
};

export type SearchResult = {
  query: string;
  matches: SearchMatch[];
  more: boolean;
  status?: "error";
  code?: "invalid_query";
  summary?: string;
};

export type ListResult = {
  path: string;
  children: Child[];
  more: boolean;
  status?: "error";
  code?: "unknown_path" | "not_a_category";
  summary?: string;
};

export type DescribeResult = {
  entries: Array<{
    id: string;
    description?: string;
    kind?: "read" | "mutation" | "category";
    approval?: "none" | "required";
    args?: unknown;
    syntax?: string;
    example?: Record<string, unknown>;
    code?: "unknown" | "truncated";
  }>;
  truncated: boolean;
};

const listArgsSchema = z
  .object({
    path: z.string().max(128).optional(),
  })
  .strict();

const searchArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2, "Search needs at least two characters.")
      .max(64),
  })
  .strict();

const describeArgsSchema = z
  .object({
    ids: z.array(z.string().min(1).max(128)).max(32),
  })
  .strict();

const invokeArgsSchema = z
  .object({
    name: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const categoryDescriptions: Record<string, string> = {
  ags: "Registered AGS hosts and bounded checks",
  environment: "Platform facts and well-known paths",
  files: "Scoped file queries and mutations",
  memory: "Saved notes for later turns",
  projects: "Registered project summaries",
  software: "Installed program lookups",
};

function errorResult(
  action: string,
  code: string,
  summary: string,
): ActionResult {
  return actionResultSchema.parse({ action, status: "error", code, summary });
}

function jsonWithin(value: unknown): string | undefined {
  const detail = JSON.stringify(value);
  return detail.length <= DETAIL_LIMIT ? detail : undefined;
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  if (cap <= 3) return text.slice(0, cap);
  return `${text.slice(0, cap - 3)}...`;
}

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  default?: unknown;
};

function renderSchema(schema: JsonSchema, depth = 0): string {
  const options = schema.anyOf ?? schema.oneOf;
  if (options && options.length > 0) {
    return `(${options.map((option) => renderSchema(option, depth)).join(" | ")})`;
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) {
    const values = schema.enum.map((value) => JSON.stringify(value)).join("|");
    return schema.default === undefined
      ? values
      : `${values}=${JSON.stringify(schema.default)}`;
  }
  if (schema.type === "array") {
    return `[${schema.items ? renderSchema(schema.items, depth + 1) : ""}]`;
  }
  if (schema.type === "object" && schema.properties) {
    if (depth > 2) return "{...}";
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(([name, property]) => {
      const optional =
        required.has(name) && property.default === undefined ? "" : "?";
      const rendered = renderSchema(property, depth + 1);
      if (
        rendered === "string" ||
        rendered === "number" ||
        rendered === "boolean"
      ) {
        const fallback =
          property.default === undefined
            ? ""
            : `=${JSON.stringify(property.default)}`;
        return `${name}${optional}${fallback}`;
      }
      return `${name}${optional}:${rendered}`;
    });
    return `{${fields.join(", ")}}`;
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "string") return "string";
  return "value";
}

function argumentSyntax(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema) as JsonSchema;
  return clip(renderSchema(json), 700);
}

function shownSyntax(capability: Capability): string {
  return capability.syntax ?? argumentSyntax(capability.args);
}

function contractResult(result: ActionResult): ActionResult {
  const parsed = actionResultSchema.safeParse(result);
  if (parsed.success) return parsed.data;
  const detail =
    result.detail && result.detail.length > DETAIL_LIMIT
      ? result.detail.slice(0, DETAIL_LIMIT)
      : result.detail;
  const retry = actionResultSchema.safeParse({
    ...result,
    summary: result.summary.slice(0, DETAIL_LIMIT),
    ...(detail !== undefined
      ? { detail, detailsAvailable: true as const }
      : {}),
  });
  if (retry.success) return retry.data;
  return errorResult(
    result.action.slice(0, 128) || "action",
    "invalid_result",
    "The action result did not fit the response contract.",
  );
}

function fitListDetail(listed: ListResult): {
  detail: string;
  detailsAvailable?: true;
} {
  const full = jsonWithin({
    path: listed.path,
    children: listed.children,
    more: listed.more,
  });
  if (full) return { detail: full };

  const longest = listed.children.reduce(
    (max, child) => Math.max(max, child.description.length),
    0,
  );
  let low = 0;
  let high = longest;
  let fitted: string | undefined;
  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    const detail = jsonWithin({
      path: listed.path,
      children: listed.children.map((child) => ({
        id: child.id,
        kind: child.kind,
        ...(child.syntax ? { syntax: child.syntax } : {}),
        description: clip(child.description, cap),
      })),
      more: listed.more,
    });
    if (detail) {
      fitted = detail;
      low = cap + 1;
    } else {
      high = cap - 1;
    }
  }
  if (fitted) return { detail: fitted, detailsAvailable: true };

  const ids = listed.children.map((child) => ({
    id: child.id,
    kind: child.kind,
    ...(child.syntax ? { syntax: child.syntax } : {}),
  }));
  let count = ids.length;
  while (count > 0) {
    const detail = jsonWithin({
      path: listed.path,
      children: ids.slice(0, count),
      more: listed.more || count < ids.length,
    });
    if (detail) return { detail, detailsAvailable: true };
    count -= 1;
  }
  return {
    detail: JSON.stringify({ path: listed.path, children: [], more: true }),
    detailsAvailable: true,
  };
}

function fitSearchDetail(found: SearchResult): {
  detail: string;
  detailsAvailable?: true;
} {
  const full = jsonWithin({
    query: found.query,
    matches: found.matches,
    more: found.more,
  });
  if (full) return { detail: full };
  const clipped = jsonWithin({
    query: found.query,
    matches: found.matches.map((match) => ({
      id: match.id,
      kind: match.kind,
      ...(match.syntax ? { syntax: match.syntax } : {}),
      ...(match.aliases ? { aliases: match.aliases } : {}),
      description: clip(match.description, 160),
    })),
    more: found.more,
  });
  if (clipped) return { detail: clipped, detailsAvailable: true };
  return {
    detail: JSON.stringify({
      query: found.query,
      matches: found.matches.slice(0, 8).map((match) => ({
        id: match.id,
        kind: match.kind,
        ...(match.syntax ? { syntax: match.syntax } : {}),
        ...(match.aliases ? { aliases: match.aliases } : {}),
      })),
      more: true,
    }),
    detailsAvailable: true,
  };
}

function fitDescribeDetail(described: DescribeResult): {
  detail: string;
  detailsAvailable?: true;
} {
  const full = jsonWithin(described);
  if (full) return { detail: full };

  const withoutArgs = {
    entries: described.entries.map(
      ({ id, description, kind, approval, syntax, example, code }) => ({
        id,
        ...(description ? { description } : {}),
        ...(kind ? { kind } : {}),
        ...(approval ? { approval } : {}),
        ...(syntax ? { syntax } : {}),
        ...(example ? { example } : {}),
        ...(code ? { code } : {}),
      }),
    ),
    truncated: described.truncated,
  };
  const dropped = jsonWithin(withoutArgs);
  if (dropped) return { detail: dropped, detailsAvailable: true };

  const longest = withoutArgs.entries.reduce(
    (max, entry) => Math.max(max, entry.description?.length ?? 0),
    0,
  );
  let low = 0;
  let high = longest;
  let fitted: string | undefined;
  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    const detail = jsonWithin({
      entries: withoutArgs.entries.map((entry) => ({
        ...entry,
        ...(entry.description
          ? { description: clip(entry.description, cap) }
          : {}),
      })),
      truncated: true,
    });
    if (detail) {
      fitted = detail;
      low = cap + 1;
    } else {
      high = cap - 1;
    }
  }
  if (fitted) return { detail: fitted, detailsAvailable: true };

  return {
    detail: JSON.stringify({
      entries: described.entries.map((entry) => ({
        id: entry.id,
        ...(entry.syntax ? { syntax: entry.syntax } : {}),
      })),
      truncated: true,
    }),
    detailsAvailable: true,
  };
}

export type RegistryOptions = {
  nodes?: CommandNode[];
  finalize?: (input: {
    result: ActionResult;
    context: ActionContext;
    startedAt: number;
    resources: CommandResource[];
  }) => ActionResult;
};
export function createRegistry(
  capabilities: Capability[],
  options: RegistryOptions = {},
): CapabilityRegistry {
  const byId = new Map<string, Capability>();
  for (const capability of capabilities) {
    if (!capability.id.includes(".")) {
      throw new Error(
        `Capability id must include a category: ${capability.id}`,
      );
    }
    if (byId.has(capability.id)) {
      throw new Error(`Duplicate capability: ${capability.id}`);
    }
    byId.set(capability.id, capability);
  }
  const fallbackNodes = new Map<string, CommandNode>();
  for (const capability of capabilities) {
    const segments = capability.id.split(".");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const id = segments.slice(0, depth).join(".");
      fallbackNodes.set(
        id,
        depth === segments.length
          ? {
              id,
              description: capability.description,
              aliases: capability.aliases ?? [],
            }
          : { id, description: categoryDescriptions[id] ?? id, aliases: [] },
      );
    }
  }
  const nodes = options.nodes ?? [...fallbackNodes.values()];
  const resolve = createCommandResolver(nodes);
  const byNode = new Map(nodes.map((node) => [node.id, node]));

  function list(path?: string): ListResult {
    const requested = path?.trim() ?? "";
    const resolved = requested ? resolve(requested) : undefined;
    const normalized = resolved?.ok ? resolved.id : requested;
    if (byId.has(normalized)) {
      return {
        path: normalized,
        children: [],
        more: false,
        status: "error",
        code: "not_a_category",
        summary: `${normalized} is an action. Describe it instead of listing it.`,
      };
    }
    const children = nodes
      .filter(
        (node) => node.id.split(".").slice(0, -1).join(".") === normalized,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    if (children.length === 0 && normalized && !byNode.has(normalized)) {
      return {
        path: normalized,
        children: [],
        more: false,
        status: "error",
        code: "unknown_path",
        summary: `No capability category named ${normalized}.`,
      };
    }
    return {
      path: normalized,
      children: children.slice(0, LIST_LIMIT).map((node) => {
        const capability = byId.get(node.id);
        return {
          id: node.id,
          description: node.description,
          kind: capability?.kind ?? "category",
          ...(capability ? { syntax: shownSyntax(capability) } : {}),
        };
      }),
      more: children.length > LIST_LIMIT,
    };
  }

  function describe(ids: string[]): DescribeResult {
    const requested = ids.slice(0, DESCRIBE_LIMIT);
    const entries = requested.map((id) => {
      const resolution = resolve(id);
      const canonical = resolution.ok ? resolution.id : id;
      const capability = byId.get(canonical);
      if (!capability) {
        const node = byNode.get(canonical);
        return node
          ? {
              id: canonical,
              description: node.description,
              kind: "category" as const,
            }
          : { id, code: "unknown" as const };
      }
      return {
        id: canonical,
        description: capability.description,
        kind: capability.kind,
        approval: capability.approval,
        args: z.toJSONSchema(capability.args),
        syntax: shownSyntax(capability),
        example: capability.example,
      };
    });
    return { entries, truncated: ids.length > DESCRIBE_LIMIT };
  }

  async function invoke(
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ): Promise<ActionResult> {
    const startedAt = Date.now();
    context = { ...context, receiptId: randomUUID() };
    const settle = (
      result: ActionResult,
      resources: CommandResource[] = [],
    ): ActionResult => {
      const validated = contractResult(result);
      try {
        return (
          options.finalize?.({
            result: validated,
            context,
            startedAt,
            resources,
          }) ?? validated
        );
      } catch {
        return {
          ...validated,
          status: "error",
          code: "receipt_failed",
          summary:
            "Operation failed: saving the command result failed. Recorded effects must not be replayed.",
        };
      }
    };
    const resolution = resolve(name);
    if (!resolution.ok)
      return settle(
        errorResult(
          name,
          resolution.code,
          resolution.code === "ambiguous_command"
            ? `Choose a canonical command: ${resolution.candidates.join(", ")}`
            : `No registered action named ${name}.`,
        ),
      );
    const capability = byId.get(resolution.id);
    if (!capability) {
      return settle(
        errorResult(
          name,
          "unknown_action",
          `No registered action named ${name}.`,
        ),
      );
    }
    name = capability.id;
    const parsed = capability.args.safeParse(args);
    if (!parsed.success) {
      return settle(
        errorResult(
          name,
          "invalid_args",
          clip(
            `${parsed.error.issues.map((issue) => issue.message).join(" ")} Syntax: ${shownSyntax(capability)}`,
            DETAIL_LIMIT,
          ),
        ),
      );
    }
    if (context.signal?.aborted) {
      return settle({
        action: name,
        status: "cancelled",
        summary: "Operation cancelled.",
      });
    }
    try {
      const recorded = await collectCommandResources(async () => {
        try {
          return await capability.execute(
            parsed.data as Record<string, unknown>,
            context,
          );
        } catch (error) {
          if (error instanceof CommandFailure)
            return errorResult(
              name,
              error.code,
              `Operation failed: ${error.message}`.slice(0, 500),
            );
          return errorResult(
            name,
            "execution_failed",
            "Operation failed: the registered executor could not complete.",
          );
        }
      });
      return settle(recorded.result, recorded.resources);
    } catch {
      return settle(
        errorResult(
          name,
          "execution_failed",
          "Operation failed: the registered executor could not complete.",
        ),
      );
    }
  }

  function search(query: string): SearchResult {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2 || needle.length > 64) {
      return {
        query: needle.slice(0, 64),
        matches: [],
        more: false,
        status: "error",
        code: "invalid_query",
        summary: "Search needs two to sixty-four characters.",
      };
    }
    const matches: SearchMatch[] = [];
    const scores = new Map<string, number>();
    const capabilities = [...byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const capability of capabilities) {
      const legacyAliases = ACTION_ALIASES.filter(
        (entry) => entry.actionId === capability.id,
      ).map((entry) => entry.alias);
      const ancestors = capability.id
        .split(".")
        .map((_segment, index, segments) =>
          byNode.get(segments.slice(0, index + 1).join(".")),
        )
        .filter((node): node is CommandNode => Boolean(node));
      const aliases = [
        ...legacyAliases,
        ...ancestors.flatMap((node) => node.aliases),
      ];
      const syntax = shownSyntax(capability);
      const fields = [
        { reason: "canonical ID", text: capability.id, weight: 90 },
        { reason: "alias", text: aliases.join("\n"), weight: 75 },
        {
          reason: "tags",
          text: (capability.tags ?? []).join("\n"),
          weight: 60,
        },
        {
          reason: "parameters",
          text: Object.values(capability.parameterHelp ?? {}).join("\n"),
          weight: 50,
        },
        { reason: "description", text: capability.description, weight: 30 },
        { reason: "syntax", text: syntax, weight: 20 },
      ];
      const reasons = fields.filter((field) =>
        field.text.toLowerCase().includes(needle),
      );
      const segments = needle.split(".");
      const aliasPath =
        segments.length === ancestors.length &&
        segments.every((segment, index) => {
          const node = ancestors[index];
          return [node.id.split(".").at(-1)!, ...node.aliases].some((name) =>
            name.startsWith(segment),
          );
        });
      const haystack = fields
        .map((field) => field.text)
        .join("\n")
        .toLowerCase();
      const terms = needle.split(/\s+/).filter(Boolean);
      if (
        !reasons.length &&
        !aliasPath &&
        !terms.every((term) => haystack.includes(term))
      )
        continue;
      const exactId = capability.id === needle;
      const exactAlias = aliases.some(
        (alias) => alias.toLowerCase() === needle,
      );
      scores.set(
        capability.id,
        exactId
          ? 100
          : exactAlias
            ? 95
            : aliasPath
              ? 92
              : Math.max(10, ...reasons.map((reason) => reason.weight)),
      );
      const hitAliases = aliases.filter((alias) =>
        alias.toLowerCase().includes(needle),
      );
      matches.push({
        id: capability.id,
        description: capability.description,
        kind: capability.kind,
        syntax,
        reasons: (aliasPath
          ? ["alias path"]
          : reasons.length
            ? reasons.map((reason) => reason.reason)
            : ["query terms"]
        ).slice(0, 3),
        ...(hitAliases.length > 0 ? { aliases: hitAliases } : {}),
      });
    }
    for (const command of LOCAL_COMMANDS) {
      if (command.actionId) continue;
      const haystack = [command.name, command.syntax, command.blurb]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({
        id: `/${command.name}`,
        description: command.blurb,
        kind: "command",
        syntax: command.syntax,
        reasons: ["local command"],
      });
      scores.set(`/${command.name}`, command.name === needle ? 100 : 15);
    }
    matches.sort(
      (left, right) =>
        (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) ||
        left.id.localeCompare(right.id),
    );
    return {
      query: needle,
      matches: matches.slice(0, SEARCH_LIMIT),
      more: matches.length > SEARCH_LIMIT,
    };
  }

  return {
    list,
    search,
    describe,
    invoke,
    resolve,
    nodes: () => nodes.map((node) => ({ ...node, aliases: [...node.aliases] })),
  };
}

export async function dispatchModelTool(
  registry: CapabilityRegistry,
  name: string,
  rawArgs: unknown,
  context: ActionContext,
): Promise<ActionResult> {
  if (name === "capabilities.list") {
    const parsed = listArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult(
        name,
        "invalid_args",
        "List accepts an optional path.",
      );
    }
    const listed = registry.list(parsed.data.path);
    const packed = fitListDetail(listed);
    return contractResult({
      action: name,
      status: listed.status === "error" ? "error" : "success",
      code: listed.code,
      summary:
        listed.status === "error"
          ? (listed.summary ?? "List failed.")
          : packed.detailsAvailable
            ? `Listed ${listed.path || "catalog"}. Descriptions were shortened. Syntax remains.`
            : (listed.summary ?? `Listed ${listed.path || "catalog"}.`),
      detail: packed.detail,
      ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
    });
  }
  if (name === "capabilities.search") {
    const parsed = searchArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult(
        name,
        "invalid_args",
        "Search needs a query of two to sixty-four characters.",
      );
    }
    const found = registry.search(parsed.data.query);
    if (found.status === "error") {
      return errorResult(
        name,
        found.code ?? "invalid_query",
        found.summary ?? "Search failed.",
      );
    }
    const packed = fitSearchDetail(found);
    const count = found.matches.length;
    return contractResult({
      action: name,
      status: "success",
      summary:
        count === 0
          ? `No commands match ${found.query}.`
          : found.more
            ? `Found ${count} commands for ${found.query}. More matches were omitted.`
            : `Found ${count} commands for ${found.query}.`,
      detail: packed.detail,
      ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
    });
  }
  if (name === "capabilities.describe") {
    const parsed = describeArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult(
        name,
        "invalid_args",
        "Describe accepts a list of ids.",
      );
    }
    const described = registry.describe(parsed.data.ids);
    const packed = fitDescribeDetail(described);
    return contractResult({
      action: name,
      status: "success",
      summary: described.truncated
        ? `Described the first ${DESCRIBE_LIMIT} ids.`
        : packed.detailsAvailable
          ? `Described ${described.entries.length} ids. Full schemas were omitted; syntax remains.`
          : `Described ${described.entries.length} ids.`,
      detail: packed.detail,
      ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
    });
  }
  if (name === "actions.invoke") {
    const parsed = invokeArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult(
        name,
        "invalid_args",
        "Invoke accepts a registered name and arguments.",
      );
    }
    return registry.invoke(parsed.data.name, parsed.data.args, context);
  }
  return errorResult(
    name,
    "unknown_tool",
    `Only ${PERMANENT_MODEL_TOOLS.join(", ")} are available.`,
  );
}
