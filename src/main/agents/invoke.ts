import type { z } from "zod";
import type { ChatSettings } from "../../shared/config";
import type { AgentId } from "../../shared/workflows";
import type { ActionResult } from "../../shared/action-contract";
import type {
  CapabilityRegistry,
  ActionContext,
} from "../capabilities/registry";
import {
  streamOllamaTurn,
  type OllamaInvocationOptions,
} from "../services/ollama-turn-stream";
import type { ContextMessage } from "../runtime/context-builder";
import { toOllamaMessages, withUserImages } from "../runtime/ollama-wire";
import type { RequestGate } from "../runtime/request-gate";
import { runTurn, type TurnUpdate } from "../runtime/turn";
import { resolveModelProfile } from "./profiles";
import { withInvocation } from "./policy";
import type { resolveCTS } from "./cts";

export function createTurnBudget(input: {
  signal: AbortSignal;
  durationMs?: number;
  maxInference?: number;
  maxTools?: number;
  now?: () => number;
}): {
  signal: AbortSignal;
  remaining: () => number;
  inference(presentation?: boolean): void;
  tool(): void;
  snapshot: () => { inferences: number; tools: number; deadline: number };
} {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.durationMs ?? 10 * 60_000);
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.durationMs ?? 10 * 60_000),
  ]);
  let inferences = 0;
  let tools = 0;
  return {
    signal,
    remaining: () => Math.max(0, deadline - now()),
    inference(presentation = false): void {
      signal.throwIfAborted();
      if (
        now() >= deadline ||
        inferences >= (input.maxInference ?? 16) - (presentation ? 0 : 1)
      )
        throw new Error(
          "The shared turn inference/deadline budget was reached.",
        );
      inferences += 1;
    },
    tool(): void {
      signal.throwIfAborted();
      if (tools >= (input.maxTools ?? 20))
        throw new Error("The shared turn command budget was reached.");
      tools += 1;
    },
    snapshot: () => ({ inferences, tools, deadline }),
  };
}
export type TurnBudget = ReturnType<typeof createTurnBudget>;

