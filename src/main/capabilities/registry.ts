import { z } from "zod";
import {
  actionResultSchema,
  type ActionResult,
  type ActorKind,
} from "../../shared/action-contract";

export {
  PERMANENT_MODEL_TOOLS as MODEL_TOOL_NAMES,
  type PermanentModelTool as ModelToolName,
} from "../../shared/model-tools";

const LIST_LIMIT = 20;
const DESCRIBE_LIMIT = 8;
const DETAIL_LIMIT = 4000;

export type ActionContext = {
  actor: ActorKind;
  threadId: string;
  turnId?: string;
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
  execute: (
    args: Record<string, unknown>,
    context: ActionContext,
  ) => ActionResult;
};

export type CapabilityRegistry = {
  list: (path?: string) => ListResult;
  describe: (ids: string[]) => DescribeResult;
  invoke: (
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ) => ActionResult;
};

type Child = {
  id: string;
  description: string;
  kind: "read" | "mutation" | "category";
  syntax?: string;
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

function categoryOf(id: string): string {
  return id.slice(0, id.indexOf("."));
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

export function createRegistry(capabilities: Capability[]): CapabilityRegistry {
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

  function list(path?: string): ListResult {
    const normalized = path?.trim() ?? "";
    if (normalized.length === 0) {
      const categories = [
        ...new Set([...byId.keys()].map((id) => categoryOf(id))),
      ].sort();
      const children = categories.slice(0, LIST_LIMIT).map((id) => ({
        id,
        description: categoryDescriptions[id] ?? id,
        kind: "category" as const,
      }));
      return {
        path: "",
        children,
        more: categories.length > LIST_LIMIT,
      };
    }
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
    const children = [...byId.values()]
      .filter((capability) => categoryOf(capability.id) === normalized)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (children.length === 0) {
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
      children: children.slice(0, LIST_LIMIT).map((capability) => ({
        id: capability.id,
        description: capability.description,
        kind: capability.kind,
        syntax: shownSyntax(capability),
      })),
      more: children.length > LIST_LIMIT,
    };
  }

  function describe(ids: string[]): DescribeResult {
    const requested = ids.slice(0, DESCRIBE_LIMIT);
    const entries = requested.map((id) => {
      const capability = byId.get(id);
      if (!capability) return { id, code: "unknown" as const };
      return {
        id,
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

  function invoke(
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ): ActionResult {
    const capability = byId.get(name);
    if (!capability) {
      return errorResult(
        name,
        "unknown_action",
        `No registered action named ${name}.`,
      );
    }
    const parsed = capability.args.safeParse(args);
    if (!parsed.success) {
      return errorResult(
        name,
        "invalid_args",
        clip(
          `${parsed.error.issues.map((issue) => issue.message).join(" ")} Syntax: ${shownSyntax(capability)}`,
          DETAIL_LIMIT,
        ),
      );
    }
    return contractResult(
      capability.execute(parsed.data as Record<string, unknown>, context),
    );
  }

  return { list, describe, invoke };
}

export function dispatchModelTool(
  registry: CapabilityRegistry,
  name: string,
  rawArgs: unknown,
  context: ActionContext,
): ActionResult {
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
    "Only capabilities.list, capabilities.describe, and actions.invoke are available.",
  );
}
