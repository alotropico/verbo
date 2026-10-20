import { z } from "zod";
import {
  actionResultSchema,
  type ActionResult,
  type ActionSubject,
  type ActivityCategory,
} from "./action-contract";
import {
  routingStageSchema,
  stageEventSchema,
  type ExecutionStatus,
} from "./workflows";

export const EXECUTION_TRACE_VERSION = 1 as const;

export const traceLifecycles = [
  "pending",
  "running",
  "waiting",
  "finished",
] as const;
export const traceOutcomes = [
  "succeeded",
  "blocked",
  "failed",
  "partial",
  "cancelled",
  "skipped",
  "uncertain",
  "unverified",
] as const;
export const traceSeverities = [
  "success",
  "warning",
  "error",
  "muted",
  "info",
] as const;
export const traceDispositions = ["executed", "reused", "unattempted"] as const;
export const traceReadiness = ["working", "reporting", "ready"] as const;

export type TraceLifecycle = (typeof traceLifecycles)[number];
export type TraceOutcome = (typeof traceOutcomes)[number];
export type TraceSeverity = (typeof traceSeverities)[number];
export type TraceDisposition = (typeof traceDispositions)[number];
export type TraceReadiness = (typeof traceReadiness)[number];

const correlationSchema = z
  .object({
    executionId: z.string().max(128).optional(),
    stepRunId: z.string().max(128).optional(),
    stepId: z.string().max(80).optional(),
    invocationId: z.string().max(128).optional(),
    toolCallId: z.string().max(128).optional(),
    receiptId: z.string().max(128).optional(),
    attemptId: z.string().max(128).optional(),
  })
  .strict();

const technicalSchema = z
  .object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(2000),
  })
  .strict();

export const traceNodeSchema = z
  .object({
    id: z.string().min(1).max(160),
    parentId: z.string().max(160).optional(),
    kind: z.enum(["routing", "workflow", "step", "call", "reply"]),
    label: z.string().min(1).max(160),
    order: z.number().int().nonnegative(),
    lifecycle: z.enum(traceLifecycles),
    outcome: z.enum(traceOutcomes),
    severity: z.enum(traceSeverities),
    disposition: z.enum(traceDispositions),
    reasonCategory: z.string().max(40).optional(),
    reasonCode: z.string().max(64).optional(),
    summary: z.string().max(2000).optional(),
    activity: z.enum(["search", "read", "change", "other"]).optional(),
    support: z.enum(["requested", "discovery"]).optional(),
    effect: z.enum(["completed", "none", "uncertain"]),
    child: z.boolean().optional(),
    superseded: z.boolean().optional(),
    subjects: z
      .array(
        z
          .object({
            role: z.enum(["source", "destination"]),
            path: z.string().min(1).max(1024),
          })
          .strict(),
      )
      .max(40)
      .optional(),
    correlation: correlationSchema.optional(),
    technical: z.array(technicalSchema).max(12).optional(),
  })
  .strict();
export type TraceNode = z.infer<typeof traceNodeSchema>;

export const traceIncidentSchema = z
  .object({
    id: z.string().min(1).max(160),
    nodeId: z.string().min(1).max(160),
    severity: z.enum(["warning", "error"]),
    lifecycle: z.enum(["active", "terminal"]),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
    relatedIds: z.array(z.string().max(160)).max(8),
  })
  .strict();
export type TraceIncident = z.infer<typeof traceIncidentSchema>;

export const activitySummarySchema = z
  .object({
    state: z.enum(["active", "finished"]),
    searches: z.number().int().nonnegative().optional(),
    reads: z.number().int().nonnegative().optional(),
    changeAttempts: z.number().int().nonnegative().optional(),
    otherCommands: z.number().int().nonnegative().optional(),
    workMs: z.number().int().nonnegative().optional(),
    waitMs: z.number().int().nonnegative().optional(),
    durationAvailable: z.boolean(),
  })
  .strict();
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

export const executionTraceSchema = z
  .object({
    version: z.literal(EXECUTION_TRACE_VERSION),
    turnId: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    readiness: z.enum(traceReadiness),
    nodes: z.array(traceNodeSchema).max(80),
    incidents: z.array(traceIncidentSchema).max(30),
    summary: activitySummarySchema,
    timing: z
      .object({
        workStartedAt: z.number().optional(),
        resultReadyAt: z.number().optional(),
        approvalWaitMs: z.number().int().nonnegative().optional(),
        persistence: z.enum(["pending", "saved", "failed"]).optional(),
      })
      .strict(),
    question: z.string().max(2000).optional(),
  })
  .strict();
export type ExecutionTrace = z.infer<typeof executionTraceSchema>;

