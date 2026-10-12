import {
  actionResultSchema,
  DEFAULT_TURN_LIMITS,
  type ActionResult,
} from "../../shared/action-contract";
import { createProductionRegistry } from "../capabilities/catalog";
import {
  dispatchModelTool,
  type ActionContext,
  type CapabilityRegistry,
} from "../capabilities/registry";
import {
  aggregateOllamaToolStream,
  type AggregatedToolCall,
} from "../services/ollama-tool-stream";
import type { MemorySnapshot } from "../../shared/memory";
import {
  buildTurnContext,
  contextTokens,
  type ContextMessage,
  type ContextToolCall,
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
  removedCount: number;
};

export type TurnUpdate =
  | { type: "trimmed"; removedCount: number }
  | { type: "text"; text: string }
  | {
      type: "assistant_tools";
      content: string;
      toolCalls: ContextToolCall[];
    }
  | {
      type: "tool_result";
      toolName: string;
      content: string;
      result: ActionResult;
      call: ContextToolCall;
    }
  | {
      type: "approval";
      toolName: string;
      result: ActionResult;
      call: ContextToolCall;
    }
  | { type: "stop"; stop: TurnStop; content: string; summary?: string };

type ModelHooks = {
  onText: (snapshot: string) => void;
  signal?: AbortSignal;
};

type Model = (
  messages: ContextMessage[],
  hooks: ModelHooks,
) => Promise<unknown[]>;

function toolKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function malformedCall(name: string): ActionResult {
  return actionResultSchema.parse({
    action: name || "tool",
    status: "error",
    code: "malformed_tool_call",
    summary: "The tool call could not be read.",
  });
}

function assignedCall(
  call: AggregatedToolCall,
  rounds: number,
): ContextToolCall {
  return {
    id: call.id || `call-${rounds}-${call.index}`,
    name: call.name,
    arguments: call.arguments,
  };
}

