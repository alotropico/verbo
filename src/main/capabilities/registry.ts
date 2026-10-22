import { type ActionResult, type ActorKind } from "../../shared/action-contract";
import type { CommandMetadata } from "../../shared/command-metadata";
import { type CommandNode, type CommandResolution } from "../../shared/commands";
import { PERMANENT_MODEL_TOOLS, type PermanentModelTool } from "../../shared/model-tools";
import type { WorkflowAttribution } from "../../shared/workflows";
import { withInvocation, type InvocationPolicy } from "../agents/policy";
export { PERMANENT_MODEL_TOOLS as MODEL_TOOL_NAMES, type PermanentModelTool as ModelToolName };
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
export type CapabilityRegistry = {
  /** Trusted Alo transport. Production dispatch fails closed when unavailable. */
  forwardModelTool?: (name: string, args: unknown, context: ActionContext) => Promise<ActionResult | undefined>;
  normalize?: (
    name: string,
    args: Record<string, unknown>,
  ) => { name: string; args: Record<string, unknown> } | Promise<{ name: string; args: Record<string, unknown> }>;
  metadata?: () => CommandMetadata[] | Promise<CommandMetadata[]>;
  nodes: () => CommandNode[] | Promise<CommandNode[]>;
  resolve: (name: string) => CommandResolution | Promise<CommandResolution>;
  list: (category?: string) => ListResult | Promise<ListResult>;
  search: (query: string) => SearchResult | Promise<SearchResult>;
  describe: (ids: string[]) => DescribeResult | Promise<DescribeResult>;
  invoke: (name: string, args: Record<string, unknown>, context: ActionContext) => Promise<ActionResult>;
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
export function canonicalListArguments(args: unknown): { category?: string } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const record = args as Record<string, unknown>;
  const category = trimmedText(record.category) ?? trimmedText(record.path);
  return category ? { category } : {};
}
function trimmedText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}
/** Trusted transport dispatch only; all model tool implementations belong to Alo. */
export async function dispatchModelTool(
  registry: CapabilityRegistry,
  name: string,
  args: unknown,
  context: ActionContext,
): Promise<ActionResult> {
  return withInvocation(context.invocation, async () => {
    const result = await registry.forwardModelTool?.(name, args, context);
    return (
      result ?? {
        action: name,
        status: "error",
        code: "alo_unavailable",
        summary: "Alo tool dispatch is unavailable.",
      }
    );
  });
}

type Child = {
  id: string;
  description: string;
  kind: "read" | "mutation" | "category";
  syntax?: string;
};
