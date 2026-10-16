import type { StepResult } from "../../shared/workflows";
import { stepResultSchema } from "../../shared/workflows";
import type { WorkflowDefinition, WorkflowStep } from "./definition";
import type { SchemaRegistry } from "./schemas";
import { referencePath } from "./validate";

export type WorkflowCheckpoint = {
  currentStepId: string | null;
  outputs: Record<string, unknown>;
  status: "running" | "completed" | "awaiting_input" | "failed" | "cancelled";
  result?: StepResult;
};

function resolve(
  reference: string,
  input: unknown,
  outputs: Record<string, unknown>,
): unknown {
  const path = referencePath(reference);
  let value: unknown = path[0] === "input" ? input : outputs[path[1]!];
  for (const part of path.slice(path[0] === "input" ? 1 : 3)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
      throw new Error(`Missing bound reference: ${reference}`);
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined)
    throw new Error(`Missing bound reference: ${reference}`);
  return value;
}

/** Sequential deterministic interpreter; all model/command work belongs to the injected runner. */
export async function interpretWorkflow(input: {
  definition: WorkflowDefinition;
  parameters: unknown;
  schemas: SchemaRegistry;
  checkpoint?: WorkflowCheckpoint;
  signal?: AbortSignal;
  run: (
    step: Exclude<WorkflowStep, { type: "branch" } | { type: "workflow" }>,
    bound: unknown,
  ) => Promise<StepResult>;
  settle: (
    step: WorkflowStep,
    state: WorkflowCheckpoint,
  ) => Promise<void> | void;
}): Promise<WorkflowCheckpoint> {
  const { definition, schemas } = input;
  const parameters = schemas
    .get(definition.inputSchemaId)
    .parse(input.parameters);
  const outputs = Object.assign(
    Object.create(null) as Record<string, unknown>,
    input.checkpoint?.outputs ?? {},
  );
  const start = input.checkpoint?.currentStepId;
  let index = start
    ? definition.steps.findIndex((step) => step.id === start)
    : 0;
  if (index < 0)
    throw new Error("Checkpoint step is unavailable in this definition.");
  let state: WorkflowCheckpoint = {
    currentStepId: start ?? definition.steps[0]!.id,
    outputs,
    status: "running",
  };
  if (input.checkpoint?.status === "completed") return input.checkpoint;
  for (
    let count = 0;
    index < definition.steps.length && count < definition.steps.length;
    count += 1
  ) {
    const step = definition.steps[index]!;
    let nextIndex = index + 1;
    let result: StepResult;
    try {
      if (input.signal?.aborted)
        result = {
          status: "cancelled",
          code: "cancelled",
          summary: "The workflow was stopped. Existing receipts are retained.",
        };
      else if (step.type === "workflow")
        result = {
          status: "not_supported",
          code: "nested_workflow_reserved",
          summary: "Referenced workflow execution is reserved in V1.",
        };
      else if (step.type === "branch") {
        const value = resolve(step.value.ref, parameters, outputs);
        const match = step.cases.find((entry) => entry.when === value);
        if (match) {
          nextIndex = definition.steps.findIndex(
            (entry) => entry.id === match.goto,
          );
          if (nextIndex <= index)
            throw new Error("Invalid workflow transition.");
        }
        result = { status: "succeeded", output: null };
      } else {
        const bound = Object.fromEntries(
          Object.entries(step.input).map(([key, value]) => [
            key,
            typeof value === "object" && value !== null
              ? resolve(value.ref, parameters, outputs)
              : value,
          ]),
        );
        const parsedInput = schemas.get(step.inputSchemaId).parse(bound);
        result = stepResultSchema.parse(await input.run(step, parsedInput));
        if (result.status === "succeeded") {
          const output = schemas.get(step.outputSchemaId).parse(result.output);
          if (
            step.type === "decide" &&
            !(
              output &&
              typeof output === "object" &&
              "value" in output &&
              step.choices.includes(output.value as string | boolean)
            )
          )
            throw new Error("Invalid constrained decision.");
          outputs[step.id] = output;
        }
      }
    } catch (error) {
      result = {
        status: input.signal?.aborted ? "cancelled" : "failed",
        code: "invalid_step_result",
        summary: (error instanceof Error
          ? error.message
          : "Invalid step result"
        ).slice(0, 2000),
      };
    }
    const succeeded = result.status === "succeeded";
    const ended =
      succeeded &&
      (("end" in step && step.end === true) ||
        nextIndex >= definition.steps.length);
    state = {
      outputs: structuredClone(outputs),
      currentStepId: succeeded
        ? ended
          ? null
          : definition.steps[nextIndex]!.id
        : step.id,
      status: succeeded
        ? ended
          ? "completed"
          : "running"
        : result.status === "awaiting_input"
          ? "awaiting_input"
          : result.status === "cancelled"
            ? "cancelled"
            : "failed",
      result,
    };
    // Persist the settled result and next program counter before any next invocation.
    await input.settle(step, structuredClone(state));
    if (!succeeded || ended) return state;
    index = nextIndex;
  }
  if (state.status === "running")
    throw new Error("Workflow exceeded its bounded transition count.");
  return state;
}
