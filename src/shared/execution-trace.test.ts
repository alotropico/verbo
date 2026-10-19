import { describe, expect, it } from "vitest";
import { actionResultSchema, type ActionResult } from "./action-contract";
import {
  activitySummaryText,
  classifyActionResult,
  evaluateTrace,
  normalizeTracePresentation,
  fileResultRows,
  reportParagraphs,
  type TraceCallInput,
} from "./execution-trace";

function call(
  id: string,
  result: ActionResult,
  extra: Partial<TraceCallInput> = {},
): TraceCallInput {
  return {
    id,
    toolName: "actions.invoke",
    order: 0,
    result,
    ...extra,
  };
}

function result(
  status: ActionResult["status"],
  code?: string,
  summary = "Recorded result.",
): ActionResult {
  return actionResultSchema.parse({
    action: "files.move",
    status,
    summary,
    ...(code ? { code } : {}),
    activity: "change",
  });
}

describe("action classification", () => {
  it("keeps success, invalid requests, limits, and forbidden scope distinct", () => {
    expect(classifyActionResult(result("success")).outcome).toBe("succeeded");
    expect(classifyActionResult(result("error", "invalid_args"))).toMatchObject(
      {
        outcome: "failed",
        severity: "error",
        reasonCategory: "invalid",
      },
    );
    expect(classifyActionResult(result("error", "too_large"))).toMatchObject({
      outcome: "blocked",
      severity: "warning",
      reasonCategory: "limit",
    });
    expect(
      classifyActionResult(result("denied", "invocation_forbidden")),
    ).toMatchObject({
      outcome: "blocked",
      severity: "warning",
      reasonCategory: "forbidden",
    });
    expect(classifyActionResult(result("not_supported"))).toMatchObject({
      outcome: "blocked",
      severity: "warning",
    });
  });

  it("does not treat a finished transport as success for uncertain, skipped, cancelled, or partial work", () => {
    expect(
      classifyActionResult(result("error", "effect_uncertain")).outcome,
    ).toBe("uncertain");
    expect(
      classifyActionResult(result("cancelled", "unattempted")).outcome,
    ).toBe("skipped");
    expect(classifyActionResult(result("cancelled")).outcome).toBe("cancelled");
    expect(classifyActionResult(result("partial")).outcome).toBe("partial");
    expect(
      classifyActionResult(result("requires_confirmation")).lifecycle,
    ).toBe("waiting");
    const reused = classifyActionResult(
      result("success", "duplicate_feedback"),
    );
    expect(reused.disposition).toBe("reused");
    expect(reused.effect).toBe("none");
    expect(
      classifyActionResult(result("error", "legacy_unknown")).outcome,
    ).toBe("failed");
  });
});

