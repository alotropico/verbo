import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChatEvent, ChatTurnStop } from "../../shared/chat-ipc";
import type { ChatSettings } from "../../shared/config";
import {
  validQuestionAnswer,
  type AgentId,
  type PendingQuestion,
  type StepResult,
  type WorkflowAttribution,
} from "../../shared/workflows";
import { createActionLedger } from "../agents/action-ledger";
import { resolveCTS, type ContextSource } from "../agents/cts";
import { constrainedDecision, localDecisionSchema } from "../agents/decision";
import { createTurnBudget, invokeAgent } from "../agents/invoke";
import { routeGlobalRequest } from "../agents/routing";
import {
  resolveAssignedGuidance,
  guidanceConfigurationVersion,
  type GuidanceAssignment,
} from "../agents/guidance";
import type { CapabilityRegistry } from "../capabilities/registry";
import { loadThreadHistory } from "../db/history";
import { createMemoryStore } from "../db/memory";
import { createScopeStore } from "../db/scopes";
import {
  createWorkflowExecutionStore,
  type WorkflowExecution,
} from "../db/workflow-executions";
import type { AssetStore } from "../files/asset-store";
import type { RoutingInventory } from "../files/routing-inventory";
import type { WorkflowStep } from "../workflows/definition";
import {
  interpretWorkflow,
  type WorkflowCheckpoint,
} from "../workflows/interpreter";
import { createWorkflowRegistry } from "../workflows/registry";
import { commanderOutputSchema, writerBodySchema } from "../workflows/schemas";
import type { TurnWork } from "./controller";
import {
  applyExecutionDisposition,
  executionOnBranch,
} from "./workflow-continuation";
import {
  deterministicPresentation,
  freezeWorkflowOutcome,
  PRESENTATION_INSTRUCTION,
  readableReportInput,
  presentationSchema,
  validatePresentation,
} from "./workflow-outcome";
import type { RequestGate } from "./request-gate";
import type { TurnUpdate } from "./turn";
import { resolveWorkflowTarget } from "./workflow-target";
import { refreshModelVision } from "./model-vision";

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}
function parametersRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function executionSummary(
  execution: WorkflowExecution,
): import("../../shared/workflows").ExecutionSummary {
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    definitionVersion: execution.definitionVersion,
    revision: execution.revision,
    status: execution.status,
    branchAnchorId: execution.branchAnchorId,
    currentStepId: execution.currentStepId,
    ...(execution.question ? { question: execution.question } : {}),
    ...(execution.reason ? { reason: execution.reason } : {}),
  };
}

