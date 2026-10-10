import { estimateTokens } from "../services/history-trim";

export const CORE_INSTRUCTIONS =
  "You are Verbo, a local assistant. Use only capabilities.list, capabilities.describe, and actions.invoke. Report an action only with the status the tool returned. Do not request a shell, PowerShell, or filesystem path outside a registered action.";

export type ContextTextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ContextToolMessage = {
  role: "tool";
  toolName: string;
  content: string;
};

export type ContextMessage = ContextTextMessage | ContextToolMessage;

export type TurnContextInput = {
  rendererSystem?: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
  toolEvents: ContextToolMessage[];
  numCtx: number;
};

export type TurnContext =
  | { ok: true; messages: ContextMessage[]; removedCount: number }
  | { ok: false; code: "capacity"; summary: string };

function messageTokens(message: ContextMessage): number {
  const text =
    message.role === "tool"
      ? `${message.toolName} ${message.content}`
      : message.content;
  return estimateTokens(text) + 4;
}

export function buildTurnContext(input: TurnContextInput): TurnContext {
  const budget = Math.floor(input.numCtx * 0.75);
  const core: ContextTextMessage = {
    role: "system",
    content: CORE_INSTRUCTIONS,
  };
  const latest: ContextTextMessage = { role: "user", content: input.userText };
  const mandatory = [core, latest, ...input.toolEvents];
  const mandatoryTokens = mandatory.reduce(
    (sum, message) => sum + messageTokens(message),
    0,
  );
  if (mandatoryTokens > budget) {
    return {
      ok: false,
      code: "capacity",
      summary:
        "The required instructions, user message, and tool results do not fit the context budget.",
    };
  }

  const kept: ContextTextMessage[] = [];
  let tokens = mandatoryTokens;
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index];
    if (!message) continue;
    const cost = messageTokens(message);
    if (tokens + cost > budget) break;
    kept.unshift(message);
    tokens += cost;
  }

  return {
    ok: true,
    messages: [core, ...kept, latest, ...input.toolEvents],
    removedCount: input.history.length - kept.length,
  };
}
