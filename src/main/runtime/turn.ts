import {
  actionResultSchema,
  DEFAULT_TURN_LIMITS,
  type ActionResult,
} from "../../shared/action-contract";
import { createProductionRegistry } from "../capabilities/catalog";
import {
  canonicalListArguments,
  dispatchModelTool,
  type ActionContext,
  type CapabilityRegistry,
} from "../capabilities/registry";
import {
  aggregateOllamaToolStream,
  type AggregatedOllamaStream,
  type AggregatedToolCall,
} from "../services/ollama-tool-stream";
import type { MemorySnapshot } from "../../shared/memory";
import {
  buildTurnContext,
  contextTokens,
  fitToolMessages,
  type ContextMessage,
  type ContextToolCall,
  type ContextToolMessage,
} from "./context-builder";
import { USER_ABORT_NOTICE } from "../../shared/chat-ipc";
import {
  backendNoticeSchema,
  type BackendNotice,
} from "../../shared/backend-notice";
import { CHAT_REQUEST_PRIORITY, type RequestGate } from "./request-gate";
import { stableCommandJson } from "../capabilities/preparation";
import type { InferenceSource } from "../../shared/inference-metrics";
import { inferenceMeasurements } from "./prompt-eval";

export type TurnStop =
  | "completed"
  | "paused"
  | "cancelled"
  | "limit"
  | "capacity"
  | "no_progress"
  | "failed";

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
  | { type: "notice"; notice: BackendNotice }
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
  onCompletion?: (chunk: unknown) => void;
};

type Model = (
  messages: ContextMessage[],
  hooks: ModelHooks,
) => Promise<unknown[]>;

function toolKey(
  registry: CapabilityRegistry,
  name: string,
  args: unknown,
): string {
  if (
    name === "actions.invoke" &&
    isRecord(args) &&
    typeof args.name === "string"
  ) {
    const normalized = registry.normalize?.(
      args.name,
      isRecord(args.args) ? args.args : {},
    ) ?? { name: args.name, args: args.args ?? {} };
    return `${name}:${stableCommandJson(normalized)}`;
  }
  if (name === "capabilities.list")
    return `${name}:${stableCommandJson(canonicalListArguments(args))}`;
  return `${name}:${stableCommandJson(args)}`;
}