function reportLabel(label: string): string {
  const words = label.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Keep turn phases as peers, including traces saved before this presentation. */
export function normalizeTracePresentation(
  trace: ExecutionTrace,
): ExecutionTrace {
  const workflowLabels: Record<string, string> = {
    commander: "Commands",
    conversational: "Conversation",
    obsidian: "Notes",
  };
  return {
    ...trace,
    nodes: trace.nodes.map((node) => {
      if (node.kind === "step")
        return { ...node, label: reportLabel(node.label) };
      if (node.kind === "call") return node;
      const phase = { ...node };
      delete phase.parentId;
      return {
        ...phase,
        label:
          node.kind === "routing"
            ? "Decision"
            : node.kind === "reply"
              ? "Reply"
              : (workflowLabels[node.label.toLowerCase()] ??
                reportLabel(node.label)),
      };
    }),
  };
}

export type TraceClock = {
  turnId?: string;
  workStartedAt?: number;
  approvalWaitMs?: number;
  reporting?: boolean;
  resultReadyAt?: number;
  assumeReady?: boolean;
  stop?:
    | "completed"
    | "paused"
    | "cancelled"
    | "limit"
    | "capacity"
    | "no_progress"
    | "failed";
};

export type TraceCallInput = {
  id: string;
  parentId?: string;
  toolName: string;
  order: number;
  result?: ActionResult;
  child?: boolean;
  uncertainAttempt?: boolean;
  supersedes?: string;
  attribution?: {
    executionId?: string;
    stepRunId?: string;
    stepId?: string;
    invocationId?: string;
    attemptId?: string;
  };
};

export type TraceStageInput = {
  id: string;
  kind: "routing" | "workflow" | "step";
  label: string;
  order: number;
  state: string;
  parentId?: string;
  executionId?: string;
  workflowId?: string;
  stepId?: string;
  summary?: string;
  modelProfileId?: string;
  invocationId?: string;
};

const LIMITS = new Set([
  "too_large",
  "capacity",
  "match_count",
  "limit",
  "command_limit",
  "turn_limit",
]);
const FORBIDDEN = new Set([
  "denied",
  "write_denied",
  "read_denied",
  "outside_scope",
  "protected",
  "invocation_forbidden",
  "wrong_thread",
]);
const UNSUPPORTED = new Set([
  "not_supported",
  "unsupported",
  "use_move",
  "unknown_action",
  "ambiguous_command",
  "obsidian_unqualified",
]);
const INVALID = new Set([
  "invalid_args",
  "invalid",
  "invalid_reference",
  "invalid_json",
  "invalid_query",
  "malformed",
  "encoding",
]);
const UNCERTAIN = new Set(["effect_uncertain", "receipt_failed"]);
const EXECUTOR = new Set([
  "execution_failed",
  "interrupted",
  "failed",
  "trash_failed",
]);
const CONSTRAINT = new Set([
  "collision",
  "cycle",
  "overlap",
  "stale_source",
  "stale_cursor",
  "stale_scope",
  "missing",
  "link",
  "unopenable",
  "unreadable",
  "incomplete",
  "no_default_scope",
  "unknown_alias",
  "session_mismatch",
  "swap",
  "no_progress",
  "unavailable",
]);

export function activityForCommand(input: {
  id: string;
  effect?: "read" | "write" | "launch" | "process";
  kind?: "read" | "mutation";
}): ActivityCategory | undefined {
  if (
    input.id === "capabilities.search" ||
    input.id === "capabilities.list" ||
    input.id.endsWith(".search")
  )
    return "search";
  if (input.id === "capabilities.describe") return "read";
  const effect =
    input.effect ??
    (input.kind === "read"
      ? "read"
      : input.kind === "mutation"
        ? "write"
        : undefined);
  if (effect === "write") return "change";
  if (effect === "read") return "read";
  if (effect === "launch" || effect === "process") return "other";
  return undefined;
}

type Classified = {
  lifecycle: TraceLifecycle;
  outcome: TraceOutcome;
  severity: TraceSeverity;
  disposition: TraceDisposition;
  reasonCategory: string;
  effect: "completed" | "none" | "uncertain";
};

function severityFor(outcome: TraceOutcome): TraceSeverity {
  if (outcome === "succeeded") return "success";
  if (outcome === "failed") return "error";
  if (outcome === "blocked" || outcome === "partial" || outcome === "uncertain")
    return "warning";
  if (outcome === "unverified") return "info";
  return "muted";
}

/** One classification of a recorded action result. Transport completion is not success. */
export function classifyActionResult(
  result: ActionResult,
  uncertainAttempt = false,
): Classified {
  const code = result.code;
  if (code === "duplicate_feedback") {
    const underlying = classifyActionResult(
      { ...result, code: undefined },
      uncertainAttempt,
    );
    return { ...underlying, disposition: "reused", effect: "none" };
  }
  if (code === "unattempted") {
    return {
      lifecycle: "finished",
      outcome: "skipped",
      severity: "muted",
      disposition: "unattempted",
      reasonCategory: "unattempted",
      effect: "none",
    };
  }
  if (uncertainAttempt || (code && UNCERTAIN.has(code))) {
    return {
      lifecycle: "finished",
      outcome: "uncertain",
      severity: "warning",
      disposition: "executed",
      reasonCategory: "uncertain",
      effect: "uncertain",
    };
  }
  if (result.status === "requires_confirmation") {
    return {
      lifecycle: "waiting",
      outcome: "unverified",
      severity: "info",
      disposition: "executed",
      reasonCategory: "approval",
      effect: "none",
    };
  }
  if (result.status === "cancelled" || code === "cancelled") {
    return {
      lifecycle: "finished",
      outcome: "cancelled",
      severity: "muted",
      disposition: "executed",
      reasonCategory: "cancelled",
      effect: "none",
    };
  }
  if (result.status === "partial") {
    return {
      lifecycle: "finished",
      outcome: "partial",
      severity: "warning",
      disposition: "executed",
      reasonCategory: "constraint",
      effect: "completed",
    };
  }
  if (result.status === "success") {
    return {
      lifecycle: "finished",
      outcome: "succeeded",
      severity: "success",
      disposition: "executed",
      reasonCategory: "ok",
      effect: "completed",
    };
  }
  const category = !code
    ? result.status === "denied"
      ? "forbidden"
      : result.status === "not_supported"
        ? "unsupported"
        : "executor"
    : LIMITS.has(code)
      ? "limit"
      : FORBIDDEN.has(code)
        ? "forbidden"
        : UNSUPPORTED.has(code)
          ? "unsupported"
          : INVALID.has(code)
            ? "invalid"
            : EXECUTOR.has(code)
              ? "executor"
              : UNCERTAIN.has(code)
                ? "uncertain"
                : CONSTRAINT.has(code)
                  ? "constraint"
                  : result.status === "denied"
                    ? "forbidden"
                    : result.status === "not_supported"
                      ? "unsupported"
                      : "unknown";
  const constrained =
    category === "limit" ||
    category === "forbidden" ||
    category === "unsupported" ||
    category === "constraint" ||
    result.status === "denied" ||
    result.status === "not_supported";
  if (constrained) {
    return {
      lifecycle: "finished",
      outcome: "blocked",
      severity: "warning",
      disposition: "executed",
      reasonCategory: category,
      effect: "none",
    };
  }
  return {
    lifecycle: "finished",
    outcome: "failed",
    severity: "error",
    disposition: "executed",
    reasonCategory: category,
    effect: "none",
  };
}

function stageLifecycle(
  state: string,
): Pick<TraceNode, "lifecycle" | "outcome" | "severity" | "effect"> {
  if (state === "started") {
    return {
      lifecycle: "running",
      outcome: "unverified",
      severity: "info",
      effect: "none",
    };
  }
  if (state === "succeeded") {
    return {
      lifecycle: "finished",
      outcome: "succeeded",
      severity: "success",
      effect: "none",
    };
  }
  if (state === "awaiting_input" || state === "suspended") {
    return {
      lifecycle: "waiting",
      outcome: "unverified",
      severity: "info",
      effect: "none",
    };
  }
  if (state === "failed") {
    return {
      lifecycle: "finished",
      outcome: "failed",
      severity: "error",
      effect: "none",
    };
  }
  if (state === "cancelled") {
    return {
      lifecycle: "finished",
      outcome: "cancelled",
      severity: "muted",
      effect: "none",
    };
  }
  if (state === "blocked" || state === "not_supported") {
    return {
      lifecycle: "finished",
      outcome: "blocked",
      severity: "warning",
      effect: "none",
    };
  }
  return {
    lifecycle: "finished",
    outcome: "unverified",
    severity: "muted",
    effect: "none",
  };
}

function callLabel(toolName: string, result: ActionResult | undefined): string {
  if (result?.status === "requires_confirmation") return "Requesting approval";
  if (toolName === "capabilities.search") return "Searching commands";
  if (toolName === "capabilities.list") return "Listing commands";
  if (toolName === "capabilities.describe") return "Reading command details";
  if (toolName === "actions.invoke" && result?.action)
    return `Invoking ${result.action}`;
  if (result?.action) return result.action;
  return toolName || "Command";
}

function callActivity(
  toolName: string,
  result: ActionResult | undefined,
): ActivityCategory | undefined {
  if (toolName === "capabilities.search" || toolName === "capabilities.list")
    return "search";
  if (toolName === "capabilities.describe") return "read";
  if (result?.activity) return result.activity;
  if (result?.action) return activityForCommand({ id: result.action });
  return undefined;
}

function supportFor(toolName: string): "requested" | "discovery" {
  return toolName.startsWith("capabilities.") ? "discovery" : "requested";
}

function effectOf(
  outcome: TraceOutcome,
  effect: Classified["effect"],
): Classified["effect"] {
  if (outcome === "uncertain") return "uncertain";
  if (outcome === "succeeded" || outcome === "partial") return "completed";
  return effect;
}

function rollup(calls: TraceNode[]): TraceOutcome {
  if (calls.length === 0) return "unverified";
  const outcomes = calls.map((call) => call.outcome);
  const has = (outcome: TraceOutcome): boolean => outcomes.includes(outcome);
  if (has("uncertain") && has("succeeded")) return "partial";
  if (has("uncertain")) return "uncertain";
  if (
    has("succeeded") &&
    (has("failed") || has("blocked") || has("partial") || has("cancelled"))
  )
    return "partial";
  if (has("failed")) return "failed";
  if (has("blocked")) return "blocked";
  if (has("partial")) return "partial";
  if (has("cancelled") && !has("succeeded")) return "cancelled";
  if (outcomes.every((outcome) => outcome === "succeeded")) return "succeeded";
  if (outcomes.every((outcome) => outcome === "skipped")) return "skipped";
  if (outcomes.every((outcome) => outcome === "cancelled")) return "cancelled";
  return "unverified";
}

function applyWorkflowStatus(
  outcome: TraceOutcome,
  status: ExecutionStatus | string | undefined,
  workflowId: string | undefined,
  requested: number,
): { lifecycle: TraceLifecycle; outcome: TraceOutcome } {
  if (status === "cancelled")
    return { lifecycle: "finished", outcome: "cancelled" };
  if (status === "awaiting_input" || status === "suspended") {
    return {
      lifecycle: "waiting",
      outcome: outcome === "succeeded" ? "unverified" : outcome,
    };
  }
  if (requested === 0 && status === "completed") {
    return {
      lifecycle: "finished",
      outcome: workflowId === "conversational" ? "succeeded" : "blocked",
    };
  }
  if (status === "failed" && outcome === "succeeded")
    return { lifecycle: "finished", outcome: "failed" };
  if (status === "running")
    return {
      lifecycle: "running",
      outcome,
    };
  return { lifecycle: "finished", outcome };
}

export function formatWorkDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function activitySummaryText(summary: ActivitySummary): string {
  const figures = [
    summary.searches
      ? countLabel(summary.searches, "search", "searches")
      : undefined,
    summary.reads ? countLabel(summary.reads, "read", "reads") : undefined,
    summary.changeAttempts
      ? countLabel(summary.changeAttempts, "change attempt", "change attempts")
      : undefined,
    summary.otherCommands
      ? countLabel(summary.otherCommands, "other command", "other commands")
      : undefined,
  ].filter((figure): figure is string => Boolean(figure));
  const verb =
    summary.state === "finished"
      ? summary.workMs !== undefined
        ? `Worked for ${formatWorkDuration(summary.workMs)}`
        : summary.durationAvailable
          ? "Worked"
          : "Duration unavailable"
      : summary.workMs !== undefined
        ? `Working for ${formatWorkDuration(summary.workMs)}`
        : "Working";
  return [verb, ...figures].join(" · ");
}

export function evaluateTrace(input: {
  turnId: string;
  revision?: number;
  stages?: TraceStageInput[];
  calls?: TraceCallInput[];
  clock?: TraceClock;
  question?: string;
  workflow?: {
    executionId: string;
    workflowId: string;
    status: string;
  };
}): ExecutionTrace {
  const stages = input.stages ?? [];
  const calls = input.calls ?? [];
  const clock = input.clock ?? {};
  const superseded = new Set(
    calls.flatMap((call) => (call.supersedes ? [call.supersedes] : [])),
  );
  const nodes: TraceNode[] = [];
  for (const stage of stages) {
    const visual = stageLifecycle(stage.state);
    const technical = [
      stage.executionId
        ? { label: "Execution", value: stage.executionId }
        : undefined,
      stage.invocationId
        ? { label: "Invocation", value: stage.invocationId }
        : undefined,
      stage.modelProfileId
        ? { label: "Model profile", value: stage.modelProfileId }
        : undefined,
    ].filter((item): item is { label: string; value: string } => Boolean(item));
    nodes.push({
      id: stage.id,
      ...(stage.parentId ? { parentId: stage.parentId } : {}),
      kind: stage.kind,
      label: stage.label,
      order: stage.order,
      ...visual,
      disposition: "executed",
      ...(stage.summary ? { summary: stage.summary } : {}),
      ...(technical.length ? { technical } : {}),
      correlation: {
        ...(stage.executionId ? { executionId: stage.executionId } : {}),
        ...(stage.stepId ? { stepId: stage.stepId } : {}),
        ...(stage.invocationId ? { invocationId: stage.invocationId } : {}),
      },
    });
  }
  if (
    input.workflow &&
    !nodes.some(
      (node) =>
        node.kind === "workflow" && node.id === input.workflow?.executionId,
    )
  ) {
    nodes.push({
      id: input.workflow.executionId,
      kind: "workflow",
      label: input.workflow.workflowId,
      order: nodes.length,
      lifecycle: "running",
      outcome: "unverified",
      severity: "info",
      disposition: "executed",
      effect: "none",
      correlation: { executionId: input.workflow.executionId },
      technical: [
        { label: "Execution", value: input.workflow.executionId },
        { label: "Workflow", value: input.workflow.workflowId },
      ],
    });
  }
  calls.forEach((call, index) => {
    const parsed = call.result
      ? actionResultSchema.safeParse(call.result)
      : undefined;
    const result = parsed?.success ? parsed.data : call.result;
    const classified = result
      ? classifyActionResult(result, call.uncertainAttempt)
      : {
          lifecycle: "running" as const,
          outcome: "unverified" as const,
          severity: "info" as const,
          disposition: "executed" as const,
          reasonCategory: "unknown",
          effect: "none" as const,
        };
    const activity = callActivity(call.toolName, result);
    const support = supportFor(call.toolName);
    const technical = [
      result?.code ? { label: "Reason code", value: result.code } : undefined,
      result?.receiptId
        ? { label: "Receipt", value: result.receiptId }
        : undefined,
      call.attribution?.attemptId
        ? { label: "Attempt", value: call.attribution.attemptId }
        : undefined,
      call.attribution?.stepRunId
        ? { label: "Step run", value: call.attribution.stepRunId }
        : undefined,
    ].filter((item): item is { label: string; value: string } => Boolean(item));
    nodes.push({
      id: call.id,
      ...(call.parentId
        ? { parentId: call.parentId }
        : call.attribution?.stepRunId
          ? { parentId: call.attribution.stepRunId }
          : {}),
      kind: "call",
      label: callLabel(call.toolName, result),
      order: call.order ?? stages.length + index,
      lifecycle: classified.lifecycle,
      outcome: classified.outcome,
      severity: classified.severity,
      disposition: classified.disposition,
      reasonCategory: classified.reasonCategory,
      ...(result?.code ? { reasonCode: result.code } : {}),
      ...(result?.summary ? { summary: result.summary.slice(0, 2000) } : {}),
      ...(activity ? { activity } : {}),
      support,
      effect: effectOf(classified.outcome, classified.effect),
      ...(call.child ? { child: true } : {}),
      ...(superseded.has(call.id) ? { superseded: true } : {}),
      ...(result?.subjects?.length ? { subjects: result.subjects } : {}),
      correlation: {
        ...(call.attribution?.executionId
          ? { executionId: call.attribution.executionId }
          : {}),
        ...(call.attribution?.stepRunId
          ? { stepRunId: call.attribution.stepRunId }
          : {}),
        ...(call.attribution?.stepId
          ? { stepId: call.attribution.stepId }
          : {}),
        ...(call.attribution?.invocationId
          ? { invocationId: call.attribution.invocationId }
          : {}),
        toolCallId: call.id,
        ...(result?.receiptId ? { receiptId: result.receiptId } : {}),
        ...(call.attribution?.attemptId
          ? { attemptId: call.attribution.attemptId }
          : {}),
      },
      ...(technical.length ? { technical } : {}),
    });
  });

  for (const step of nodes.filter((node) => node.kind === "step")) {
    const children = nodes.filter(
      (node) =>
        node.kind === "call" &&
        node.parentId === step.id &&
        node.support !== "discovery" &&
        node.disposition === "executed" &&
        !node.child &&
        !node.superseded,
    );
    if (children.length === 0) continue;
    const outcome = rollup(children);
    const waiting = children.some((node) => node.lifecycle === "waiting");
    const running = children.some((node) => node.lifecycle === "running");
    const index = nodes.indexOf(step);
    nodes[index] = {
      ...step,
      outcome,
      severity: severityFor(outcome),
      lifecycle: waiting ? "waiting" : running ? "running" : step.lifecycle,
      effect: children.some((node) => node.effect === "uncertain")
        ? "uncertain"
        : children.some((node) => node.effect === "completed")
          ? "completed"
          : "none",
    };
  }
  const workflowNode = nodes.find((node) => node.kind === "workflow");
  const requested = nodes.filter(
    (node) =>
      node.kind === "call" &&
      node.support !== "discovery" &&
      node.disposition === "executed" &&
      !node.child &&
      !node.superseded,
  );
  if (workflowNode) {
    const rolled = rollup(requested);
    const applied = applyWorkflowStatus(
      requested.length ? rolled : "unverified",
      input.workflow?.status ??
        (workflowNode.lifecycle === "waiting" ? "awaiting_input" : undefined),
      input.workflow?.workflowId ?? workflowNode.label,
      requested.length,
    );
    const next = {
      ...workflowNode,
      lifecycle: applied.lifecycle,
      outcome: applied.outcome,
      severity: severityFor(applied.outcome),
      effect: requested.some((node) => node.effect === "uncertain")
        ? ("uncertain" as const)
        : requested.some((node) => node.effect === "completed")
          ? ("completed" as const)
          : ("none" as const),
    };
    const index = nodes.indexOf(workflowNode);
    nodes[index] = next;
  }

  const readiness: TraceReadiness =
    clock.resultReadyAt || clock.assumeReady
      ? "ready"
      : clock.reporting
        ? "reporting"
        : "working";
  if (clock.reporting || clock.resultReadyAt || clock.assumeReady) {
    const stop = clock.stop;
    const outcome: TraceOutcome =
      stop === "cancelled"
        ? "cancelled"
        : stop === "failed"
          ? "failed"
          : "succeeded";
    const finished = Boolean(clock.resultReadyAt || clock.assumeReady);
    nodes.push({
      id: `${input.turnId}:reply`,
      kind: "reply",
      label: "Reply",
      order: 10_000,
      lifecycle: finished ? "finished" : "running",
      outcome: finished ? outcome : "unverified",
      severity: finished ? severityFor(outcome) : "info",
      disposition: "executed",
      effect: "none",
    });
  }

  // A completed decision or operation does not complete the turn. Bridge the
  // handoff until the next execution event (or reporting clock) arrives.
  const lastPhase = nodes
    .filter((node) => ["routing", "workflow", "reply"].includes(node.kind))
    .sort((left, right) => left.order - right.order)
    .at(-1);
  if (
    readiness !== "ready" &&
    nodes.length > 0 &&
    lastPhase?.lifecycle !== "running" &&
    lastPhase?.lifecycle !== "waiting"
  ) {
    const routing = stages.findLast((stage) => stage.kind === "routing");
    nodes.push({
      id: `${input.turnId}:handoff`,
      kind: workflowNode ? "reply" : "workflow",
      label: workflowNode ? "Reply" : (routing?.workflowId ?? "Continuing"),
      order: 9_999,
      lifecycle: "running",
      outcome: "unverified",
      severity: "info",
      disposition: "executed",
      effect: "none",
    });
  }

  const incidents: TraceIncident[] = [];
  for (const node of nodes) {
    if (
      node.kind !== "call" ||
      node.disposition === "reused" ||
      node.superseded
    )
      continue;
    if (
      node.outcome !== "blocked" &&
      node.outcome !== "failed" &&
      node.outcome !== "partial" &&
      node.outcome !== "uncertain"
    )
      continue;
    const id =
      node.correlation?.receiptId ?? node.correlation?.toolCallId ?? node.id;
    if (incidents.some((incident) => incident.id === id)) continue;
    const severity = node.severity === "error" ? "error" : "warning";
    incidents.push({
      id,
      nodeId: node.id,
      severity,
      lifecycle: readiness === "ready" ? "terminal" : "active",
      code: (node.reasonCode ?? node.outcome).slice(0, 64),
      message: (node.summary ?? node.label).slice(0, 500),
      relatedIds: node.correlation?.attemptId
        ? [node.correlation.attemptId]
        : [],
    });
  }

  const counts = { search: 0, read: 0, change: 0, other: 0 };
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "call" || node.disposition !== "executed" || node.child)
      continue;
    if (!node.activity) continue;
    const key = node.correlation?.toolCallId ?? node.id;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[node.activity] += 1;
  }
  const waitMs = clock.approvalWaitMs ?? 0;
  const workMs =
    clock.workStartedAt !== undefined && clock.resultReadyAt !== undefined
      ? Math.max(0, clock.resultReadyAt - clock.workStartedAt - waitMs)
      : undefined;
  const summary: ActivitySummary = {
    state: readiness === "ready" ? "finished" : "active",
    ...(counts.search ? { searches: counts.search } : {}),
    ...(counts.read ? { reads: counts.read } : {}),
    ...(counts.change ? { changeAttempts: counts.change } : {}),
    ...(counts.other ? { otherCommands: counts.other } : {}),
    ...(workMs !== undefined ? { workMs } : {}),
    ...(waitMs > 0 ? { waitMs } : {}),
    durationAvailable:
      workMs !== undefined ||
      (clock.workStartedAt !== undefined && readiness !== "ready"),
  };
  return normalizeTracePresentation(
    executionTraceSchema.parse({
      version: EXECUTION_TRACE_VERSION,
      turnId: input.turnId,
      revision: input.revision ?? nodes.length,
      readiness,
      // Preserve the active/reporting tail even for long bounded traces.
      nodes:
        nodes.length > 80
          ? [...nodes.slice(0, 79), nodes[nodes.length - 1]]
          : nodes,
      incidents: incidents.slice(0, 30),
      summary,
      timing: {
        ...(clock.workStartedAt !== undefined
          ? { workStartedAt: clock.workStartedAt }
          : {}),
        ...(clock.resultReadyAt !== undefined
          ? { resultReadyAt: clock.resultReadyAt }
          : {}),
        ...(waitMs > 0 ? { approvalWaitMs: waitMs } : {}),
      },
      ...(input.question ? { question: input.question } : {}),
    }),
  );
}

