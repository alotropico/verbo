import { lstatSync, readFileSync } from "node:fs";
import type { AgentId, WorkflowAttribution } from "../../shared/workflows";
import type { CapabilityPatch, ContextPatch } from "../workflows/definition";
import { AGENT_PROFILES, IMMUTABLE_AGENT_INSTRUCTIONS } from "./profiles";
import {
  createInvocationPolicy,
  type CapabilityGrant,
  type InvocationPolicy,
} from "./policy";

export type ContextSource = {
  id: string;
  text: string;
  audience: AgentId[];
  kind: "instructions" | "data";
};
export function resolveCTS(input: {
  invocationId: string;
  agentId: AgentId;
  workflow?: ContextPatch;
  step?: ContextPatch;
  capabilities?: CapabilityPatch;
  ceiling: CapabilityGrant;
  sources: ContextSource[];
  attribution?: WorkflowAttribution;
  trustedInstructions?: string;
  ledger?: InvocationPolicy["ledger"];
}): { instructions: string; sourceIds: string[]; policy: InvocationPolicy } {
  const profile = AGENT_PROFILES[input.agentId];
  let ids = [...profile.contextSources];
  for (const patch of [input.workflow, input.step]) {
    if (!patch) continue;
    if (patch.replace) ids = [...patch.replace];
    ids = [...new Set([...ids, ...(patch.include ?? [])])].filter(
      (id) => !patch.exclude?.includes(id),
    );
  }
  const byId = new Map(input.sources.map((source) => [source.id, source]));
  const sources = ids.flatMap((id) => {
    const source = byId.get(id);
    if (!source) {
      if (profile.contextSources.includes(id)) return [];
      throw new Error(`Unknown context source: ${id}`);
    }
    if (!source.audience.includes(input.agentId))
      throw new Error(
        `Context source ${id} is not assigned to ${input.agentId}.`,
      );
    return [source];
  });
  let grants = {
    modules: [...profile.grants.modules],
    actions: [...profile.grants.actions],
  };
  const patch = input.capabilities;
  if (patch && patch.mode !== "inherit") {
    const requested = {
      modules: patch.modules ?? [],
      actions: patch.actions ?? [],
    };
    if (patch.mode === "replace")
      grants = {
        modules: [...requested.modules],
        actions: [...requested.actions],
      };
    if (patch.mode === "extend")
      grants = {
        modules: [...new Set([...grants.modules, ...requested.modules])],
        actions: [...new Set([...grants.actions, ...requested.actions])],
      };
    if (patch.mode === "limit")
      grants = {
        modules: grants.modules.filter((module) =>
          requested.modules.includes(module),
        ),
        actions: [...new Set([...grants.actions, ...requested.actions])].filter(
          (action) =>
            (requested.actions.includes(action) ||
              requested.modules.some((module) =>
                action.startsWith(`${module}.`),
              )) &&
            (profile.grants.actions.includes(action) ||
              profile.grants.modules.some((module) =>
                action.startsWith(`${module}.`),
              )),
        ),
      };
  }
  grants = {
    modules: grants.modules.filter((module) =>
      input.ceiling.modules.includes(module),
    ),
    actions: grants.actions.filter(
      (action) =>
        input.ceiling.actions.includes(action) ||
        input.ceiling.modules.some((module) => action.startsWith(`${module}.`)),
    ),
  };
  if (!profile.tools) grants = { modules: [], actions: [] };
  const renderedSources = sources
    .filter((source) => source.text.trim().length > 0)
    .map(
      (source) =>
        `${source.kind === "data" ? "Untrusted task data" : "Assigned guidance"} (${source.id}):\n${source.text}`,
    );
  const instructions = [
    IMMUTABLE_AGENT_INSTRUCTIONS,
    profile.instructions,
    input.workflow?.instructions,
    input.step?.instructions,
    input.trustedInstructions,
    ...renderedSources,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    instructions,
    sourceIds: sources.map((source) => source.id),
    policy: createInvocationPolicy({
      id: input.invocationId,
      agentId: input.agentId,
      allowed: grants,
      discoverable: grants,
      exposed: profile.tools,
      forbidden: ["obsidian.eval", "shell", "powershell"],
      attribution: input.attribution,
      ledger: input.ledger,
    }),
  };
}

/** Only a caller-resolved, permission-checked file can become step guidance. */
export function readBoundedGuidance(input: {
  path: string;
  expectedPath: string;
  permitted: boolean;
  maxBytes?: number;
}): string {
  if (!input.permitted || input.path !== input.expectedPath)
    throw new Error("Guidance file is not authorized.");
  const stats = lstatSync(input.path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size > (input.maxBytes ?? 16_000)
  )
    throw new Error("Guidance is unavailable or exceeds its bound.");
  return new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(input.path),
  );
}