describe("trace evaluation", () => {
  it("presents turn phases as peers and preserves steps and their tool attribution", () => {
    const trace = evaluateTrace({
      turnId: "hierarchy",
      stages: [
        {
          id: "decision",
          kind: "routing",
          label: "Decision",
          order: 0,
          state: "succeeded",
        },
        {
          id: "workflow",
          kind: "workflow",
          label: "commander",
          parentId: "decision",
          order: 1,
          state: "succeeded",
        },
        {
          id: "operate",
          kind: "step",
          label: "operate",
          parentId: "workflow",
          order: 2,
          state: "succeeded",
        },
      ],
      calls: [call("read", result("success"), { parentId: "operate" })],
      workflow: {
        executionId: "workflow",
        workflowId: "commander",
        status: "completed",
      },
      clock: { assumeReady: true },
    });
    const phases = trace.nodes.filter((node) =>
      ["routing", "workflow", "reply"].includes(node.kind),
    );
    expect(phases.map((node) => node.label)).toEqual([
      "Decision",
      "Commands",
      "Reply",
    ]);
    expect(phases.every((node) => node.parentId === undefined)).toBe(true);
    expect(trace.nodes.find((node) => node.id === "operate")).toMatchObject({
      label: "Operate",
      parentId: "workflow",
    });
    expect(trace.nodes.find((node) => node.id === "read")?.parentId).toBe(
      "operate",
    );

    const saved = {
      ...trace,
      nodes: trace.nodes.map((node) =>
        node.id === "workflow"
          ? { ...node, label: "commander", parentId: "decision" }
          : node.id === "operate"
            ? { ...node, label: "operate" }
            : node,
      ),
    };
    expect(normalizeTracePresentation(saved)).toEqual(trace);
    expect(saved.nodes.find((node) => node.id === "workflow")?.parentId).toBe(
      "decision",
    );
  });

  it.each(["success", "error"] as const)(
    "keeps a running workflow and step active after a %s tool result",
    (status) => {
      const trace = evaluateTrace({
        turnId: "active",
        stages: [
          {
            id: "operate",
            kind: "step",
            label: "Operate",
            order: 1,
            state: "started",
            parentId: "workflow",
          },
        ],
        workflow: {
          executionId: "workflow",
          workflowId: "commander",
          status: "running",
        },
        calls: [call("one", result(status), { parentId: "operate" })],
      });
      expect(trace.nodes.find((node) => node.id === "one")?.lifecycle).toBe(
        "finished",
      );
      expect(trace.nodes.find((node) => node.id === "operate")?.lifecycle).toBe(
        "running",
      );
      expect(
        trace.nodes.find((node) => node.id === "workflow")?.lifecycle,
      ).toBe("running");
      expect(trace.nodes.some((node) => node.id === "active:handoff")).toBe(
        false,
      );
    },
  );

  it("bridges Decision into the selected workflow until execution starts", () => {
    const stages = [
      {
        id: "decision",
        kind: "routing" as const,
        label: "Decision",
        order: 0,
        state: "succeeded",
        workflowId: "commander",
      },
    ];
    const handoff = evaluateTrace({ turnId: "turn", stages });
    expect(handoff.nodes.at(-1)).toMatchObject({
      id: "turn:handoff",
      label: "Commands",
      lifecycle: "running",
    });
    const started = evaluateTrace({
      turnId: "turn",
      stages,
      workflow: {
        executionId: "workflow",
        workflowId: "commander",
        status: "running",
      },
    });
    expect(started.nodes.some((node) => node.id === "turn:handoff")).toBe(
      false,
    );
    expect(started.nodes.at(-1)?.lifecycle).toBe("running");
  });

  it("bridges a settled workflow into Reply and retires the handoff when ready", () => {
    const workflow = {
      executionId: "workflow",
      workflowId: "conversational",
      status: "completed",
    };
    const handoff = evaluateTrace({ turnId: "turn", workflow });
    expect(handoff.nodes.at(-1)).toMatchObject({
      label: "Reply",
      lifecycle: "running",
    });
    const reporting = evaluateTrace({
      turnId: "turn",
      workflow,
      clock: { reporting: true },
    });
    expect(
      reporting.nodes.filter((node) => node.kind === "reply"),
    ).toHaveLength(1);
    const ready = evaluateTrace({
      turnId: "turn",
      workflow,
      clock: { assumeReady: true },
    });
    expect(ready.nodes.some((node) => node.id === "turn:handoff")).toBe(false);
    expect(ready.nodes.every((node) => node.lifecycle === "finished")).toBe(
      true,
    );
  });

  it("retains the reporting phase when the trace reaches its node bound", () => {
    const trace = evaluateTrace({
      turnId: "long",
      calls: Array.from({ length: 90 }, (_, index) =>
        call(`call-${index}`, result("success")),
      ),
      clock: { reporting: true },
    });
    expect(trace.nodes).toHaveLength(80);
    expect(trace.nodes.at(-1)).toMatchObject({
      kind: "reply",
      lifecycle: "running",
    });
  });

  it("counts a logical attempt once and ignores reuse, skips, and composite children", () => {
    const trace = evaluateTrace({
      turnId: "turn-1",
      calls: [
        call(
          "search",
          {
            action: "capabilities.search",
            status: "success",
            summary: "Found commands.",
          },
          { toolName: "capabilities.search" },
        ),
        call("read", {
          action: "files.read",
          status: "success",
          summary: "Read the file.",
          activity: "read",
        }),
        call(
          "move",
          result("error", "too_large", "The file exceeds the transfer limit."),
        ),
        call("again", result("success", "duplicate_feedback"), { id: "again" }),
        call("skipped", result("cancelled", "unattempted")),
        call("child", result("success", undefined, "Child effect."), {
          child: true,
          parentId: "move",
        }),
      ],
      clock: {
        workStartedAt: 0,
        resultReadyAt: 50_000,
        approvalWaitMs: 10_000,
      },
    });
    expect(trace.summary).toMatchObject({
      searches: 1,
      reads: 1,
      changeAttempts: 1,
      workMs: 40_000,
      waitMs: 10_000,
      state: "finished",
    });
    expect(trace.summary.otherCommands).toBeUndefined();
    expect(trace.incidents.map((incident) => incident.id)).toEqual(["move"]);
  });

  it("does not let discovery success turn a blocked change into a partial workflow", () => {
    const trace = evaluateTrace({
      turnId: "turn-2",
      workflow: {
        executionId: "00000000-0000-4000-8000-000000000010",
        workflowId: "commander",
        status: "completed",
      },
      stages: [
        {
          id: "00000000-0000-4000-8000-000000000011",
          kind: "routing",
          label: "Decision",
          order: 0,
          state: "succeeded",
        },
        {
          id: "00000000-0000-4000-8000-000000000012",
          kind: "step",
          label: "operate",
          order: 1,
          state: "succeeded",
          parentId: "00000000-0000-4000-8000-000000000010",
          stepId: "operate",
        },
      ],
      calls: [
        call(
          "list",
          {
            action: "capabilities.list",
            status: "success",
            summary: "Listed commands.",
          },
          {
            toolName: "capabilities.list",
            parentId: "00000000-0000-4000-8000-000000000012",
          },
        ),
        call("blocked", result("error", "too_large"), {
          parentId: "00000000-0000-4000-8000-000000000012",
        }),
      ],
      clock: { assumeReady: true, stop: "completed" },
    });
    const workflow = trace.nodes.find((node) => node.kind === "workflow");
    const step = trace.nodes.find((node) => node.kind === "step");
    expect(workflow?.outcome).toBe("blocked");
    expect(step?.label).toBe("Operate");
    expect(step?.outcome).toBe("blocked");
    expect(trace.nodes.some((node) => node.kind === "reply")).toBe(true);
  });

  it("keeps independent incidents distinct and ignores a superseded error", () => {
    const trace = evaluateTrace({
      turnId: "turn-3",
      calls: [
        call("one", result("error", "too_large", "First limit.")),
        call("two", result("error", "too_large", "Second limit.")),
        call("old", result("error", "execution_failed", "Earlier error."), {
          id: "old",
        }),
        call("retry", result("success", undefined, "Retried successfully."), {
          supersedes: "old",
        }),
      ],
      workflow: {
        executionId: "00000000-0000-4000-8000-000000000020",
        workflowId: "commander",
        status: "completed",
      },
      clock: { assumeReady: true },
    });
    expect(trace.incidents.map((incident) => incident.id).sort()).toEqual([
      "one",
      "two",
    ]);
    expect(trace.nodes.find((node) => node.id === "old")?.superseded).toBe(
      true,
    );
    expect(trace.nodes.find((node) => node.kind === "workflow")?.outcome).toBe(
      "partial",
    );
  });

  it("counts only the calls supplied for a continuation", () => {
    const continued = evaluateTrace({
      turnId: "turn-next",
      calls: [call("fresh", result("success", undefined, "Moved the file."))],
      clock: { assumeReady: true, workStartedAt: 10, resultReadyAt: 25 },
    });
    expect(continued.summary.changeAttempts).toBe(1);
    expect(continued.summary.searches).toBeUndefined();
    expect(continued.summary.workMs).toBe(15);
  });

  it("omits duration when a legacy message has no clock", () => {
    const trace = evaluateTrace({
      turnId: "legacy",
      calls: [call("only", result("success"))],
      clock: { assumeReady: true },
    });
    expect(trace.summary.workMs).toBeUndefined();
    expect(trace.summary.durationAvailable).toBe(false);
    expect(trace.readiness).toBe("ready");
  });

  it("keeps reporting unfinished until the result is ready", () => {
    const reporting = evaluateTrace({
      turnId: "turn-4",
      clock: { reporting: true, workStartedAt: 0 },
    });
    expect(reporting.readiness).toBe("reporting");
    expect(
      reporting.nodes.find((node) => node.kind === "reply")?.lifecycle,
    ).toBe("running");
    const ready = evaluateTrace({
      turnId: "turn-4",
      clock: { workStartedAt: 0, resultReadyAt: 18_000, stop: "cancelled" },
    });
    expect(ready.readiness).toBe("ready");
    expect(ready.summary.workMs).toBe(18_000);
    expect(ready.nodes.find((node) => node.kind === "reply")?.outcome).toBe(
      "cancelled",
    );
  });
});

