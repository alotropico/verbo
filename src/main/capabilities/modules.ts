import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  permitsCommand,
  withInvocation,
  withBoundCommand,
} from "../agents/policy";
import {
  commandFingerprint,
  preparedEffectSchema,
  type EffectPreparation,
  type PreparationOwner,
  type PreparedEffect,
} from "./preparation";
import {
  actionResultSchema,
  type ActionResult,
} from "../../shared/action-contract";
import {
  commandExecutionSchema,
  commandNodeSchema,
  type CommandBinding,
  type CommandExecution,
  type CommandNode,
} from "../../shared/commands";
import {
  createRegistry,
  type ActionContext,
  type Capability,
  type CapabilityRegistry,
  type RegistryOptions,
} from "./registry";

export type CommandDefinition = Omit<Capability, "execute"> & {
  aliases: string[];
  tags: string[];
  parameterHelp: Record<string, string>;
  execution: CommandExecution;
  output: z.ZodType<ActionResult>;
  messages: { failure: string };
  attachments: "none" | "handler_verified";
  configurable: readonly ["aliases"];
  /** Trusted effect preflight; no model-controlled imports or executable paths. */
  preparation?: string;
  prepareChildren?: boolean;
  requirements?: string[];
  effect?: "read" | "write" | "launch" | "process";
};
export type CommandModule = CommandNode & {
  version: number;
  scopes: CommandNode[];
  commands: CommandDefinition[];
};
export type TrustedCommandBindings = {
  preparers?: Record<
    string,
    (
      args: Record<string, unknown>,
      context: ActionContext,
    ) => EffectPreparation | Promise<EffectPreparation>
  >;
  handlers: Record<string, Capability["execute"]>;
  processes: Record<string, Capability["execute"]>;
  aggregators: Record<
    string,
    (action: string, children: ActionResult[]) => ActionResult
  >;
};

const MAX_DEPTH = 8;
const MAX_STEPS = 100;
const MAX_FAN_OUT = 32;
const MAX_RUNTIME_MS = 60_000;