function stalledSummary(results: readonly ActionResult[]): string {
  let blocker: string | undefined;
  for (const result of results) {
    if (result.action.startsWith("capabilities.")) continue;
    if (result.code === "duplicate_feedback" || result.code === "unattempted")
      continue;
    if (result.status === "success" || result.status === "partial") {
      blocker = undefined;
      continue;
    }
    if (
      result.status === "error" ||
      result.status === "denied" ||
      result.status === "not_supported"
    )
      blocker = result.summary;
  }
  return blocker ?? "The same tool request was repeated without new work.";
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
  instructions?: string;
  terminalResult?: (result: ActionResult) => string | undefined;
  tools?: boolean;
  inferenceSource?: InferenceSource;
  renderUserText?: (history: readonly ContextMessage[]) => string;
  budget?: { inference: () => void; tool: () => void };
}): Promise<TurnOutcome> {
  const registry = input.registry ?? createProductionRegistry();
  const budget = Math.floor(input.numCtx * 0.75);
  const built = buildTurnContext({
    history: input.history,
    userText: input.userText,
    renderUserText: input.renderUserText,
    toolEvents: [],
    numCtx: input.numCtx,
    ...(input.memory ? { memory: input.memory } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
  });
  if (!built.ok) {
    input.onUpdate?.({
      type: "notice",
      notice: backendNoticeSchema.parse({
        id: `turn:${input.context.turnId ?? input.context.threadId}:capacity`,
        origin: "backend",
        severity: "error",
        code: "turn_capacity",
        message: built.summary.slice(0, 500),
      }),
    });
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
  let previousKey: string | undefined;
  let previousResult: ActionResult | undefined;
  const seenDiscovery = new Set<string>();
  const failedInvokes = new Set<string>();
  let repeats = 0;
  let rounds = 0;
  let toolRequests = 0;
  let wrote = false;
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
    if (summary)
      input.onUpdate?.({
        type: "notice",
        notice: backendNoticeSchema.parse({
          id: `turn:${input.context.turnId ?? input.context.threadId}:${stop}`,
          origin: "backend",
          severity:
            stop === "completed"
              ? "info"
              : stop === "cancelled" || stop === "paused"
                ? "warning"
                : "error",
          code: `turn_${stop}`,
          message: summary.slice(0, 500),
        }),
      });
    input.onUpdate?.({ type: "stop", stop, content, summary });
    return outcome;
  };

  while (rounds < DEFAULT_TURN_LIMITS.maxRounds) {
    if (input.signal?.aborted) {
      return finish("cancelled", "", USER_ABORT_NOTICE);
    }
    rounds += 1;
    let chunks: unknown[];
    const measurement = input.inferenceSource
      ? inferenceMeasurements.begin(input.inferenceSource)
      : undefined;
    try {
      input.budget?.inference();
      chunks = await input.gate.schedule(
        CHAT_REQUEST_PRIORITY,
        () => {
          measurement?.start();
          return input.model(messages, {
            // Ollama can announce a tool after content. Publish only after the
            // completed invocation proves that it contains no tool requests.
            onText: () => undefined,
            signal: input.signal,
            onCompletion: measurement?.complete,
          });
        },
        input.signal,
      );
      measurement?.finish(undefined, input.signal?.aborted);
    } catch (error) {
      measurement?.finish(error, input.signal?.aborted || isAbort(error));
      if (input.signal?.aborted || isAbort(error)) {
        return finish("cancelled", "", USER_ABORT_NOTICE);
      }
      throw error;
    }
    if (input.signal?.aborted) {
      return finish("cancelled", "", USER_ABORT_NOTICE);
    }
    const aggregated = aggregateOllamaToolStream(chunks);
    if (!aggregated.done || aggregated.malformed > 0) {
      return finish("failed", "", silentReply(aggregated));
    }
    if (aggregated.toolCalls.length === 0) {
      if (aggregated.content.trim()) wrote = true;
      if (aggregated.content) {
        input.onUpdate?.({ type: "text", text: aggregated.content });
      }
      return finish(
        "completed",
        aggregated.content,
        wrote ? undefined : silentReply(aggregated),
      );
    }

    const toolCalls = aggregated.toolCalls.map((call) =>
      assignedCall(call, rounds),
    );
    if (input.tools === false)
      return finish(
        "failed",
        "",
        "A tool-free invocation returned forbidden tool output.",
      );
    input.onUpdate?.({
      type: "assistant_tools",
      content: "",
      toolCalls,
    });
    messages.push({
      role: "assistant",
      content: "",
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
      fitToolMessages(messages, budget);
      return contextTokens(messages) > budget;
    };
    const closed = (call: ContextToolCall, summary: string): ActionResult =>
      actionResultSchema.parse({
        action: call.name || "tool",
        status: "cancelled",
        code: "cancelled",
        summary,
      });
    const settleRemaining = (start: number, summary: string): void => {
      for (const rest of toolCalls.slice(start))
        pushTool(rest, { ...closed(rest, summary), code: "unattempted" });
    };

    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      if (!call) continue;
      if (input.signal?.aborted) {
        settleRemaining(index, "The turn was cancelled before this call.");
        return finish("cancelled", "", USER_ABORT_NOTICE);
      }
      if (toolRequests >= DEFAULT_TURN_LIMITS.maxToolRequests) {
        settleRemaining(
          index,
          "The tool request limit was reached before this call.",
        );
        return finish("limit", "", "The turn reached the tool request limit.");
      }
      const key = toolKey(registry, call.name, call.arguments);
      repeats = key === previousKey ? repeats + 1 : 1;
      const repeatedDiscovery =
        repeats === 1 &&
        call.name.startsWith("capabilities.") &&
        seenDiscovery.has(key);
      const repeatedFailure =
        repeats === 1 &&
        call.name === "actions.invoke" &&
        failedInvokes.has(key);
      if (repeats >= 3 || repeatedDiscovery || repeatedFailure) {
        settleRemaining(index, "The repeated request was not attempted again.");
        return finish("no_progress", "", stalledSummary(results));
      }
      toolRequests += 1;
      if (repeats === 2 && previousResult) {
        if (
          pushTool(call, {
            ...previousResult,
            code: "duplicate_feedback",
            summary:
              `Previous result retained; no new execution. ${previousResult.summary}`.slice(
                0,
                4000,
              ),
          })
        ) {
          settleRemaining(
            index + 1,
            "The context budget was reached before this call.",
          );
          return finish(
            "capacity",
            "",
            "The tool results exceed the context budget.",
          );
        }
        continue;
      }
      previousKey = key;
      if (call.name.startsWith("capabilities.")) seenDiscovery.add(key);
      let result: ActionResult;
      try {
        input.budget?.tool();
        result =
          call.name && isRecord(call.arguments)
            ? await dispatchModelTool(registry, call.name, call.arguments, {
                ...input.context,
                signal: input.signal,
                onProgress: (message) =>
                  input.onUpdate?.({
                    type: "notice",
                    notice: backendNoticeSchema.parse({
                      id: `progress:${call.id}`,
                      origin: "backend",
                      severity: "info",
                      code: "command_progress",
                      message: message.slice(0, 500),
                      commandId:
                        typeof call.arguments === "object" &&
                        call.arguments !== null &&
                        "name" in call.arguments &&
                        typeof call.arguments.name === "string"
                          ? call.arguments.name.slice(0, 128)
                          : call.name,
                    }),
                  }),
              })
            : malformedCall(call.name);
      } catch (error) {
        pushTool(call, {
          action: call.name || "tool",
          status: "error",
          code: "interrupted",
          summary:
            "The call was interrupted. Inspect recorded receipts before retrying effects.",
        });
        settleRemaining(index + 1, "The turn stopped before this call.");
        return finish(
          input.signal?.aborted ? "cancelled" : "failed",
          "",
          (error instanceof Error ? error.message : "Command failed").slice(
            0,
            500,
          ),
        );
      }
      if (result.status === "requires_confirmation") {
        input.onUpdate?.({
          type: "approval",
          toolName: call.name || "tool",
          result,
          call,
        });
        if (!input.awaitDecision) {
          pushTool(call, result);
          settleRemaining(index + 1, "A prior call is awaiting confirmation.");
          return finish(
            "paused",
            "",
            "A mutation is waiting for confirmation.",
          );
        }
        try {
          result = await input.awaitDecision(result, call);
        } catch (error) {
          const cancelled = input.signal?.aborted || isAbort(error);
          pushTool(
            call,
            closed(
              call,
              cancelled
                ? USER_ABORT_NOTICE
                : "Confirmation could not settle; inspect the operation receipt.",
            ),
          );
          settleRemaining(index + 1, "The turn stopped before this call.");
          return finish(
            cancelled ? "cancelled" : "failed",
            "",
            cancelled ? USER_ABORT_NOTICE : "Confirmation failed.",
          );
        }
      }
      if (pushTool(call, result)) {
        settleRemaining(
          index + 1,
          "The context budget was reached before this call.",
        );
        return finish(
          "capacity",
          "",
          "The required instructions, user message, and tool results do not fit the context budget.",
        );
      }
      if (
        call.name === "actions.invoke" &&
        (result.status === "error" ||
          result.status === "denied" ||
          result.status === "not_supported")
      )
        failedInvokes.add(key);
      previousResult = result;
      const terminal = input.terminalResult?.(result);
      if (terminal !== undefined) {
        settleRemaining(
          index + 1,
          "The step reached a terminal command result before this call.",
        );
        return finish("completed", terminal);
      }
    }
  }

  return finish("limit", "", "The turn reached the round limit.");
}

function silentReply(aggregated: AggregatedOllamaStream): string {
  if (aggregated.malformed > 0) return "Ollama's reply could not be read.";
  if (!aggregated.done) return "Ollama closed the stream before a reply.";
  return "Ollama finished without a written reply.";
}
