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
        parsed.error.issues.map((issue) => issue.message).join(" "),
      );
    }
    return actionResultSchema.parse(
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
    return actionResultSchema.parse({
      action: name,
      status: listed.status === "error" ? "error" : "success",
      code: listed.code,
      summary: listed.summary ?? `Listed ${listed.path || "catalog"}.`,
      detail: JSON.stringify({
        path: listed.path,
        children: listed.children,
        more: listed.more,
      }),
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
    return actionResultSchema.parse({
      action: name,
      status: "success",
      summary: described.truncated
        ? `Described the first ${DESCRIBE_LIMIT} ids.`
        : `Described ${described.entries.length} ids.`,
      detail: JSON.stringify(described),
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