export async function runTurn(input: {
  userText: string;
  history: ContextMessage[];
  numCtx: number;
  memory?: MemorySnapshot;
  context: ActionContext;
  gate: RequestGate;
  model: Model;
  registry?: CapabilityRegistry;
  signal?: AbortSignal;
  onUpdate?: (update: TurnUpdate) => void;
  awaitDecision?: (
    result: ActionResult,
    call: ContextToolCall,
  ) => Promise<ActionResult>;
}): Promise<TurnOutcome> {
  const registry = input.registry ?? createProductionRegistry();
  const budget = Math.floor(input.numCtx * 0.75);
  const built = buildTurnContext({
    history: input.history,
    userText: input.userText,
    toolEvents: [],
    numCtx: input.numCtx,
    ...(input.memory ? { memory: input.memory } : {}),
  });
  if (!built.ok) {
    const outcome: TurnOutcome = {
      stop: "capacity",
      content: "",
      rounds: 0,
      toolRequests: 0,
      results: [],
      summary: built.summary,
      removedCount: 0,
    };
    input.onUpdate?.({
      type: "stop",
      stop: outcome.stop,
      content: "",
      summary: outcome.summary,
    });
    return outcome;
  }

  const messages = built.messages;
  const results: ActionResult[] = [];
  const seen = new Set<string>();
  let rounds = 0;
  let toolRequests = 0;
  input.onUpdate?.({ type: "trimmed", removedCount: built.removedCount });

  const finish = (
    stop: TurnStop,
    content: string,
    summary?: string,
  ): TurnOutcome => {
    const outcome: TurnOutcome = {
      stop,
      content,
      rounds,
      toolRequests,
      results,
      summary,
      removedCount: built.removedCount,
    };
    input.onUpdate?.({ type: "stop", stop, content, summary });
    return outcome;
  };

  while (rounds < DEFAULT_TURN_LIMITS.maxRounds) {
    if (input.signal?.aborted) {
      return finish("cancelled", "", "The turn was cancelled.");
    }
    rounds += 1;
    let chunks: unknown[];
    try {
      chunks = await input.gate.schedule(CHAT_REQUEST_PRIORITY, () =>
        input.model(messages, {
          onText: (text) => input.onUpdate?.({ type: "text", text }),
          signal: input.signal,
        }),
      );
    } catch (error) {
      if (input.signal?.aborted || isAbort(error)) {
        return finish("cancelled", "", "The turn was cancelled.");
      }
      throw error;
    }
    if (input.signal?.aborted) {
      return finish("cancelled", "", "The turn was cancelled.");
    }
    const aggregated = aggregateOllamaToolStream(chunks);
    if (aggregated.content) {
      input.onUpdate?.({ type: "text", text: aggregated.content });
    }
    if (aggregated.toolCalls.length === 0) {
      return finish("completed", aggregated.content);
    }

    const toolCalls = aggregated.toolCalls.map((call) =>
      assignedCall(call, rounds),
    );
    input.onUpdate?.({
      type: "assistant_tools",
      content: aggregated.content,
      toolCalls,
    });
    messages.push({
      role: "assistant",
      content: aggregated.content,
      toolCalls,
    });

    const pushTool = (call: ContextToolCall, result: ActionResult): boolean => {
      results.push(result);
      const toolMessage: ContextToolMessage = {
        role: "tool",
        toolName: call.name || "tool",
        content: JSON.stringify(result),
      };
      messages.push(toolMessage);
      input.onUpdate?.({
        type: "tool_result",
        toolName: toolMessage.toolName,
        content: toolMessage.content,
        result,
        call,
      });
      return contextTokens(messages) > budget;
    };
    const closed = (call: ContextToolCall, summary: string): ActionResult =>
      actionResultSchema.parse({
        action: call.name || "tool",
        status: "cancelled",
        code: "cancelled",
        summary,
      });

    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      if (!call) continue;
      if (toolRequests >= DEFAULT_TURN_LIMITS.maxToolRequests) {
        return finish(
          "limit",
          aggregated.content,
          "The turn reached the tool request limit.",
        );
      }
      const key = toolKey(call.name, call.arguments);
      if (seen.has(key)) {
        return finish(
          "no_progress",
          aggregated.content,
          "The same tool request was repeated without new work.",
        );
      }
      seen.add(key);
      toolRequests += 1;
      let result =
        call.name && isRecord(call.arguments)
          ? dispatchModelTool(
              registry,
              call.name,
              call.arguments,
              input.context,
            )
          : malformedCall(call.name);
      if (result.status === "requires_confirmation") {
        input.onUpdate?.({
          type: "approval",
          toolName: call.name || "tool",
          result,
          call,
        });
        if (!input.awaitDecision) {
          results.push(result);
          return finish(
            "paused",
            aggregated.content,
            "A mutation is waiting for confirmation.",
          );
        }
        try {
          result = await input.awaitDecision(result, call);
        } catch (error) {
          if (!(input.signal?.aborted || isAbort(error))) throw error;
          if (pushTool(call, closed(call, "The turn was cancelled."))) {
            return finish(
              "capacity",
              aggregated.content,
              "The required instructions, user message, and tool results do not fit the context budget.",
            );
          }
          for (const rest of toolCalls.slice(index + 1)) {
            if (
              pushTool(
                rest,
                closed(rest, "The turn was cancelled before this call."),
              )
            ) {
              return finish(
                "capacity",
                aggregated.content,
                "The required instructions, user message, and tool results do not fit the context budget.",
              );
            }
          }
          return finish(
            "cancelled",
            aggregated.content,
            "The turn was cancelled.",
          );
        }
      }
      if (pushTool(call, result)) {
        return finish(
          "capacity",
          aggregated.content,
          "The required instructions, user message, and tool results do not fit the context budget.",
        );
      }
    }
  }

  return finish("limit", "", "The turn reached the round limit.");
}
