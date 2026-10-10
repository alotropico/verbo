import type { MemorySnapshot } from "../../shared/memory";
import { estimateTokens } from "../services/history-trim";

export const CORE_INSTRUCTIONS =
  "You are Verbo, a local assistant. Use only capabilities.list, capabilities.describe, and actions.invoke. Report an action only with the status the tool returned. Do not request a shell, PowerShell, or filesystem path outside a registered action.";

export type ContextToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ContextTextMessage = {
  role: "system" | "user";
  content: string;
};

export type ContextAssistantMessage = {
  role: "assistant";
  content: string;
  toolCalls?: ContextToolCall[];
};

export type ContextToolMessage = {
  role: "tool";
  toolName: string;
  content: string;
};

export type ContextMessage =
  ContextTextMessage | ContextAssistantMessage | ContextToolMessage;

export type TurnContextInput = {
  rendererSystem?: string;
  history: ContextMessage[];
  userText: string;
  toolEvents: ContextToolMessage[];
  numCtx: number;
  /** Frozen for the turn. On-demand text is not copied in; counts only. */
  memory?: MemorySnapshot;
  /** Meter preview omits the pending user message. Turns include it. */
  includeUser?: boolean;
};

export function composeSystemPrompt(memory?: MemorySnapshot): string {
  if (
    !memory ||
    (memory.alwaysGlobal.length === 0 &&
      memory.alwaysThread.length === 0 &&
      memory.onDemandGlobalCount === 0 &&
      memory.onDemandThreadCount === 0)
  ) {
    return CORE_INSTRUCTIONS;
  }
  const lines = [CORE_INSTRUCTIONS, "", "Always-on memory:"];
  if (memory.alwaysGlobal.length === 0) lines.push("- none");
  for (const text of memory.alwaysGlobal) lines.push(`- ${text}`);
  if (memory.alwaysThread.length > 0) {
    lines.push("", "Thread notes:");
    for (const text of memory.alwaysThread) lines.push(`- ${text}`);
  }
  if (memory.onDemandGlobalCount > 0 || memory.onDemandThreadCount > 0) {
    lines.push(
      "",
      `On-demand memories available: ${memory.onDemandGlobalCount} global, ${memory.onDemandThreadCount} in this thread. Their text stays out until memory.list or memory.get returns it.`,
    );
  }
  return lines.join("\n");
}

export type TurnContext =
  | { ok: true; messages: ContextMessage[]; removedCount: number }
  | { ok: false; code: "capacity"; summary: string };

function messageTokens(message: ContextMessage): number {
  const calls =
    message.role === "assistant" && message.toolCalls
      ? JSON.stringify(message.toolCalls)
      : "";
  const text =
    message.role === "tool"
      ? `${message.toolName} ${message.content}`
      : `${message.content}${calls}`;
  return estimateTokens(text) + 4;
}

export function contextTokens(messages: readonly ContextMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function historyGroups(history: readonly ContextMessage[]): ContextMessage[][] {
  const groups: ContextMessage[][] = [];
  for (const message of history) {
    const current = groups.at(-1);
    if (message.role === "tool" && current) {
      current.push(message);
      continue;
    }
    groups.push([message]);
  }
  return groups;
}

export function buildTurnContext(input: TurnContextInput): TurnContext {
  const budget = Math.floor(input.numCtx * 0.75);
  const core: ContextTextMessage = {
    role: "system",
    content: composeSystemPrompt(input.memory),
  };
  const latest: ContextTextMessage[] =
    input.includeUser === false
      ? []
      : [{ role: "user", content: input.userText }];
  const mandatory = [core, ...latest, ...input.toolEvents];
  const mandatoryTokens = contextTokens(mandatory);
  if (mandatoryTokens > budget) {
    return {
      ok: false,
      code: "capacity",
      summary:
        "The required instructions, user message, and tool results do not fit the context budget.",
    };
  }

  const kept: ContextMessage[] = [];
  let tokens = mandatoryTokens;
  const groups = historyGroups(input.history);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    const cost = contextTokens(group);
    if (tokens + cost > budget) break;
    kept.unshift(...group);
    tokens += cost;
  }

  return {
    ok: true,
    messages: [core, ...kept, ...latest, ...input.toolEvents],
    removedCount: input.history.length - kept.length,
  };
}