export async function invokeAgent<T>(input: {
  agentId: AgentId;
  modelProfileId: string;
  configured: ChatSettings;
  cts: ReturnType<typeof resolveCTS>;
  value: unknown;
  outputSchema: z.ZodType<T>;
  outputJsonSchema?: Record<string, unknown>;
  history?: ContextMessage[];
  renderValue?: (history: readonly ContextMessage[]) => unknown;
  images?: string[];
  terminalOutput?: (result: ActionResult) => T | undefined;
  registry: CapabilityRegistry;
  context: ActionContext;
  gate: RequestGate;
  budget: TurnBudget;
  presentation?: boolean;
  onUpdate?: (update: TurnUpdate) => void;
  awaitDecision?: Parameters<typeof runTurn>[0]["awaitDecision"];
  model?: (
    messages: ContextMessage[],
    hooks: { signal?: AbortSignal; onText: (text: string) => void },
    invocation: OllamaInvocationOptions,
  ) => Promise<unknown[]>;
}): Promise<{ output: T; outcome: Awaited<ReturnType<typeof runTurn>> }> {
  const { profile, settings } = resolveModelProfile(
    input.modelProfileId,
    input.configured,
  );
  if (
    profile.agentId !== input.agentId ||
    input.cts.policy.agentId !== input.agentId
  )
    throw new Error("Agent/profile/invocation identity mismatch.");
  const signal = AbortSignal.any([
    input.budget.signal,
    AbortSignal.timeout(
      Math.max(1, Math.min(profile.timeoutMs, input.budget.remaining())),
    ),
  ]);
  const invocation: OllamaInvocationOptions = {
    tools: input.agentId === "commander",
    format: input.agentId === "commander" ? undefined : input.outputJsonSchema,
    deadlineMs: Math.max(
      1,
      Math.min(profile.timeoutMs, input.budget.remaining()),
    ),
  };
  const inferenceSource = {
    threadId: input.context.threadId,
    turnId: input.context.turnId,
    invocationId: input.cts.policy.id,
    agentId: input.agentId,
    modelProfileId: profile.id,
    work: "foreground" as const,
    model: settings.model,
    numCtx: settings.numCtx,
    attribution: input.cts.policy.attribution,
  };
  const outcome = await withInvocation(input.cts.policy, () =>
    runTurn({
      userText: JSON.stringify(input.value),
      renderUserText: input.renderValue
        ? (history) => JSON.stringify(input.renderValue!(history))
        : undefined,
      inferenceSource,
      history: input.history ?? [],
      numCtx: settings.numCtx,
      context: {
        ...input.context,
        invocation: input.cts.policy,
        attribution: input.cts.policy.attribution,
      },
      registry: input.registry,
      gate: input.gate,
      signal,
      instructions: [
        input.cts.instructions,
        ...(input.outputJsonSchema
          ? [
              `Return JSON matching this output contract:\n${JSON.stringify(input.outputJsonSchema)}`,
            ]
          : []),
      ].join("\n\n"),
      tools: invocation.tools,
      terminalResult: input.terminalOutput
        ? (result) => {
            const output = input.terminalOutput!(result);
            return output === undefined
              ? undefined
              : JSON.stringify(input.outputSchema.parse(output));
          }
        : undefined,
      awaitDecision: input.awaitDecision,
      onUpdate: input.onUpdate,
      budget: {
        inference: () => input.budget.inference(input.presentation),
        tool: input.budget.tool,
      },
      model: (messages, hooks) =>
        input.model
          ? input.model(messages, hooks, {
              ...invocation,
              onCompletion: hooks.onCompletion,
            })
          : streamOllamaTurn(
              withUserImages(toOllamaMessages(messages), input.images ?? []),
              settings,
              hooks.signal ?? signal,
              hooks.onText,
              { ...invocation, onCompletion: hooks.onCompletion },
            ),
    }),
  );
  if (
    outcome.stop !== "completed" &&
    signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError"
  )
    throw new Error(`The ${profile.id} invocation reached its time limit.`);
  if (outcome.stop !== "completed")
    throw new Error(outcome.summary ?? `Agent stopped: ${outcome.stop}`);
  const parse = (
    content: string,
  ): ReturnType<typeof input.outputSchema.safeParse> => {
    try {
      return input.outputSchema.safeParse(JSON.parse(content));
    } catch {
      return input.outputSchema.safeParse(undefined);
    }
  };
  const parsed = parse(outcome.content);
  if (parsed.success) return { output: parsed.data, outcome };
  if (input.agentId !== "commander" || !input.outputJsonSchema)
    throw new Error("Agent output is not valid contract JSON.");
  // Repair presentation once with tools absent. Completed commands cannot be replayed here.
  const repairOptions = {
    ...invocation,
    tools: false,
    format: input.outputJsonSchema,
  };
  const repaired = await runTurn({
    inferenceSource,
    userText: JSON.stringify({
      task: input.value,
      receipts: outcome.results,
      invalidOutput: outcome.content.slice(0, 8000),
      correction:
        "Return the declared JSON contract. Questions belong in question, not a command. No further actions can be executed.",
    }),
    history: [],
    numCtx: settings.numCtx,
    instructions: `${input.cts.instructions}\nOutput contract:\n${JSON.stringify(input.outputJsonSchema)}`,
    context: input.context,
    registry: input.registry,
    gate: input.gate,
    signal,
    tools: false,
    budget: {
      inference: () => input.budget.inference(input.presentation),
      tool: input.budget.tool,
    },
    model: (messages, hooks) =>
      input.model
        ? input.model(messages, hooks, {
            ...repairOptions,
            onCompletion: hooks.onCompletion,
          })
        : streamOllamaTurn(
            toOllamaMessages(messages),
            settings,
            hooks.signal ?? signal,
            hooks.onText,
            { ...repairOptions, onCompletion: hooks.onCompletion },
          ),
  });
  if (repaired.stop !== "completed")
    throw new Error(`Agent output repair stopped: ${repaired.stop}`);
  const output = input.outputSchema.parse(JSON.parse(repaired.content));
  return {
    output,
    outcome: {
      ...outcome,
      content: repaired.content,
      rounds: outcome.rounds + repaired.rounds,
    },
  };
}
