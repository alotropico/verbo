import { recentActionAudits, recordActionAudit } from "../db/action-audit";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../shared/chat-ipc";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import { createActionLedger } from "../agents/action-ledger";
import { createInvocationPolicy } from "../agents/policy";
import { registryForDatabase } from "../capabilities/catalog";
import { readAgsCheck } from "../db/ags-check";
import {
  readEntitySettings,
  saveApplicationRegistration,
  saveProjectPreferences,
} from "../db/application-registration";
import { saveCommandOverride } from "../db/command-overrides";
import { readCommandReceipt } from "../db/command-receipts";
import { loadThreadHistory } from "../db/history";
import { createMemoryStore } from "../db/memory";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import {
  readProjectImportSettings,
  saveProjectImportSettings,
} from "../db/project-import-settings";
import { createRootStore } from "../db/registered-roots";
import { createScopeStore } from "../db/scopes";
import { createWorkflowExecutionStore } from "../db/workflow-executions";
import { createAssetStore } from "../files/asset-store";
import { decideOperation, reviewOperation } from "../files/mutation-plan";
import { createTurnController } from "../runtime/controller";
import { executeMemorySettingsAction } from "../runtime/memory-settings";
import { createRequestGate } from "../runtime/request-gate";
import { createTurnDispatcher } from "../runtime/turn-dispatcher";
import { freezeWorkflowOutcome } from "../runtime/workflow-outcome";
import { runWorkflowTurn } from "../runtime/workflow-runner";
import { aloExecutionReceipts } from "./data-client";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0)) close();
});
function fixture(): { database: DatabaseSync; root: string } {
  const directory = mkdtempSync(join(tmpdir(), "verbo-alo-data-"));
  const root = join(directory, "notes");
  mkdirSync(root);
  const actual = new DatabaseSync(":memory:");
  migrateDatabase(actual, VERBO_MIGRATIONS);
  actual
    .prepare(
      "INSERT INTO threads(id,title,created_at,updated_at) VALUES('thread','Fixture',1,1)",
    )
    .run();
  const forbidden =
    /\b(memory_entries|memory_changes|file_scopes|file_read_grants|file_scope_generation|file_query_snapshots|file_query_items|file_query_dirs|file_query_cursors|operation_plans|operation_items|action_audit|registered_projects|ags_hosts|ags_check_command|command_overrides|command_receipts|command_module_settings|registered_applications|project_preferences|attachment_live_references|project_import_settings|context_note_audiences|action_audit)\b/i;
  const database = new Proxy(actual, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (forbidden.test(sql))
            throw new Error(`Verbo accessed command SQL: ${sql}`);
          return target.prepare(sql);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (value.bind(target) as unknown)
        : value;
    },
  });
  vi.stubEnv("VERBO_ALO_NODE", process.execPath);
  vi.stubEnv("VERBO_ALO_ENTRY", resolve("../alo/dist/cli/main.js"));
  vi.stubEnv("VERBO_ALO_PROFILE", join(directory, "alo.sqlite"));
  cleanup.push(() => {
    actual.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { database, root };
}
it("settings, Memory context, files, review and confirmation work without Verbo command SQL", async () => {
  const { database, root } = fixture();
  const memory = createMemoryStore(database);
  const saved = await executeMemorySettingsAction(database, "memory.add", {
    text: "Thread context",
    scope: "thread",
    threadId: "thread",
    inclusion: "always",
    audiences: ["commander"],
  });
  expect(saved.ok).toBe(true);
  expect(memory.snapshot("thread", "commander").alwaysThread).toEqual([
    "Thread context",
  ]);
  expect(memory.snapshot("thread", "writer").alwaysThread).toEqual([]);
  const scopes = createScopeStore(database);
  expect(
    scopes.apply({
      removeIds: [],
      updates: [],
      additions: [
        {
          alias: "notes",
          path: root,
          read: true,
          write: true,
          defaultSave: false,
        },
      ],
    }).ok,
  ).toBe(true);
  expect(scopes.list()[0]?.path.toLowerCase()).toBe(root.toLowerCase());
  expect(
    saveCommandOverride(database, [], {
      nodeId: "environment.platform",
      version: 1,
      aliases: ["from-settings"],
    }).ok,
  ).toBe(true);
  const registry = registryForDatabase(database);
  expect(registry.resolve("env.from-settings")).toEqual({
    ok: true,
    id: "environment.platform",
  });
  const context = { actor: "ui" as const, threadId: "thread" };
  expect(
    (
      await registry.invoke(
        "files.create",
        { path: "notes:/note.md", kind: "file", content: "before" },
        context,
      )
    ).status,
  ).toBe("success");
  const edit = await registry.invoke(
    "files.edit",
    { path: "notes:/note.md", mode: "full", content: "after" },
    context,
  );
  expect(edit.status).toBe("requires_confirmation");
  const input = {
    database,
    scopes,
    operationId: edit.operationId!,
    threadId: "thread",
    sessionId: "Verbo process session",
  };
  expect(reviewOperation(input).ok).toBe(true);
  expect(
    (await decideOperation({ ...input, decision: "approve" })).status,
  ).toBe("success");
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe("after");
  expect(
    readCommandReceipt(database, edit.operationId!, "thread")?.result.status,
  ).toBe("success");
}, 30000);
it("project, application, AGS and import settings have one owner", () => {
  const { database, root } = fixture();
  const added = createRootStore(database, "registered_projects", "project").add(
    "fixture",
    root,
  );
  expect(added.ok).toBe(true);
  if (!added.ok) return;
  expect(
    saveApplicationRegistration(database, {
      name: "Fixture node",
      aliases: ["fixture-node"],
      executable: process.execPath,
      enabled: true,
      supportedTargets: ["folder"],
      supportedPlatforms: ["win32"],
      cwdPolicy: "project",
      launchArguments: [{ target: "path" }],
    }).ok,
  ).toBe(true);
  const application = readEntitySettings(database).applications[0]!;
  expect(
    saveProjectPreferences(database, {
      id: added.root.id,
      name: "Fixture project",
      aliases: ["fixture-extra"],
      enabled: true,
      defaultApplicationId: application.id,
      favoriteApplicationIds: [application.id],
    }).ok,
  ).toBe(true);
  expect(readEntitySettings(database).projects[0]?.defaultApplicationId).toBe(
    application.id,
  );
  expect(
    saveProjectImportSettings(database, {
      enabled: true,
      applicationIds: [application.id],
    }).ok,
  ).toBe(true);
  expect(readProjectImportSettings(database).applicationIds).toEqual([
    application.id,
  ]);
  expect(
    createRootStore(database, "ags_hosts", "AGS host").add("fixture-ags", root)
      .ok,
  ).toBe(true);
  expect(
    createRootStore(database, "ags_hosts", "AGS host").list()[0]?.alias,
  ).toBe("fixture-ags");
  expect(readAgsCheck(database).configured).toBe(false);
}, 30000);
it("real workflow attempts retain receipt IDs and replay known results from Alo", async () => {
  const { database } = fixture();
  const store = createWorkflowExecutionStore(database);
  const execution = store.create({
    workflowId: "commander",
    definitionVersion: 1,
    threadId: "thread",
    branchAnchorId: null,
    requestMessageId: "user",
    parameters: {},
    firstStepId: "operate",
  });
  const active = store.beginStep(
    execution,
    "operate",
    "turn",
    "commander.output.v1",
  );
  const ledger = createActionLedger({
    database,
    executionId: execution.id,
    stepRunId: active.stepRunId,
    resuming: false,
    preconditions: {},
  });
  const policy = createInvocationPolicy({
    id: randomUUID(),
    agentId: "commander",
    exposed: true,
    allowed: { modules: ["memory"], actions: [] },
    discoverable: { modules: ["memory"], actions: [] },
    forbidden: [],
    ledger,
    attribution: {
      executionId: execution.id,
      workflowId: "commander",
      definitionVersion: 1,
      stepId: "operate",
      stepRunId: active.stepRunId,
      agentId: "commander",
    },
  });
  const registry = registryForDatabase(database);
  const args = { text: "One durable workflow note", audiences: ["commander"] };
  const result = await registry.invoke("memory.add", args, {
    actor: "model",
    threadId: "thread",
    invocation: policy,
  });
  expect(result.status).toBe("success");
  expect(store.attempts(execution.id)[0]?.receipt_id).toBe(result.receiptId);
  expect(store.attempts(execution.id)[0]?.state).toBe("completed");
  expect(aloExecutionReceipts(database, execution.id, "thread")[0]?.id).toBe(
    result.receiptId,
  );
  expect(
    freezeWorkflowOutcome(database, active.execution).receiptIds,
  ).toContain(result.receiptId);
  const resumed = createInvocationPolicy({
    ...policy,
    ledger: createActionLedger({
      database,
      executionId: execution.id,
      stepRunId: active.stepRunId,
      resuming: true,
      preconditions: {},
    }),
  });
  const replay = await registry.invoke("memory.add", args, {
    actor: "model",
    threadId: "thread",
    invocation: resumed,
  });
  expect(replay.receiptId).toBe(result.receiptId);
  expect(createMemoryStore(database).list({}).entries).toHaveLength(1);
  expect(store.attempts(execution.id)).toHaveLength(1);
  const unknown = store.claimAttempt({
    executionId: execution.id,
    stepRunId: active.stepRunId,
    ordinal: 1,
    actionId: "memory.add",
    digest: "unresolved",
    preconditions: {},
  });
  store.transitionAttempt(unknown.id, "claimed", "dispatched");
  database
    .prepare(
      "UPDATE workflow_action_attempts SET state='dispatched' WHERE receipt_id=?",
    )
    .run(result.receiptId!);
  store.reconcileInterrupted();
  expect(store.attempts(execution.id)[0]?.state).toBe("completed");
  expect(store.attempts(execution.id)[1]?.state).toBe("uncertain");
  const uncertain = createInvocationPolicy({
    ...policy,
    ledger: createActionLedger({
      database,
      executionId: execution.id,
      stepRunId: active.stepRunId,
      resuming: true,
      preconditions: {},
    }),
  });
  const refused = await registry.invoke(
    "memory.add",
    { text: "No blind retry" },
    { actor: "model", threadId: "thread", invocation: uncertain },
  );
  expect(refused.code).toBe("needs_reconciliation");
  expect(createMemoryStore(database).list({}).entries).toHaveLength(1);
}, 30000);

it("approval settles the app-owned workflow attempt from the Alo receipt", async () => {
  const { database, root } = fixture();
  const scopes = createScopeStore(database);
  expect(
    scopes.apply({
      removeIds: [],
      updates: [],
      additions: [
        {
          alias: "notes",
          path: root,
          read: true,
          write: true,
          defaultSave: false,
        },
      ],
    }).ok,
  ).toBe(true);
  writeFileSync(join(root, "approved.md"), "before");
  const store = createWorkflowExecutionStore(database);
  const execution = store.create({
    workflowId: "commander",
    definitionVersion: 1,
    threadId: "thread",
    branchAnchorId: null,
    requestMessageId: "user",
    parameters: {},
    firstStepId: "operate",
  });
  const active = store.beginStep(
    execution,
    "operate",
    "turn",
    "commander.output.v1",
  );
  const policy = createInvocationPolicy({
    id: randomUUID(),
    agentId: "commander",
    exposed: true,
    allowed: { modules: ["files"], actions: [] },
    discoverable: { modules: ["files"], actions: [] },
    forbidden: [],
    ledger: createActionLedger({
      database,
      executionId: execution.id,
      stepRunId: active.stepRunId,
      resuming: false,
      preconditions: {},
    }),
    attribution: {
      executionId: execution.id,
      workflowId: "commander",
      definitionVersion: 1,
      stepId: "operate",
      stepRunId: active.stepRunId,
      agentId: "commander",
    },
  });
  const result = await registryForDatabase(database).invoke(
    "files.edit",
    { path: "notes:/approved.md", mode: "full", content: "after" },
    { actor: "model", threadId: "thread", invocation: policy },
  );
  expect(result.status).toBe("requires_confirmation");
  expect(store.attempts(execution.id)[0]?.state).toBe("dispatched");
  expect(
    (
      await decideOperation({
        database,
        scopes,
        operationId: result.operationId!,
        threadId: "thread",
        sessionId: "Verbo session",
        decision: "approve",
      })
    ).status,
  ).toBe("success");
  expect(store.attempts(execution.id)[0]?.state).toBe("completed");
  expect(readFileSync(join(root, "approved.md"), "utf8")).toBe("after");
}, 30000);

it.skipIf(process.env.VERBO_LIVE_ALO !== "1")(
  "runs real Qwen through the controller, decider and Alo with app-only SQL",
  async () => {
    const { database, root } = fixture();
    const registry = registryForDatabase(database);
    const assets = createAssetStore(database, join(root, "assets"));
    const gate = createRequestGate(),
      dispatcher = createTurnDispatcher(database);
    const events: ChatEvent[] = [];
    const controller = createTurnController({
      database,
      dispatcher,
      retryDelays: [],
      work: (input) =>
        runWorkflowTurn({
          ...input,
          database,
          settings: {
            ...DEFAULT_CHAT_SETTINGS,
            think: false,
            temperature: 0.2,
          },
          registry,
          assets,
          gate,
          inventory: {
            folders: [],
            truncated: false,
            generation: 1,
            refreshedAt: 1,
          },
          awaitDecision: undefined,
        }),
    });
    await controller.admitTurn(
      {
        threadId: "thread",
        userMessageId: "user",
        assistantMessageId: "assistant",
        admission: "immediate",
        source: "typed",
        text: "Use the registered environment.platform command to report the platform. Do not change files or settings.",
        attachmentIds: [],
      },
      (event) => events.push(event),
    ).completion;
    const execution = createWorkflowExecutionStore(database).list("thread")[0];
    expect(execution?.workflowId).toBe("commander");
    const receipts = aloExecutionReceipts(database, execution!.id, "thread");
    expect(
      receipts.some(
        (receipt) =>
          (receipt.result as { action?: string; status?: string }).action ===
            "environment.platform" &&
          (receipt.result as { status?: string }).status === "success",
      ),
    ).toBe(true);
    const messages = loadThreadHistory(database, "thread").messages.filter(
      (item) => item.message.role === "assistant",
    );
    const rendered = JSON.stringify(messages);
    expect(rendered.toLowerCase()).toMatch(/windows|win32/);
    expect(events.some((event) => event.type === "done")).toBe(true);
    console.info(
      "Alo controller acceptance",
      JSON.stringify({
        workflow: execution?.workflowId,
        status: execution?.status,
        receiptCount: receipts.length,
        events: events.map((event) => event.type),
      }),
    );
  },
  180000,
);

it("settings history is written and read by Alo without app command SQL", () => {
  const { database } = fixture();
  recordActionAudit(database, {
    actor: "ui",
    actionId: "projects.register",
    request: "fixture",
    summary: "Registered fixture",
    status: "success",
  });
  expect(recentActionAudits(database)[0]).toMatchObject({
    actionId: "projects.register",
    summary: "Registered fixture",
  });
});
