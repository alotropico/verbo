import { createMemoryStore } from "./memory";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { persistCommandReceipt } from "../test-support/receipts";
import { VERBO_MIGRATIONS, migrateDatabase } from "./migrate";
import { createWorkflowExecutionStore } from "./workflow-executions";

async function setup(): Promise<{
  database: DatabaseSync;
  store: ReturnType<typeof createWorkflowExecutionStore>;
  execution: import("./workflow-executions").WorkflowExecution;
}> {
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, VERBO_MIGRATIONS);
  database.prepare("INSERT INTO threads(id,title,created_at,updated_at) VALUES('thread','old history',1,1)").run();
  await createMemoryStore(database).add({
    text: "Keep me",
    scope: "global",
    inclusion: "always",
    actor: "ui",
  });
  migrateDatabase(database, VERBO_MIGRATIONS);
  const store = createWorkflowExecutionStore(database);
  const execution = store.create({
    workflowId: "commander",
    definitionVersion: 1,
    threadId: "thread",
    branchAnchorId: null,
    requestMessageId: "user",
    parameters: { request: "Do it", target: null },
    firstStepId: "operate",
  });
  return { database, store, execution };
}

describe("durable execution and action claims", () => {
  it("does not mistake an approval receipt or uncertain result for a completed effect on restart", async () => {
    const { database, store, execution } = await setup();
    const active = store.beginStep(execution, "operate", "turn", "commander.output.v1");
    for (const [ordinal, status, code] of [
      [0, "requires_confirmation", undefined],
      [1, "partial", "effect_uncertain"],
      [2, "success", undefined],
    ] as const) {
      const claim = store.claimAttempt({
        executionId: execution.id,
        stepRunId: active.stepRunId,
        ordinal,
        actionId: "files.create",
        digest: String(ordinal),
        preconditions: {},
      });
      persistCommandReceipt(database, {
        context: {
          actor: "model",
          threadId: "thread",
          receiptId: claim.receiptId,
        },
        result: {
          action: "files.create",
          status,
          summary: "Fixture result",
          ...(code ? { code } : {}),
        },
        resources: [],
        startedAt: 1,
      });
      database.prepare("UPDATE workflow_action_attempts SET state='dispatched' WHERE id=?").run(claim.id);
    }
    await store.reconcileInterrupted();
    expect(store.attempts(execution.id).map((attempt) => attempt.state)).toEqual(["uncertain", "uncertain", "completed"]);
  });
  it("keeps command Memory in Alo and rejects stale app state writers", async () => {
    const { database, store, execution } = await setup();
    expect((await createMemoryStore(database).list({})).entries[0]?.text).toBe("Keep me");
    const active = store.beginStep(execution, "operate", "turn", "commander.output.v1");
    expect(() => store.beginStep(execution, "operate", "turn", "commander.output.v1")).toThrow("Stale");
    const completed = store.settle(active.execution, {
      status: "completed",
      currentStepId: null,
      outputs: { operate: { findings: [], receiptIds: [] } },
      result: { status: "succeeded", output: { findings: [], receiptIds: [] } },
    });
    expect(completed.status).toBe("completed");
    expect(() => store.settle(active.execution, completed.checkpoint)).toThrow("revision");
    store.linkTurn({
      executionId: execution.id,
      turnId: "turn",
      userMessageId: "user",
      assistantMessageId: "assistant",
      relation: "start",
    });
    expect(database.prepare("SELECT COUNT(*) AS total FROM workflow_execution_turns").get()?.total).toBe(1);
  });
  it("claims once before dispatch, rejects changed attempts and suspends uncertain effects at restart", async () => {
    const { store, execution } = await setup();
    const active = store.beginStep(execution, "operate", "turn", "commander.output.v1");
    const input = {
      executionId: execution.id,
      stepRunId: active.stepRunId,
      ordinal: 0,
      actionId: "files.create",
      digest: "digest",
      preconditions: {},
    };
    const claim = store.claimAttempt(input);
    expect(store.claimAttempt(input)).toMatchObject({
      fresh: false,
      id: claim.id,
      receiptId: claim.receiptId,
    });
    expect(() => store.claimAttempt({ ...input, digest: "changed" })).toThrow("different action");
    store.transitionAttempt(claim.id, "claimed", "dispatched");
    await store.reconcileInterrupted();
    expect(store.attempts(execution.id)[0]?.state).toBe("uncertain");
    expect(store.read(execution.id)).toMatchObject({
      status: "suspended",
      reason: "restart_requires_review",
    });
    expect(() => store.claimAttempt({ ...input, ordinal: 1, receiptId: randomUUID() })).toThrow("active trusted step");
  });
});