function readBinding(
  binding: CommandBinding,
  input: Record<string, unknown>,
  steps: Map<string, unknown>,
  item?: unknown,
): unknown {
  if ("literal" in binding) return binding.literal;
  let value: unknown =
    binding.from === "input"
      ? input
      : binding.from === "item"
        ? item
        : steps.get(binding.step ?? "");
  for (const segment of binding.path) {
    if (["__proto__", "prototype", "constructor"].includes(segment))
      throw new Error("Unsafe binding.");
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Missing binding.");
    if (!Object.hasOwn(value, segment)) throw new Error("Missing binding.");
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

export function createModuleRegistry(
  modules: CommandModule[],
  bindings: TrustedCommandBindings,
  options: Omit<RegistryOptions, "nodes"> & {
    configureNodes?: (nodes: CommandNode[]) => CommandNode[];
    preparation?: PreparationOwner;
  } = {},
): CapabilityRegistry {
  const definitions = new Map<string, CommandDefinition>();
  const nodes: CommandNode[] = [];
  for (const module of modules) {
    nodes.push(
      commandNodeSchema.parse({
        id: module.id,
        aliases: module.aliases,
        description: module.description,
      }),
    );
    if (!Number.isSafeInteger(module.version) || module.version < 1)
      throw new Error("Invalid module version.");
    nodes.push(...module.scopes.map((scope) => commandNodeSchema.parse(scope)));
    for (const command of module.commands) {
      if (!command.id.startsWith(`${module.id}.`))
        throw new Error(`Command outside its module: ${command.id}`);
      if (definitions.has(command.id))
        throw new Error(`Duplicate command: ${command.id}`);
      commandExecutionSchema.parse(command.execution);
      nodes.push(
        commandNodeSchema.parse({
          id: command.id,
          aliases: command.aliases,
          description: command.description,
        }),
      );
      definitions.set(command.id, command);
      // Examples are teaching input. Inaccurate defaults must not reach discovery.
      if (!command.args.safeParse(command.example).success)
        throw new Error(`Invalid command example: ${command.id}`);
      const execution = command.execution;
      if (
        command.preparation &&
        (!options.preparation || !bindings.preparers?.[command.preparation])
      )
        throw new Error(`Unknown preparation: ${command.preparation}`);
      if (
        command.prepareChildren &&
        (execution.type !== "composite" || !options.preparation)
      )
        throw new Error(`Invalid composite preparation: ${command.id}`);
      if (execution.type === "handler" && !bindings.handlers[execution.handler])
        throw new Error(`Unknown handler: ${execution.handler}`);
      if (
        execution.type === "process" &&
        !bindings.processes[execution.process]
      )
        throw new Error(`Unknown process: ${execution.process}`);
      if (
        execution.type === "composite" &&
        !bindings.aggregators[execution.aggregate]
      )
        throw new Error(`Unknown aggregator: ${execution.aggregate}`);
    }
  }
  function checkGraph(id: string, stack: string[]): void {
    if (stack.includes(id))
      throw new Error(`Command cycle: ${[...stack, id].join(" -> ")}`);
    if (stack.length >= MAX_DEPTH) throw new Error("Command depth exceeded.");
    const command = definitions.get(id);
    if (!command) throw new Error(`Unknown child command: ${id}`);
    if (command.execution.type !== "composite") return;
    const prior = new Set<string>();
    const effects = new Set<string>();
    for (const step of command.execution.steps) {
      if (prior.has(step.id)) throw new Error(`Duplicate step: ${step.id}`);
      for (const binding of [
        ...Object.values(step.args),
        ...(step.forEach ? [step.forEach] : []),
      ]) {
        if (
          "from" in binding &&
          binding.from === "step" &&
          !prior.has(binding.step ?? "")
        )
          throw new Error("A binding must reference an earlier step.");
        if (
          command.prepareChildren &&
          "from" in binding &&
          binding.from === "step" &&
          effects.has(binding.step ?? "")
        )
          throw new Error(
            "Prepared arguments cannot depend on an effect's unknown output.",
          );
      }
      if (step.when && !prior.has(step.when.step))
        throw new Error("A predicate must reference an earlier step.");
      prior.add(step.id);
      const child = definitions.get(step.command);
      if (command.kind === "read" && child?.kind === "mutation")
        throw new Error("A read command cannot contain a mutation.");
      if (command.prepareChildren && step.when && effects.has(step.when.step))
        throw new Error(
          "Prepared predicates cannot depend on an effect's unknown output.",
        );
      if (child?.kind === "mutation") effects.add(step.id);
      checkGraph(step.command, [...stack, id]);
    }
    if (command.prepareChildren && command.execution.onFailure !== "stop")
      throw new Error("Prepared composites must stop on failure.");
  }
  for (const id of definitions.keys()) checkGraph(id, []);

  function signature(id: string): string | undefined {
    const definition = definitions.get(id);
    if (!definition) return undefined;
    return commandFingerprint({
      id,
      version: modules.find((module) => id.startsWith(`${module.id}.`))!
        .version,
      args: z.toJSONSchema(definition.args, { unrepresentable: "any" }),
      output: z.toJSONSchema(definition.output, { unrepresentable: "any" }),
      kind: definition.kind,
      approval: definition.approval,
      effect:
        definition.effect ?? (definition.kind === "read" ? "read" : "write"),
      execution: definition.execution,
      preparation: definition.preparation ?? null,
      prepareChildren: definition.prepareChildren ?? false,
      children:
        definition.execution.type === "composite"
          ? definition.execution.steps.map((step) => signature(step.command))
          : [],
    });
  }
  async function prepareEffect(
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ): Promise<PreparedEffect> {
    if (!permitsCommand(name, false, args))
      throw new Error(
        "Prepared command is outside this invocation's authority.",
      );
    const definition = definitions.get(name);
    if (
      !definition?.preparation ||
      !bindings.preparers?.[definition.preparation]
    )
      throw new Error("This command cannot inherit grouped approval.");
    const parsed = definition.args.parse(args) as Record<string, unknown>;
    const preparation = await bindings.preparers[definition.preparation](
      parsed,
      context,
    );
    return preparedEffectSchema.parse({
      ...preparation,
      action: definition.id,
      args: parsed,
      signature: signature(name),
    });
  }

  // Private backend ancestry/budgets cannot be supplied through action arguments.
  const ancestry = new AsyncLocalStorage<{
    stack: string[];
    budget: { count: number; started: number };
  }>();
  const capabilities = [...definitions.values()].map(
    (definition): Capability => ({
      ...definition,
      async execute(args, context): Promise<ActionResult> {
        const state = ancestry.getStore() ?? {
          stack: [],
          budget: { count: 0, started: Date.now() },
        };
        if (
          state.stack.length >= MAX_DEPTH ||
          state.stack.includes(definition.id) ||
          state.budget.count >= MAX_STEPS ||
          Date.now() - state.budget.started > MAX_RUNTIME_MS
        ) {
          return {
            action: definition.id,
            status: "error",
            code: "command_limit",
            summary: "Operation failed: command execution limit reached.",
          };
        }
        state.budget.count += 1;
        let preparedIndex: number | undefined;
        if (definition.preparation) {
          const effect = await prepareEffect(definition.id, args, context);
          const grant = options.preparation!.consume(effect, context);
          if (grant === "invalid")
            return {
              action: definition.id,
              status: "error",
              code: "invalid_grant",
              summary: "The command no longer matches the confirmed operation.",
            };
          if (grant === "missing")
            return options.preparation!.submit(
              {
                action: definition.id,
                signature: signature(definition.id)!,
                effects: [effect],
                reads: [],
                context,
              },
              registry,
            );
          preparedIndex = grant.index;
        }
        const deadline = AbortSignal.timeout(
          Math.max(1, MAX_RUNTIME_MS - (Date.now() - state.budget.started)),
        );
        const childContext = {
          ...context,
          receiptId: undefined,
          parentReceiptId: context.receiptId,
          signal: context.signal
            ? AbortSignal.any([context.signal, deadline])
            : deadline,
        };
        const nextState = {
          ...state,
          stack: [...state.stack, definition.id],
        };
        const executionContext = { ...context, signal: childContext.signal };
        let result: ActionResult;
        const execution = definition.execution;
        if (execution.type === "handler")
          result = await ancestry.run(nextState, () =>
            bindings.handlers[execution.handler](args, executionContext),
          );
        else if (execution.type === "process")
          result = await ancestry.run(nextState, () =>
            bindings.processes[execution.process](args, executionContext),
          );
        else {
          const steps = new Map<string, unknown>();
          const children: ActionResult[] = [];
          const prepared: PreparedEffect[] = [];
          for (const step of execution.steps) {
            if (step.when) {
              const previous = steps.get(step.when.step) as
                ActionResult | undefined;
              if (previous?.status !== step.when.status) continue;
            }
            const items = step.forEach
              ? readBinding(step.forEach, args, steps)
              : [undefined];
            if (!Array.isArray(items) || items.length > MAX_FAN_OUT)
              throw new Error("Fan-out limit exceeded.");
            const outcomes: ActionResult[] = [];
            for (const item of items) {
              const childArgs = Object.fromEntries(
                Object.entries(step.args).map(([name, binding]) => [
                  name,
                  readBinding(binding, args, steps, item),
                ]),
              );
              const childDefinition = definitions.get(step.command)!;
              const preparing =
                definition.prepareChildren &&
                childDefinition.kind === "mutation";
              if (preparing) {
                if (prepared.length >= MAX_FAN_OUT)
                  throw new Error("Prepared child limit exceeded.");
                prepared.push(
                  await withBoundCommand(step.command, childArgs, () =>
                    prepareEffect(step.command, childArgs, childContext),
                  ),
                );
              }
              const child: ActionResult = preparing
                ? {
                    action: step.command,
                    status: "success",
                    summary: "Prepared command.",
                  }
                : await ancestry.run(nextState, () =>
                    withBoundCommand(step.command, childArgs, () =>
                      registry.invoke(step.command, childArgs, childContext),
                    ),
                  );
              if (!preparing) children.push(child);
              outcomes.push(child);
              if (
                child.status === "requires_confirmation" ||
                child.status === "cancelled" ||
                (child.status !== "success" &&
                  child.status !== "partial" &&
                  execution.onFailure === "stop")
              ) {
                return definition.output.parse(
                  bindings.aggregators[execution.aggregate](
                    definition.id,
                    children,
                  ),
                );
              }
            }
            steps.set(step.id, step.forEach ? outcomes : outcomes[0]);
          }
          if (definition.prepareChildren && prepared.length)
            return options.preparation!.submit(
              {
                action: definition.id,
                signature: signature(definition.id)!,
                effects: prepared,
                reads: children,
                aggregate: execution.aggregate,
                context,
              },
              registry,
            );
          result = bindings.aggregators[execution.aggregate](
            definition.id,
            children,
          );
        }
        if (preparedIndex !== undefined)
          result = {
            ...result,
            data: {
              ...(result.data &&
              typeof result.data === "object" &&
              !Array.isArray(result.data)
                ? result.data
                : {}),
              itemIndex: preparedIndex,
            },
          };
        return definition.output.parse(result);
      },
    }),
  );
  const registry: CapabilityRegistry = createRegistry(capabilities, {
    ...options,
    nodes: options.configureNodes?.(nodes) ?? nodes,
  });
  registry.prepareEffect = (name, args, context) =>
    withInvocation(context.invocation, () =>
      prepareEffect(name, args, context),
    );
  registry.metadata = () =>
    [...definitions.values()].map((definition) => ({
      id: definition.id,
      moduleVersion: modules.find((module) =>
        definition.id.startsWith(`${module.id}.`),
      )!.version,
      tags: [...definition.tags],
      parameterHelp: { ...definition.parameterHelp },
      execution: structuredClone(definition.execution),
      requirements: [...(definition.requirements ?? [])],
      effect:
        definition.effect ?? (definition.kind === "read" ? "read" : "write"),
      args: z.toJSONSchema(definition.args, { unrepresentable: "any" }),
      output: z.toJSONSchema(definition.output, { unrepresentable: "any" }),
      messages: { ...definition.messages },
      attachments: definition.attachments,
      configurable: [...definition.configurable],
    }));
  registry.preparationSignature = signature;
  registry.aggregatePrepared = (name, action, children) => {
    const aggregate = bindings.aggregators[name];
    if (!aggregate) throw new Error("Unknown prepared aggregator.");
    return actionResultSchema.parse(aggregate(action, children));
  };
  return registry;
}