/** Workflow collaborator of the Controller; it never releases a slot or finalizes a visible turn. */
export async function runWorkflowTurn(
  input: Parameters<TurnWork>[0] & {
    database: DatabaseSync;
    settings: ChatSettings;
    assets: AssetStore;
    registry: CapabilityRegistry;
    gate: RequestGate;
    inventory: RoutingInventory;
    awaitDecision: Parameters<typeof invokeAgent>[0]["awaitDecision"];
    invoke?: typeof invokeAgent;
    route?: typeof routeGlobalRequest;
    guidance?: GuidanceAssignment[];
  },
): Promise<{ stop: ChatTurnStop; summary?: string }> {
  const { envelope, database, emit, persist } = input;
  const store = createWorkflowExecutionStore(database);
  const workflows = createWorkflowRegistry();
  const scopes = createScopeStore(database);
  const budget = createTurnBudget({ signal: input.signal });
  const invoke = input.invoke ?? invokeAgent;
  const memory = createMemoryStore(database);
  const guidanceVersion = guidanceConfigurationVersion(input.guidance ?? []);
  const notes = (audience: AgentId): ContextSource[] => {
    const snapshot = memory.snapshot(envelope.threadId, audience);
    return [
      {
        id: `notes.${audience}`,
        audience: [audience],
        kind: "data",
        text: [...snapshot.alwaysGlobal, ...snapshot.alwaysThread].join("\n"),
      },
    ];
  };
  const all = loadThreadHistory(database, envelope.threadId).messages;
  const byId = new Map(all.map((item) => [item.message.id, item]));
  const branch: typeof all = [];
  let head = envelope.branchAnchor;
  const seen = new Set<string>();
  while (head && !seen.has(head)) {
    seen.add(head);
    const item = byId.get(head);
    if (!item) break;
    branch.unshift(item);
    head = item.parentId ?? undefined;
  }
  const contentRefs = branch.slice(-4).map((item) => ({
    messageId: item.message.id,
    excerpt: plainText(item.message.content).slice(0, 2000),
  }));
  let pending = store
    .list(envelope.threadId)
    .filter(
      (execution) =>
        ["awaiting_input", "suspended"].includes(execution.status) &&
        executionOnBranch(
          database,
          execution.id,
          envelope.threadId,
          envelope.branchAnchor,
        ),
    );
  const queuedInterruption = envelope.admission === "promoted";
  if (queuedInterruption) {
    for (const execution of pending.filter(
      (entry) => entry.status === "awaiting_input",
    )) {
      const suspended = store.update(execution.id, execution.revision, {
        status: "suspended",
        checkpoint: execution.checkpoint,
        reason: "queued_interruption",
      });
      emit({ type: "execution", execution: executionSummary(suspended) });
    }
    pending = store
      .list(envelope.threadId)
      .filter(
        (execution) =>
          execution.status === "suspended" &&
          executionOnBranch(
            database,
            execution.id,
            envelope.threadId,
            envelope.branchAnchor,
          ),
      );
  }
  const routingInvocationId = randomUUID();
  const routingStage = (
    state: "started" | "succeeded" | "failed" | "cancelled",
    selected?: Awaited<ReturnType<typeof routeGlobalRequest>>["value"],
  ): void => {
    const stage = {
      invocationId: routingInvocationId,
      agentId: "decision" as const,
      modelProfileId: "decision" as const,
      state,
      ...(selected
        ? {
            disposition: selected.kind,
            ...(selected.kind === "new"
              ? { workflowId: selected.workflowId }
              : {}),
          }
        : {}),
    };
    persist("stage", stage);
    emit({ type: "routing_stage", stage });
  };
  routingStage("started");
  let routed: Awaited<ReturnType<typeof routeGlobalRequest>>;
  try {
    routed = await (input.route ?? routeGlobalRequest)({
      invocationId: routingInvocationId,
      request: envelope.text,
      threadId: envelope.threadId,
      turnId: envelope.turnId,
      configured: input.settings,
      inventory: input.inventory,
      workflows: workflows.cards,
      pending: pending.map(executionSummary),
      queuedInterruption,
      contentRefs,
      sources: notes("decision"),
      registry: input.registry,
      gate: input.gate,
      budget,
    });
  } catch (error) {
    routingStage(input.signal.aborted ? "cancelled" : "failed");
    throw error;
  }
  routingStage("succeeded", routed.value);
  const decision = routed.value;
  const present = async (
    outcome: ReturnType<typeof freezeWorkflowOutcome>,
    stop: ChatTurnStop,
  ): Promise<string> => {
    const fallback = deterministicPresentation(outcome);
    input.emit({ type: "trace_clock", reporting: true, stop });
    input.checkpointPresentation(fallback, stop);
    if (budget.signal.aborted) return fallback;
    try {
      const cts = resolveCTS({
        invocationId: randomUUID(),
        agentId: "writer",
        ceiling: { modules: [], actions: [] },
        sources: notes("writer"),
        trustedInstructions: PRESENTATION_INSTRUCTION,
      });
      const response = await invoke({
        agentId: "writer",
        modelProfileId: "responder",
        configured: input.settings,
        cts,
        value: readableReportInput(outcome),
        outputSchema: presentationSchema,
        outputJsonSchema: z.toJSONSchema(presentationSchema),
        registry: input.registry,
        context: {
          actor: "model",
          threadId: envelope.threadId,
          turnId: envelope.turnId,
        },
        gate: input.gate,
        budget,
        presentation: true,
      });
      return validatePresentation(outcome, response.output) ?? fallback;
    } catch {
      /* The frozen result is sufficient; presentation never repeats effects. */
      return fallback;
    }
  };
  let execution: WorkflowExecution;
  let resuming = false;
  if (decision.kind === "clarify") {
    emit({ type: "delta", text: decision.question });
    return { stop: "completed" };
  }
  if (decision.kind !== "new") {
    const current = store.read(decision.executionId);
    if (!current) throw new Error("That execution is unavailable.");
    const definition = workflows.get(
      current.workflowId,
      current.definitionVersion,
    );
    execution = applyExecutionDisposition({
      database,
      threadId: envelope.threadId,
      branchHead: envelope.branchAnchor,
      disposition: decision,
      queuedInterruption,
      definitionVersion: definition.version,
    });
    store.linkTurn({
      executionId: execution.id,
      turnId: envelope.turnId,
      userMessageId: envelope.userMessageId,
      assistantMessageId: envelope.assistantMessageId,
      relation: decision.kind === "cancel" ? "cancel" : "resume",
    });
    if (execution.status !== "running") {
      const outcome = freezeWorkflowOutcome(database, execution);
      emit({ type: "execution", execution: executionSummary(execution) });
      const stop: ChatTurnStop =
        execution.status === "cancelled" ? "cancelled" : "completed";
      const text = await present(outcome, stop);
      persist("assistant_text", { content: text });
      emit({ type: "delta", text });
      return { stop };
    }
    resuming = true;
  } else {
    for (const prior of pending.filter(
      (entry) => entry.status === "awaiting_input",
    )) {
      const suspended = store.update(prior.id, prior.revision, {
        status: "suspended",
        checkpoint: prior.checkpoint,
        reason: "unrelated_request",
      });
      emit({ type: "execution", execution: executionSummary(suspended) });
    }
    const definition = workflows.get(decision.workflowId);
    execution = store.create({
      workflowId: definition.id,
      definitionVersion: definition.version,
      threadId: envelope.threadId,
      branchAnchorId: envelope.branchAnchor ?? null,
      requestMessageId: envelope.userMessageId,
      parameters: {
        target: decision.targetHint
          ? (scopes
              .list()
              .find(
                (scope) =>
                  scope.id === decision.targetHint ||
                  scope.aliases.includes(decision.targetHint!.toLowerCase()),
              )?.id ?? decision.targetHint)
          : null,
        contentRefs: contentRefs.map((ref) => ref.messageId),
        attachmentIds: envelope.attachmentIds,
      },
      firstStepId: definition.steps[0]!.id,
      targets: { guidanceConfiguration: guidanceVersion },
    });
    for (const id of envelope.attachmentIds) store.pin(execution.id, id);
    store.linkTurn({
      executionId: execution.id,
      turnId: envelope.turnId,
      userMessageId: envelope.userMessageId,
      assistantMessageId: envelope.assistantMessageId,
      relation: "start",
    });
  }
  const definition = workflows.get(
    execution.workflowId,
    execution.definitionVersion,
  );
  if (execution.stateSchemaVersion !== 1)
    throw new Error(
      "The execution state version is incompatible; review is required.",
    );
  const originalMessage = byId.get(execution.requestMessageId)?.message;
  if (!originalMessage)
    throw new Error(
      "The original request reference is unavailable. It will not be regenerated.",
    );
  const request = plainText(originalMessage.content);
  const answers = parametersRecord(execution.parameters.answers);
  const attachmentIds = Array.isArray(execution.parameters.attachmentIds)
    ? execution.parameters.attachmentIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const imagePayloads = input.assets.imagePayloads(
    envelope.threadId,
    attachmentIds,
  );
  const images =
    imagePayloads.length && (await refreshModelVision(input.settings.model))
      ? imagePayloads
      : [];
  let selectedTarget: string | null =
    typeof execution.parameters.target === "string"
      ? execution.parameters.target
      : null;
  const saveContent = (text: string, name: string): string => {
    const stored = input.assets.put({
      threadId: envelope.threadId,
      name,
      mediaType: "text/markdown",
      bytes: Buffer.from(text, "utf8"),
    });
    if (!stored.ok) throw new Error(stored.summary);
    store.pin(execution.id, stored.attachment.id);
    return stored.attachment.id;
  };
  const stage = (
    step: WorkflowStep,
    stepRunId: string,
    state: Extract<ChatEvent, { type: "stage" }>["stage"]["state"],
    attribution?: WorkflowAttribution,
    summary?: string,
  ): void => {
    const value = {
      attribution: attribution ?? {
        executionId: execution.id,
        workflowId: execution.workflowId,
        definitionVersion: execution.definitionVersion,
        stepId: step.id,
        stepRunId,
      },
      state,
      label: step.id,
      ...(summary ? { summary } : {}),
    };
    persist("stage", value);
    emit({ type: "stage", stage: value });
  };
  const guidanceChanged =
    resuming && execution.targets.guidanceConfiguration !== guidanceVersion;
  const targetBinding =
    execution.workflowId === "obsidian" ? "vault" : "target";
  const chosen = resolveWorkflowTarget({
    scopes: scopes.list(),
    target: selectedTarget,
    answer: answers[targetBinding],
    prior: execution.targets[targetBinding],
    vault: execution.workflowId === "obsidian",
  });
  const preconditionQuestion: PendingQuestion | undefined = chosen.question;
  if (chosen.scope) {
    selectedTarget = chosen.scope.id;
    delete answers[targetBinding];
    execution = store.update(execution.id, execution.revision, {
      status: "running",
      checkpoint: execution.checkpoint,
      parameters: { ...execution.parameters, target: selectedTarget, answers },
      targets: { ...execution.targets, [targetBinding]: chosen.snapshot },
    });
  }
  let guidanceProblem = guidanceChanged
    ? "The guidance assignments changed or were removed. Review them and start a new execution."
    : undefined;
  if (resuming && !guidanceProblem) {
    try {
      const versions: Record<string, string> = {};
      for (const agentId of [
        "decision",
        "conversational",
        "writer",
        "commander",
      ] as const)
        Object.assign(
          versions,
          resolveAssignedGuidance({
            assignments: input.guidance ?? [],
            agentId,
            scopes: scopes.list(),
            selectedScopeId: selectedTarget,
          }).versions,
        );
      const prior = parametersRecord(execution.targets.guidanceVersions);
      if (Object.keys(prior).some((id) => versions[id] !== prior[id]))
        guidanceProblem =
          "Previously used guidance is no longer approved for this target. Review it and start a new execution.";
    } catch {
      guidanceProblem =
        "Assigned guidance changed or became unavailable. Review it before continuing; retained work has not been replayed.";
    }
  }
  let activeStepRunId: string | undefined;
  let activeAttribution: WorkflowAttribution | undefined;
  const completedReceipts = (): { id: string; result: unknown }[] =>
    database
      .prepare(
        `SELECT id,result_json FROM command_receipts WHERE json_extract(attribution_json,'$.executionId')=? ORDER BY started_at LIMIT 100`,
      )
      .all(execution.id)
      .map((row) => ({
        id: String(row.id),
        result: JSON.parse(String(row.result_json)),
      }));
  const onUpdate = (update: TurnUpdate): void => {
    if (update.type === "notice") {
      persist("backend_notice", update.notice);
      emit({ type: "backend_notice", notice: update.notice });
    }
    if (update.type === "assistant_tools") {
      persist("assistant_tools", { content: "", toolCalls: update.toolCalls });
      emit({
        type: "tools",
        content: "",
        calls: update.toolCalls,
        ...(activeAttribution ? { attribution: activeAttribution } : {}),
      });
    }
    if (update.type === "tool_result") {
      persist("tool_result", {
        toolName: update.toolName,
        content: update.content,
        toolCallId: update.call.id,
        ...(activeAttribution ? { attribution: activeAttribution } : {}),
      });
      emit({
        type: "tool_result",
        toolCallId: update.call.id,
        name: update.call.name,
        args: update.call.arguments,
        result: update.result,
        ...(activeAttribution ? { attribution: activeAttribution } : {}),
      });
    }
    if (update.type === "approval")
      emit({
        type: "approval",
        toolCallId: update.call.id,
        name: update.call.name,
        args: update.call.arguments,
        result: update.result,
      });
  };
  let finalState: WorkflowCheckpoint;
  try {
    finalState = await interpretWorkflow({
      definition,
      parameters: { request, target: selectedTarget },
      schemas: workflows.schemas,
      checkpoint: execution.checkpoint,
      signal: budget.signal,
      run: async (step, bound): Promise<StepResult> => {
        const claim = store.beginStep(
          execution,
          step.id,
          envelope.turnId,
          step.outputSchemaId,
        );
        execution = claim.execution;
        activeStepRunId = claim.stepRunId;
        const invocationId = randomUUID();
        const agentId = step.type === "decide" ? "decision" : step.agentId;
        const attribution: WorkflowAttribution = {
          executionId: execution.id,
          workflowId: execution.workflowId,
          definitionVersion: execution.definitionVersion,
          stepId: step.id,
          stepRunId: claim.stepRunId,
          invocationId,
          agentId,
          modelProfileId: step.modelProfileId,
        };
        activeAttribution = attribution;
        stage(step, claim.stepRunId, "started", attribution);
        if (guidanceProblem)
          return {
            status: "blocked",
            code: "guidance_changed",
            summary: guidanceProblem,
          };
        if (preconditionQuestion)
          return { status: "awaiting_input", question: preconditionQuestion };
        const guidance = resolveAssignedGuidance({
          assignments: input.guidance ?? [],
          agentId,
          scopes: scopes.list(),
          selectedScopeId: selectedTarget,
        });
        const priorVersions = parametersRecord(
          execution.targets.guidanceVersions,
        );
        if (Object.keys(guidance.versions).length)
          execution = store.update(execution.id, execution.revision, {
            status: "running",
            checkpoint: execution.checkpoint,
            targets: {
              ...execution.targets,
              guidanceVersions: { ...priorVersions, ...guidance.versions },
            },
          });
        const cts = resolveCTS({
          invocationId,
          agentId,
          workflow: definition.context,
          step: step.context,
          ...(guidance.sources.length
            ? {
                step: {
                  ...step.context,
                  include: [
                    ...(step.context?.include ?? []),
                    ...guidance.sources.map((source) => source.id),
                  ],
                },
              }
            : {}),
          capabilities: step.type === "agent" ? step.capabilities : undefined,
          ceiling: {
            modules: input.registry
              .nodes()
              .filter((node) => !node.id.includes("."))
              .map((node) => node.id),
            actions: [],
          },
          sources: [...notes(agentId), ...guidance.sources],
          attribution,
          ledger:
            agentId === "commander"
              ? createActionLedger({
                  database,
                  executionId: execution.id,
                  stepRunId: claim.stepRunId,
                  resuming,
                  preconditions: {
                    scopeGeneration: scopes.generation(),
                    targets: execution.targets,
                  },
                })
              : undefined,
          trustedInstructions:
            execution.workflowId === "obsidian"
              ? `Selected vault scope ID: ${selectedTarget}. Use it for every operation. Preserve supplied path/revision and contentRef. Writer composes body only; Commander integrates known metadata, omits optional unknown values, and never invents a taxonomy.`
              : undefined,
        });
        const boundData = parametersRecord(bound);
        const sourceRef =
          typeof boundData.sourceRef === "string"
            ? boundData.sourceRef
            : undefined;
        const source = sourceRef
          ? input.assets.text(envelope.threadId, sourceRef)
          : undefined;
        if (sourceRef && source === null)
          return {
            status: "blocked",
            code: "content_unavailable",
            summary:
              "The retained original note body is unavailable. Read it again explicitly; it will not be recreated from intent.",
          };
        const value = {
          ...boundData,
          ...(source !== undefined ? { source } : {}),
          answers,
          completedReceipts: completedReceipts(),
          contentRefs,
          attachments: input.assets.excerpt(
            envelope.threadId,
            Array.isArray(execution.parameters.attachmentIds)
              ? (execution.parameters.attachmentIds as string[])
              : [],
          ),
        };
        if (step.type === "decide") {
          if (
            typeof answers.operation === "string" &&
            step.choices.includes(answers.operation)
          )
            return {
              status: "succeeded",
              output: { value: answers.operation },
            };
          const schema = localDecisionSchema(step.choices);
          const result = await constrainedDecision({
            schema,
            invoke: async (correction) =>
              (
                await invoke({
                  agentId: "decision",
                  modelProfileId: step.modelProfileId,
                  configured: input.settings,
                  cts,
                  value: {
                    ...value,
                    choices: step.choices,
                    ...(correction ? { correction } : {}),
                  },
                  outputSchema: schema,
                  outputJsonSchema: z.toJSONSchema(schema),
                  registry: input.registry,
                  context: {
                    actor: "model",
                    threadId: envelope.threadId,
                    turnId: envelope.turnId,
                  },
                  gate: input.gate,
                  budget,
                })
              ).output,
          });
          return result.value.kind === "selected"
            ? { status: "succeeded", output: { value: result.value.value } }
            : {
                status: "awaiting_input",
                question: {
                  text: result.value.question,
                  required: true,
                  expected: { type: "enum", values: step.choices.map(String) },
                  binding: "operation",
                },
              };
        }
        if (step.agentId !== "commander") {
          const result = await invoke({
            agentId: step.agentId,
            modelProfileId: step.modelProfileId,
            configured: input.settings,
            cts,
            value,
            renderValue:
              step.agentId === "conversational"
                ? (history) => {
                    const represented = new Set(
                      history.map((message) => message.messageId),
                    );
                    return {
                      ...value,
                      contentRefs: contentRefs.filter(
                        (ref) => !represented.has(ref.messageId),
                      ),
                    };
                  }
                : undefined,
            outputSchema: writerBodySchema,
            outputJsonSchema: z.toJSONSchema(writerBodySchema),
            registry: input.registry,
            context: {
              actor: "model",
              threadId: envelope.threadId,
              turnId: envelope.turnId,
            },
            gate: input.gate,
            budget,
            history:
              step.agentId === "conversational"
                ? branch.flatMap((item) =>
                    item.message.role === "user" ||
                    item.message.role === "assistant"
                      ? [
                          {
                            role: item.message.role,
                            content: plainText(item.message.content),
                            messageId: item.message.id,
                          },
                        ]
                      : [],
                  )
                : [],
            images,
          });
          return {
            status: "succeeded",
            output: {
              contentRef: saveContent(result.output.body, "workflow-draft.md"),
            },
          };
        }
        const operated = await invoke<z.infer<typeof commanderOutputSchema>>({
          agentId: "commander",
          modelProfileId: step.modelProfileId,
          configured: input.settings,
          cts,
          value,
          outputSchema: commanderOutputSchema,
          terminalOutput:
            execution.workflowId === "obsidian"
              ? (result) => {
                  const expectedAction = `obsidian.${boundData.operation === "write" ? "create" : String(boundData.operation)}`;
                  return result.status === "not_supported" ||
                    ["effect_uncertain", "receipt_failed"].includes(
                      result.code ?? "",
                    ) ||
                    (result.action === expectedAction &&
                      ["success", "partial"].includes(result.status))
                    ? {
                        findings: [result.summary],
                        receiptIds: result.receiptId ? [result.receiptId] : [],
                      }
                    : undefined;
                }
              : undefined,
          outputJsonSchema: z.toJSONSchema(commanderOutputSchema),
          registry: input.registry,
          context: {
            actor: "model",
            threadId: envelope.threadId,
            turnId: envelope.turnId,
          },
          gate: input.gate,
          budget,
          onUpdate,
          awaitDecision: input.awaitDecision,
        });
        // Only registry results can supply receipt IDs and read-note identity.
        const receipts = operated.outcome.results.filter(
          (result) => result.receiptId,
        );
        const lastDomainReceipt = receipts.findLast(
          (result) =>
            result.action.startsWith("obsidian.") &&
            result.action !== "obsidian.help",
        );
        const uncertainReceipt = receipts.find((result) =>
          ["effect_uncertain", "receipt_failed"].includes(result.code ?? ""),
        );
        if (uncertainReceipt)
          return {
            status: "blocked",
            code: uncertainReceipt.code!,
            summary: uncertainReceipt.summary.slice(0, 2000),
          };
        if (
          execution.workflowId === "obsidian" &&
          lastDomainReceipt?.status === "not_supported"
        )
          return {
            status: "not_supported",
            code: lastDomainReceipt.code ?? "not_supported",
            summary: lastDomainReceipt.summary.slice(0, 2000),
          };
        const original = receipts.findLast(
          (result) =>
            result.action === "obsidian.read" && result.status === "success",
        );
        const identity = original ? parametersRecord(original.data) : {};
        if (typeof identity.contentRef === "string")
          store.pin(execution.id, identity.contentRef);
        const output = {
          findings: receipts.map((receipt) => receipt.summary).slice(0, 30),
          receiptIds: receipts.map((receipt) => receipt.receiptId!),
          ...(typeof identity.contentRef === "string"
            ? { contentRef: identity.contentRef }
            : {}),
          ...(typeof identity.path === "string" ? { path: identity.path } : {}),
          ...(typeof identity.revision === "string"
            ? { revision: identity.revision }
            : {}),
          ...(operated.output.question
            ? { question: operated.output.question }
            : {}),
        };
        if (
          execution.workflowId === "obsidian" &&
          boundData.operation === "read" &&
          original
        ) {
          if (!output.contentRef || !output.path || !output.revision)
            return {
              status: "blocked",
              code: "read_identity_unavailable",
              summary:
                "The original note read did not retain a complete body, path and revision. Editing cannot continue.",
            };
          const readOutput = { ...output };
          delete readOutput.question;
          return { status: "succeeded", output: readOutput };
        }
        if (
          output.question &&
          Object.hasOwn(answers, output.question.binding) &&
          validQuestionAnswer(output.question, answers[output.question.binding])
        ) {
          const answeredOutput = { ...output };
          delete answeredOutput.question;
          return { status: "succeeded", output: answeredOutput };
        }
        if (output.question && !output.question.required) {
          if (validQuestionAnswer(output.question, output.question.default)) {
            execution = store.update(execution.id, execution.revision, {
              status: "running",
              checkpoint: execution.checkpoint,
              parameters: {
                ...execution.parameters,
                answers: {
                  ...answers,
                  [output.question.binding]: output.question.default,
                },
              },
            });
          }
          const settledOutput = { ...output };
          delete settledOutput.question;
          return { status: "succeeded", output: settledOutput };
        }
        return output.question
          ? { status: "awaiting_input", question: output.question, output }
          : { status: "succeeded", output };
      },
      settle: (step, state) => {
        if (!activeStepRunId || execution.currentStepId !== step.id) {
          const claim = store.beginStep(
            execution,
            step.id,
            envelope.turnId,
            step.type === "branch" ? "branch.v1" : step.outputSchemaId,
          );
          execution = claim.execution;
          activeStepRunId = claim.stepRunId;
          activeAttribution = undefined;
          stage(step, claim.stepRunId, "started");
        }
        const stepRunId = activeStepRunId;
        execution = store.settle(execution, state);
        stage(
          step,
          stepRunId,
          state.result!.status,
          activeAttribution,
          state.result!.status !== "succeeded" &&
            state.result!.status !== "awaiting_input"
            ? state.result!.summary
            : undefined,
        );
        activeStepRunId = undefined;
        activeAttribution = undefined;
      },
    });
  } catch (error) {
    const cancelled = input.signal.aborted;
    finalState = {
      ...execution.checkpoint,
      status: cancelled ? "cancelled" : "failed",
      result: {
        status: cancelled ? "cancelled" : "failed",
        code: "workflow_interrupted",
        summary: (error instanceof Error
          ? error.message
          : "Workflow interrupted"
        ).slice(0, 2000),
      },
    };
    execution = store.update(execution.id, execution.revision, {
      status: finalState.status,
      checkpoint: finalState,
    });
  }
  if (
    finalState.status === "cancelled" &&
    !input.signal.aborted &&
    budget.signal.aborted
  ) {
    finalState = {
      ...finalState,
      status: "failed",
      result: {
        status: "failed",
        code: "turn_deadline",
        summary: "The workflow reached its shared turn deadline.",
      },
    };
    execution = store.update(execution.id, execution.revision, {
      status: "failed",
      checkpoint: finalState,
    });
  }
  emit({ type: "execution", execution: executionSummary(execution) });
  if (
    execution.workflowId === "conversational" &&
    finalState.status === "completed"
  ) {
    const result = parametersRecord(finalState.outputs.reply);
    const body =
      typeof result.contentRef === "string"
        ? input.assets.text(envelope.threadId, result.contentRef)
        : null;
    if (body === null)
      throw new Error("The saved conversational content is unavailable.");
    persist("assistant_text", { content: body });
    emit({ type: "delta", text: body });
    return { stop: "completed" };
  }
  const outcome = freezeWorkflowOutcome(database, execution);
  execution = store.update(execution.id, execution.revision, {
    status: execution.status,
    checkpoint: execution.checkpoint,
    outcome,
  });
  emit({ type: "execution", execution: executionSummary(execution) });
  const stop: ChatTurnStop =
    execution.status === "cancelled" ? "cancelled" : "completed";
  const text = await present(outcome, stop);
  persist("assistant_text", { content: text });
  emit({ type: "delta", text });
  return { stop };
}