export type RecordedPart = {
  type: string;
  name?: string;
  data?: unknown;
  toolCallId?: string;
  toolName?: string;
  text?: string;
  result?: ActionResult;
  attribution?: TraceCallInput["attribution"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rebuild a trace from projected parts. Legacy messages omit timing instead of inventing it. */
export function evaluateRecordedParts(input: {
  turnId: string;
  parts: readonly RecordedPart[];
  clock?: TraceClock;
  question?: string;
}): ExecutionTrace {
  const stages: TraceStageInput[] = [];
  const calls: TraceCallInput[] = [];
  let workflow:
    { executionId: string; workflowId: string; status: string } | undefined;
  let question = input.question;
  let order = 0;
  for (const part of input.parts) {
    if (part.type === "data" && part.name === "routing-stage") {
      const parsed = routingStageSchema.safeParse(part.data);
      if (!parsed.success) continue;
      stages.push({
        id: parsed.data.invocationId,
        kind: "routing",
        label: "Decision",
        order,
        state: parsed.data.state,
        workflowId: parsed.data.workflowId,
        invocationId: parsed.data.invocationId,
        modelProfileId: parsed.data.modelProfileId,
      });
      order += 1;
      continue;
    }
    if (part.type === "data" && part.name === "workflow-stage") {
      const parsed = stageEventSchema.safeParse(part.data);
      if (!parsed.success) continue;
      const stepId = parsed.data.attribution.stepId;
      stages.push({
        id: parsed.data.attribution.stepRunId,
        kind: "step",
        label: parsed.data.label || stepId,
        order,
        state: parsed.data.state,
        parentId: parsed.data.attribution.executionId,
        executionId: parsed.data.attribution.executionId,
        workflowId: parsed.data.attribution.workflowId,
        stepId,
        ...(parsed.data.summary ? { summary: parsed.data.summary } : {}),
        modelProfileId: parsed.data.attribution.modelProfileId,
        invocationId: parsed.data.attribution.invocationId,
      });
      order += 1;
      continue;
    }
    if (
      part.type === "data" &&
      part.name === "workflow-execution" &&
      isRecord(part.data)
    ) {
      const id = typeof part.data.id === "string" ? part.data.id : "";
      const workflowId =
        typeof part.data.workflowId === "string" ? part.data.workflowId : "";
      const status =
        typeof part.data.status === "string" ? part.data.status : "";
      if (!id || !workflowId) continue;
      workflow = { executionId: id, workflowId, status };
      const existing = stages.find(
        (stage) => stage.kind === "workflow" && stage.id === id,
      );
      const questionText =
        isRecord(part.data.question) &&
        typeof part.data.question.text === "string"
          ? part.data.question.text
          : undefined;
      if (questionText) question = questionText;
      if (existing) {
        existing.state =
          status === "running"
            ? "started"
            : status === "completed"
              ? "succeeded"
              : status;
        continue;
      }
      stages.push({
        id,
        kind: "workflow",
        label: workflowId,
        order,
        state:
          status === "running"
            ? "started"
            : status === "completed"
              ? "succeeded"
              : status,
        executionId: id,
        workflowId,
      });
      order += 1;
      continue;
    }
    if (part.type === "tool-call" && part.toolCallId && part.toolName) {
      calls.push({
        id: part.toolCallId,
        toolName: part.toolName,
        order,
        ...(part.result ? { result: part.result } : {}),
        ...(part.attribution ? { attribution: part.attribution } : {}),
      });
      order += 1;
    }
  }
  const stepIds = new Set(
    stages.filter((stage) => stage.kind === "step").map((stage) => stage.id),
  );
  for (const call of calls) {
    if (
      !call.parentId &&
      call.attribution?.stepRunId &&
      stepIds.has(call.attribution.stepRunId)
    )
      call.parentId = call.attribution.stepRunId;
    else if (!call.parentId && workflow) call.parentId = workflow.executionId;
  }
  return evaluateTrace({
    turnId: input.turnId,
    revision: order,
    stages,
    calls,
    ...(input.clock ? { clock: input.clock } : {}),
    ...(question ? { question } : {}),
    ...(workflow ? { workflow } : {}),
  });
}

export function liveWorkMs(
  trace: ExecutionTrace,
  now: number,
): number | undefined {
  if (trace.summary.workMs !== undefined) return trace.summary.workMs;
  const started = trace.timing.workStartedAt;
  if (started === undefined || trace.readiness === "ready") return undefined;
  return Math.max(0, now - started - (trace.timing.approvalWaitMs ?? 0));
}

const OPAQUE_ID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

export function reportParagraphs(trace: ExecutionTrace): string[] {
  const root =
    trace.nodes.find((node) => node.kind === "workflow") ??
    trace.nodes.find((node) => node.kind === "call" && !node.child);
  const status = {
    succeeded: "The requested work completed.",
    partial: "Some requested work completed; the rest needs attention.",
    blocked: "The requested work could not complete.",
    failed: "The requested work stopped with an error.",
    cancelled: "You stopped this work. Completed effects are retained.",
    uncertain:
      "Some effects are uncertain. Inspect their receipts before retrying; they will not be replayed automatically.",
    skipped: "The requested work was not attempted.",
    unverified: "The result could not be verified from the recorded evidence.",
  }[root?.outcome ?? "unverified"];
  const details = trace.nodes
    .filter(
      (node) =>
        node.kind === "call" &&
        node.support !== "discovery" &&
        node.disposition === "executed" &&
        !node.child &&
        node.summary &&
        !OPAQUE_ID.test(node.summary),
    )
    .map((node) => node.summary ?? "")
    .filter((summary, index, all) => all.indexOf(summary) === index)
    .slice(0, 2);
  const uncertain =
    root?.outcome === "uncertain"
      ? undefined
      : trace.nodes.some((node) => node.outcome === "uncertain")
        ? "Some effects are uncertain. Inspect their receipts before retrying; they will not be replayed automatically."
        : undefined;
  const paragraphs = [status, ...details, uncertain].filter(
    (paragraph): paragraph is string => Boolean(paragraph),
  );
  if (trace.question) paragraphs.push(trace.question);
  return paragraphs.slice(0, 4);
}

export function fileResultRows(result: ActionResult): Array<{
  id: string;
  role: "file" | "operation";
  path?: string;
  from?: string;
  to?: string;
  summary: string;
  action: string;
  code?: string;
  limitation?: string;
}> {
  const subjects: ActionSubject[] = result.subjects ?? [];
  const rows: Array<{
    id: string;
    role: "file" | "operation";
    path?: string;
    from?: string;
    to?: string;
    summary: string;
    action: string;
    code?: string;
    limitation?: string;
  }> = [];
  let source: string | undefined;
  subjects.forEach((subject, index) => {
    if (subject.role === "source") {
      if (source)
        rows.push({
          id: `${result.receiptId ?? result.action}:${rows.length}`,
          role: "file",
          path: source,
          from: source,
          summary: result.summary,
          action: result.action,
          ...(result.code ? { code: result.code } : {}),
        });
      source = subject.path;
      return;
    }
    rows.push({
      id: `${result.receiptId ?? result.action}:${index}`,
      role: "file",
      path: source ?? subject.path,
      ...(source ? { from: source } : {}),
      to: subject.path,
      summary: result.summary,
      action: result.action,
      ...(result.code ? { code: result.code } : {}),
    });
    source = undefined;
  });
  if (source) {
    rows.push({
      id: `${result.receiptId ?? result.action}:${rows.length}`,
      role: "file",
      path: source,
      from: source,
      summary: result.summary,
      action: result.action,
      ...(result.code ? { code: result.code } : {}),
    });
  }
  if (rows.length > 0) return rows;
  const fileCommand =
    result.action.startsWith("files.") || result.action.startsWith("obsidian.");
  return [
    {
      id: result.receiptId ?? result.action,
      role: "operation",
      summary: result.summary,
      action: result.action,
      ...(result.code ? { code: result.code } : {}),
      ...(fileCommand
        ? {
            limitation: "No trustworthy path was recorded for this operation.",
          }
        : {}),
    },
  ];
}
