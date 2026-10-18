import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChatSettings } from "../../shared/config";
import type { ExecutionSummary } from "../../shared/workflows";
import type { FolderCard, RoutingInventory } from "../files/routing-inventory";
import type { CapabilityRegistry } from "../capabilities/registry";
import type { RequestGate } from "../runtime/request-gate";
import type { createWorkflowRegistry } from "../workflows/registry";
import { resolveCTS, type ContextSource } from "./cts";
import {
  constrainedDecision,
  globalDecisionSchema,
  GLOBAL_DECISION_INSTRUCTIONS,
} from "./decision";
import { invokeAgent, type TurnBudget } from "./invoke";

export function bindVaultRouting(
  value: import("./decision").GlobalDecision,
  request: string,
  inventory: RoutingInventory,
): import("./decision").GlobalDecision {
  if (value.kind !== "new" || value.workflowId !== "obsidian") return value;
  const vaults = inventory.folders.filter(
    (folder) => folder.kind === "obsidian",
  );
  if (vaults.length === 1) return { ...value, targetHint: vaults[0]!.id };
  if (vaults.length < 2) return value;
  const named = vaults.filter((vault) =>
    [vault.id, ...vault.aliases].some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(
        `(?:^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`,
        "iu",
      ).test(request);
    }),
  );
  return named.length === 1
    ? { ...value, targetHint: named[0]!.id }
    : {
        kind: "clarify",
        question: `Which vault should I use? Available vaults: ${vaults.map((vault) => vault.aliases[0] ?? vault.id).join(", ")}.`,
      };
}

