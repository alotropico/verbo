import {
  DEFAULT_TURN_LIMITS,
  type ActionResult,
} from "../../shared/action-contract";
import { createProductionRegistry } from "../capabilities/catalog";
import {
  dispatchModelTool,
  type ActionContext,
  type CapabilityRegistry,
} from "../capabilities/registry";
import { aggregateOllamaToolStream } from "../services/ollama-tool-stream";
import {
  buildTurnContext,
  type ContextMessage,
  type ContextToolMessage,
} from "./context-builder";
import { CHAT_REQUEST_PRIORITY, type RequestGate } from "./request-gate";

export type TurnStop =
  "completed" | "paused" | "cancelled" | "limit" | "capacity" | "no_progress";

export type TurnOutcome = {
  stop: TurnStop;
  content: string;
  rounds: number;
  toolRequests: number;
  results: ActionResult[];
  summary?: string;
};

type Model = (messages: ContextMessage[]) => Promise<unknown[]>;

function toolKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args)}`;
}

export async function runTurn(input: {
  userText: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  numCtx: number;
  context: ActionContext;
  gate: RequestGate;
  model: Model;
  registry?: CapabilityRegistry;
  signal?: AbortSignal;
}): Promise<TurnOutcome> {
  const registry = input.registry ?? createProductionRegistry();
  const built = buildTurnContext({
    history: input.history,
    userText: input.userText,
    toolEvents: [],
    numCtx: input.numCtx,
  });
  if (!built.ok) {
    return {
      stop: "capacity",
      content: "",
      rounds: 0,
      toolRequests: 0,
      results: [],
      summary: built.summary,
    };
  }

  const messages = built.messages;
  const results: ActionResult[] = [];
  const seen = new Set<string>();
  let rounds = 0;
  let toolRequests = 0;

  while (rounds < DEFAULT_TURN_LIMITS.maxRounds) {
    if (input.signal?.aborted) {
      return {
        stop: "cancelled",
        content: "",
        rounds,
        toolRequests,
        results,
        summary: "The turn was cancelled.",
      };
    }
    rounds += 1;
    const chunks = await input.gate.schedule(CHAT_REQUEST_PRIORITY, () =>
      input.model(messages),
    );
    if (input.signal?.aborted) {
      return {
        stop: "cancelled",
        content: "",
        rounds,
        toolRequests,
        results,
        summary: "The turn was cancelled.",
      };
    }
    const aggregated = aggregateOllamaToolStream(chunks);
    if (aggregated.toolCalls.length === 0) {
      return {
        stop: "completed",
        content: aggregated.content,
        rounds,
        toolRequests,
        results,
      };
    }

    let paused = false;
    messages.push({ role: "assistant", content: aggregated.content });
    for (const call of aggregated.toolCalls) {
      if (toolRequests >= DEFAULT_TURN_LIMITS.maxToolRequests) {
        return {
          stop: "limit",
          content: aggregated.content,
          rounds,
          toolRequests,
          results,
          summary: "The turn reached the tool request limit.",
        };
      }
      const key = toolKey(call.name, call.arguments);
      if (seen.has(key)) {
        return {
          stop: "no_progress",
          content: aggregated.content,
          rounds,
          toolRequests,
          results,
          summary: "The same tool request was repeated without new work.",
        };
      }
      seen.add(key);
      toolRequests += 1;
      const args = isRecord(call.arguments) ? call.arguments : {};
      const result = dispatchModelTool(
        registry,
        call.name,
        args,
        input.context,
      );
      results.push(result);
      const toolMessage: ContextToolMessage = {
        role: "tool",
        toolName: call.name,
        content: JSON.stringify(result),
      };
      messages.push(toolMessage);
      if (result.status === "requires_confirmation") {
        paused = true;
        break;
      }
    }
    if (paused) {
      return {
        stop: "paused",
        content: aggregated.content,
        rounds,
        toolRequests,
        results,
        summary: "A mutation is waiting for confirmation.",
      };
    }
  }

  return {
    stop: "limit",
    content: "",
    rounds,
    toolRequests,
    results,
    summary: "The turn reached the round limit.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
