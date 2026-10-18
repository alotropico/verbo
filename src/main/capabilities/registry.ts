import { z } from "zod";
import type { PreparedEffect } from "./preparation";
import { CommandFailure } from "./command-failure";
import type { CommandMetadata } from "../../shared/command-metadata";
import { randomUUID } from "node:crypto";
import {
  activeInvocation,
  bindApprovalInvocation,
  permitsCommand,
  withInvocation,
  type InvocationPolicy,
} from "../agents/policy";
import type { WorkflowAttribution } from "../../shared/workflows";
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
const SEARCH_STOP = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "under",
  "with",
  "within",
]);

export type ActionContext = {
  actor: ActorKind;
  threadId: string;
  turnId?: string;
  signal?: AbortSignal;
  /** Trusted backend correlation; never accepted in command arguments. */
  parentReceiptId?: string;
  receiptId?: string;
  onProgress?: (message: string) => void;
  invocation?: InvocationPolicy;
  attribution?: WorkflowAttribution;
  /** A verified backend substitution shares the semantic command's durable attempt. */
  derivedDispatch?: true;
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
  normalize?: (
    name: string,
    args: Record<string, unknown>,
  ) => { name: string; args: Record<string, unknown> };
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
  list: (category?: string) => ListResult;
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
  example?: Record<string, unknown>;
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
  category: string;
  children: Child[];
  more: boolean;
  status?: "error";
  code?: "unknown_category" | "not_a_category";
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
    category: z.string().max(128).optional(),
    // Legacy input only. The model schema advertises category.
    path: z.string().max(128).optional(),
  })
  .strict();

export function canonicalListArguments(args: unknown): { category?: string } {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return {};
  const record = args as Record<string, unknown>;
  const category = trimmedText(record.category) ?? trimmedText(record.path);
  return category ? { category } : {};
}

function trimmedText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function categoryLooksLikeLocation(category: string): boolean {
  return /[\\/:]/.test(category);
}

function unknownCategorySummary(category: string): string {
  return categoryLooksLikeLocation(category)
    ? `No command category named ${category}. category lists command definitions, such as "files". It is not a folder.`
    : `No command category named ${category}. category is a command-category id such as "files". Omit it to list root categories.`;
}

function commandListSummary(category: string, shortened: boolean): string {
  const subject = category
    ? `Listed command definitions in category '${category}'.`
    : "Listed root command categories.";
  return shortened
    ? `${subject} Syntax is complete. Descriptions were shortened or omitted.`
    : subject;
}

function listDetail(
  listed: ListResult,
  children: unknown,
  more = listed.more,
): { category?: string; children: unknown; more: boolean } {
  return {
    ...(listed.category ? { category: listed.category } : {}),
    children,
    more,
  };
}

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
  files:
    "Queries page (files.list, files.search). Mutations (files.move, files.copy, files.trash, files.batch) take a folder selection before a path list.",
  memory: "Saved notes for later turns",
  projects: "Registered project summaries",
  software: "Installed program lookups",
};

function omitNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => omitNulls(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, omitNulls(item)]),
  );
}

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
  const full = jsonWithin(listDetail(listed, listed.children));
  if (full) return { detail: full };

  const longest = listed.children.reduce(
    (max, child) => Math.max(max, child.description.length),
    0,
  );
  // Below this, a clipped description is noise. Keep syntax and drop the prose.
  const minimumDescription = 80;
  let low = minimumDescription;
  let high = longest;
  let fitted: string | undefined;
  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    const detail = jsonWithin(
      listDetail(
        listed,
        listed.children.map((child) => ({
          id: child.id,
          kind: child.kind,
          ...(child.syntax ? { syntax: child.syntax } : {}),
          description: clip(child.description, cap),
        })),
      ),
    );
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
    const detail = jsonWithin(
      listDetail(
        listed,
        ids.slice(0, count),
        listed.more || count < ids.length,
      ),
    );
    if (detail) return { detail, detailsAvailable: true };
    count -= 1;
  }
  return {
    detail: JSON.stringify(listDetail(listed, [], true)),
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
      ...(match.example ? { example: match.example } : {}),
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
        ...(match.example ? { example: match.example } : {}),
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
        ...(kind ? { kind } : {}),
        ...(approval ? { approval } : {}),
        ...(syntax ? { syntax } : {}),
        ...(example ? { example } : {}),
        ...(description ? { description } : {}),
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
  let low = 80;
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
  const visible = (id: string): boolean =>
    byId.has(id)
      ? permitsCommand(id, true)
      : [...byId.keys()].some(
          (action) =>
            action.startsWith(`${id}.`) && permitsCommand(action, true),
        );

  function list(category?: string): ListResult {
    const requested = category?.trim() ?? "";
    const resolved = requested ? resolve(requested) : undefined;
    const normalized = resolved?.ok ? resolved.id : requested;
    if (byId.has(normalized)) {
      return {
        category: normalized,
        children: [],
        more: false,
        status: "error",
        code: "not_a_category",
        summary: `${normalized} is an action. Describe it instead of listing it.`,
      };
    }
    const children = nodes
      .filter(
        (node) =>
          node.id.split(".").slice(0, -1).join(".") === normalized &&
          visible(node.id),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    if (children.length === 0 && normalized && !byNode.has(normalized)) {
      return {
        category: normalized,
        children: [],
        more: false,
        status: "error",
        code: "unknown_category",
        summary: unknownCategorySummary(normalized),
      };
    }
    return {
      category: normalized,
      children: children.slice(0, LIST_LIMIT).map((node) => {
        const capability = byId.get(node.id);
        return {
          id: node.id,
          kind: capability?.kind ?? "category",
          ...(capability ? { syntax: shownSyntax(capability) } : {}),
          description: node.description,
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
      if (!visible(canonical)) return { id, code: "unknown" as const };
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
        kind: capability.kind,
        approval: capability.approval,
        syntax: shownSyntax(capability),
        example: capability.example,
        description: capability.description,
        args: z.toJSONSchema(capability.args),
      };
    });
    return { entries, truncated: ids.length > DESCRIBE_LIMIT };
  }

  function invoke(
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ): Promise<ActionResult> {
    return withInvocation(context.invocation, () =>
      invokeAuthorized(name, args, context),
    );
  }
  async function invokeAuthorized(
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ): Promise<ActionResult> {
    const startedAt = Date.now();
    context = {
      ...context,
      receiptId: context.receiptId ?? randomUUID(),
      attribution: context.attribution ?? activeInvocation()?.attribution,
    };
    const ledger =
      context.parentReceiptId || context.derivedDispatch
        ? undefined
        : activeInvocation()?.ledger;
    let claim: { id: string; receiptId: string } | undefined;
    const settle = (
      result: ActionResult,
      resources: CommandResource[] = [],
    ): ActionResult => {
      const validated = contractResult(result);
      if (validated.status === "requires_confirmation" && validated.operationId)
        bindApprovalInvocation(validated.operationId, context.threadId);
      try {
        const saved =
          options.finalize?.({
            result: validated,
            context,
            startedAt,
            resources,
          }) ?? validated;
        if (claim) ledger?.after(claim, saved);
        return saved;
      } catch {
        if (claim)
          ledger?.after(claim, {
            ...validated,
            code: "receipt_failed",
            status: "error",
          });
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
    args = omitNulls(args) as Record<string, unknown>;
    if (!permitsCommand(name, false, args))
      return settle({
        action: name,
        status: "denied",
        code: "invocation_forbidden",
        summary: "This command is outside the current step's authority.",
      });
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
      const admission = ledger?.before(
        name,
        parsed.data as Record<string, unknown>,
        capability.kind,
      );
      if (admission?.replay) return admission.replay;
      if (admission) {
        claim = admission;
        context = {
          ...context,
          receiptId: admission.receiptId,
          attribution: context.attribution
            ? { ...context.attribution, attemptId: admission.id }
            : undefined,
        };
      }
      const recorded = await collectCommandResources(async () => {
        try {
          return await capability.execute(
            parsed.data as Record<string, unknown>,
            context,
          );
        } catch (error) {
          if (error instanceof CommandFailure)
            return {
              ...errorResult(
                name,
                error.code,
                `Operation failed: ${error.message}`.slice(0, 500),
              ),
              ...(error.code === "obsidian_unqualified" ||
              error.code === "not_supported"
                ? { status: "not_supported" as const }
                : {}),
            };
          return errorResult(
            name,
            "execution_failed",
            "Operation failed: the registered executor could not complete.",
          );
        }
      });
      return settle(recorded.result, recorded.resources);
    } catch (error) {
      return settle(
        errorResult(
          name,
          error instanceof CommandFailure ? error.code : "execution_failed",
          error instanceof CommandFailure
            ? error.message
            : "Operation failed: the registered executor could not complete.",
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
      if (!permitsCommand(capability.id, true)) continue;
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
      const contentTerms = terms.filter(
        (term) => term.length > 2 && !SEARCH_STOP.has(term),
      );
      const matchedTerms = contentTerms.filter(
        (term) =>
          haystack.includes(term) ||
          (term.length > 6 &&
            term.endsWith("s") &&
            haystack.includes(term.slice(0, -1))),
      );
      const allTerms = terms.every((term) => haystack.includes(term));
      const partial =
        matchedTerms.length >= 2 &&
        matchedTerms.length >= Math.ceil(contentTerms.length * 0.5);
      if (!reasons.length && !aliasPath && !allTerms && !partial) continue;
      const exactId = capability.id === needle;
      const exactAlias = aliases.some(
        (alias) => alias.toLowerCase() === needle,
      );
      const idHit = contentTerms.includes(capability.id.split(".").at(-1) ?? "")
        ? 40
        : 0;
      scores.set(
        capability.id,
        (exactId
          ? 100
          : exactAlias
            ? 95
            : aliasPath
              ? 92
              : Math.max(
                  10,
                  ...reasons.map((reason) => reason.weight),
                  matchedTerms.length * 12,
                )) + idHit,
      );
      const hitAliases = aliases.filter((alias) =>
        alias.toLowerCase().includes(needle),
      );
      matches.push({
        id: capability.id,
        kind: capability.kind,
        syntax,
        example: capability.example,
        description: capability.description,
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
      if (activeInvocation()) continue;
      if (command.actionId) continue;
      const haystack = [command.name, command.syntax, command.blurb]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({
        id: `/${command.name}`,
        kind: "command",
        syntax: command.syntax,
        description: command.blurb,
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
    nodes: () =>
      nodes
        .filter((node) => visible(node.id))
        .map((node) => ({ ...node, aliases: [...node.aliases] })),
    normalize: (name, args) => {
      const resolution = resolve(name);
      const canonical = resolution.ok ? resolution.id : name;
      const capability = byId.get(canonical);
      const cleaned = omitNulls(args) as Record<string, unknown>;
      const parsed = capability?.args.safeParse(cleaned);
      return {
        name: canonical,
        args: parsed?.success
          ? (parsed.data as Record<string, unknown>)
          : cleaned,
      };
    },
  };
}

export async function dispatchModelTool(
  registry: CapabilityRegistry,
  name: string,
  rawArgs: unknown,
  context: ActionContext,
): Promise<ActionResult> {
  return withInvocation(context.invocation, () =>
    dispatchAuthorizedModelTool(registry, name, rawArgs, context),
  );
}

async function dispatchAuthorizedModelTool(
  registry: CapabilityRegistry,
  name: string,
  rawArgs: unknown,
  context: ActionContext,
): Promise<ActionResult> {
  if (activeInvocation() && !activeInvocation()!.exposed)
    return {
      action: name,
      status: "denied",
      code: "invocation_forbidden",
      summary: "This agent has no tools or command discovery.",
    };
  if (name === "capabilities.list") {
    const parsed = listArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult(
        name,
        "invalid_args",
        'List accepts an optional category id such as "files".',
      );
    }
    const listed = registry.list(canonicalListArguments(parsed.data).category);
    const packed = fitListDetail(listed);
    return contractResult({
      action: name,
      status: listed.status === "error" ? "error" : "success",
      code: listed.code,
      summary:
        listed.status === "error"
          ? (listed.summary ?? "List failed.")
          : commandListSummary(
              listed.category,
              packed.detailsAvailable === true,
            ),
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
          ? `Described ${described.entries.length} ids. Syntax and examples remain. Schemas or long descriptions were omitted.`
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