function mentions(text: string, token: string): boolean {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`,
    "iu",
  ).test(text);
}

function uniqueFolders(folders: FolderCard[]): FolderCard | undefined {
  const unique = [
    ...new Map(folders.map((folder) => [folder.id, folder])).values(),
  ];
  return unique.length === 1 ? unique[0] : undefined;
}

function foldersNamedByAliases(
  text: string,
  folders: readonly FolderCard[],
): FolderCard[] {
  return folders.filter((folder) =>
    [folder.id, ...folder.aliases].some((alias) => mentions(text, alias)),
  );
}

/** Directory names that are also folder aliases stay alias destinations. */
function foldersNamedByDirectories(
  text: string,
  folders: readonly FolderCard[],
): FolderCard[] {
  const aliasTokens = new Set(
    folders.flatMap((folder) =>
      [folder.id, ...folder.aliases].map((alias) => alias.toLowerCase()),
    ),
  );
  return folders.filter((folder) =>
    folder.directories.some((directory) => {
      const normalized = directory.replace(/\\/gu, "/").toLowerCase();
      const base = normalized.split("/").at(-1) ?? normalized;
      return [normalized, base].some(
        (token) => !aliasTokens.has(token) && mentions(text, token),
      );
    }),
  );
}

export function resolveFolderHint(
  hint: string,
  folders: readonly FolderCard[],
): string | undefined {
  const text = hint.trim().toLowerCase().replace(/:$/u, "");
  const exact = folders.find(
    (folder) =>
      folder.id.toLowerCase() === text ||
      folder.aliases.some((alias) => alias.toLowerCase() === text),
  );
  if (exact) return exact.id;
  return uniqueFolders([
    ...foldersNamedByAliases(hint, folders),
    ...foldersNamedByDirectories(hint, folders),
  ])?.id;
}

function directoryDestination(
  request: string,
  folders: readonly FolderCard[],
): FolderCard | undefined {
  const directoryFolder = uniqueFolders(
    foldersNamedByDirectories(request, folders),
  );
  if (!directoryFolder) return undefined;
  const aliasConflict = foldersNamedByAliases(request, folders).some(
    (folder) => folder.id !== directoryFolder.id,
  );
  return aliasConflict ? undefined : directoryFolder;
}

/** Bind a listed subdirectory to its parent folder, then apply vault rules. */
export function bindFolderDecision(
  value: import("./decision").GlobalDecision,
  request: string,
  inventory: RoutingInventory,
): import("./decision").GlobalDecision {
  let output = value;
  if (output.kind === "new" && output.targetHint) {
    const resolved = resolveFolderHint(output.targetHint, inventory.folders);
    if (!resolved)
      throw new Error(
        "The target hint does not match a configured folder ID or alias.",
      );
    output = { ...output, targetHint: resolved };
  }
  output = bindVaultRouting(output, request, inventory);
  if (output.kind !== "clarify") return output;
  const folder = directoryDestination(request, inventory.folders);
  if (!folder) return output;
  return {
    kind: "new",
    workflowId: folder.kind === "obsidian" ? "obsidian" : "commander",
    targetHint: folder.id,
  };
}

export async function routeGlobalRequest(input: {
  request: string;
  threadId: string;
  turnId: string;
  configured: ChatSettings;
  inventory: RoutingInventory;
  workflows: ReturnType<typeof createWorkflowRegistry>["cards"];
  pending: ExecutionSummary[];
  queuedInterruption: boolean;
  contentRefs: { messageId: string; excerpt: string }[];
  sources: ContextSource[];
  registry: CapabilityRegistry;
  gate: RequestGate;
  budget: TurnBudget;
  onInferenceStart?: () => void;
  invocationId?: string;
}): Promise<{
  value: import("./decision").GlobalDecision;
  corrections: number;
}> {
  const cts = resolveCTS({
    invocationId: input.invocationId ?? randomUUID(),
    agentId: "decision",
    ceiling: { modules: [], actions: [] },
    sources: [
      {
        id: "routing",
        kind: "instructions",
        audience: ["decision"],
        text: GLOBAL_DECISION_INSTRUCTIONS,
      },
      ...input.sources,
    ],
  });
  return constrainedDecision({
    schema: globalDecisionSchema,
    invoke: async (correction) => {
      const result = await invokeAgent({
        agentId: "decision",
        modelProfileId: "decision",
        configured: input.configured,
        cts,
        value: {
          request: input.request,
          contentRefs: input.contentRefs.map((ref) => ({
            ...ref,
            excerpt: ref.excerpt.slice(0, 2000),
          })),
          workflows: input.workflows(),
          folders: input.inventory.folders,
          inventoryTruncated: input.inventory.truncated,
          vaultSelection: {
            count: input.inventory.folders.filter(
              (folder) => folder.kind === "obsidian",
            ).length,
            soleVaultAlias:
              input.inventory.folders.filter(
                (folder) => folder.kind === "obsidian",
              ).length === 1
                ? input.inventory.folders.find(
                    (folder) => folder.kind === "obsidian",
                  )!.aliases[0]
                : null,
          },
          pending: input.pending.map(
            ({
              id,
              workflowId,
              definitionVersion,
              revision,
              status,
              question,
              reason,
            }) => ({
              id,
              workflowId,
              definitionVersion,
              revision,
              status,
              question,
              reason,
            }),
          ),
          queuedInterruption: input.queuedInterruption,
          ...(correction ? { correction } : {}),
        },
        outputSchema: globalDecisionSchema,
        outputJsonSchema: z.toJSONSchema(globalDecisionSchema),
        registry: input.registry,
        context: {
          actor: "model",
          threadId: input.threadId,
          turnId: input.turnId,
        },
        gate: input.gate,
        budget: input.budget,
        model: async (messages, hooks, invocation) => {
          input.onInferenceStart?.();
          const { streamOllamaTurn } =
            await import("../services/ollama-turn-stream");
          const { toOllamaMessages } = await import("../runtime/ollama-wire");
          return streamOllamaTurn(
            toOllamaMessages(messages),
            { ...input.configured, think: false, temperature: 0 },
            hooks.signal ?? input.budget.signal,
            hooks.onText,
            invocation,
          );
        },
      });
      if (input.queuedInterruption && result.output.kind === "resume")
        throw new Error(
          "Preexisting queued input cannot answer a pending execution.",
        );
      if (
        result.output.kind === "resume" ||
        result.output.kind === "suspend" ||
        result.output.kind === "cancel"
      ) {
        const selected = result.output;
        if (
          !input.pending.some(
            (execution) =>
              execution.id === selected.executionId &&
              execution.revision === selected.expectedRevision,
          )
        )
          throw new Error(
            "The selected execution/revision is not in the current thread/branch's pending cards.",
          );
      }
      return bindFolderDecision(result.output, input.request, input.inventory);
    },
  });
}