describe("report prose", () => {
  it("keeps the question and leaves opaque ids out of the paragraphs", () => {
    const trace = evaluateTrace({
      turnId: "turn-5",
      question: "Which folder should be used?",
      calls: [
        call(
          "00000000-0000-4000-8000-000000000099",
          result("error", "effect_uncertain", "The move effect is uncertain."),
        ),
      ],
      clock: { assumeReady: true },
    });
    const paragraphs = reportParagraphs(trace);
    expect(paragraphs.at(-1)).toBe("Which folder should be used?");
    expect(paragraphs.join("\n")).not.toContain("00000000-0000-4000-8000");
    expect(activitySummaryText(trace.summary)).toContain("change attempt");
  });
});

describe("file subjects", () => {
  it("keeps source and destination on a rejected move without calling it a successful file", () => {
    const rows = fileResultRows(
      result(
        "error",
        "too_large",
        "Move could not complete: the file exceeds the transfer limit.",
      ),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        role: "operation",
        limitation: expect.any(String),
      }),
    ]);
    const located = fileResultRows({
      ...result(
        "error",
        "too_large",
        "Move could not complete: the file exceeds the transfer limit.",
      ),
      subjects: [
        { role: "source", path: "C:\\Example\\Folder\\example.ext" },
        { role: "destination", path: "C:\\Example\\Dest\\example.ext" },
      ],
    });
    expect(located).toEqual([
      expect.objectContaining({
        role: "file",
        path: "C:\\Example\\Folder\\example.ext",
        from: "C:\\Example\\Folder\\example.ext",
        to: "C:\\Example\\Dest\\example.ext",
      }),
    ]);
  });
});
