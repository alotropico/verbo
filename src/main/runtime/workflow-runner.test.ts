import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ChatEvent } from "../../shared/chat-ipc";
import { replyAttention } from "../../shared/reply-attention";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import type { GuidanceAssignment } from "../agents/guidance";
import { invokeAgent } from "../agents/invoke";
import { withInvocation } from "../agents/policy";
import { routeGlobalRequest } from "../agents/routing";
import { persistCommandReceipt } from "../test-support/receipts";
import { appendStoredMessage, loadThreadHistory } from "../db/history";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import { createScopeStore } from "../db/scopes";
import { createWorkflowExecutionStore } from "../db/workflow-executions";
import { createAssetStore } from "../files/asset-store";
import { createRegistry, type Capability } from "../test-support/registry";
import { createTurnController } from "./controller";
import { createRequestGate } from "./request-gate";
import { createTurnDispatcher } from "./turn-dispatcher";
import {
  isRepetitiveConversationalReply,
  runWorkflowTurn,
} from "./workflow-runner";

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup(
  route: typeof routeGlobalRequest,
  invoke: typeof invokeAgent,
  guidance?: () => GuidanceAssignment[],
  capabilities: Capability[] = [],
): {
  database: DatabaseSync;
  effects: import("vitest").Mock<() => { action: string; status: "success"; summary: string }>;
  controller: ReturnType<typeof createTurnController>;
  events: ChatEvent[];
  envelope: {
    threadId: string;
    userMessageId: string;
    assistantMessageId: string;
    source: "typed";
    admission: "immediate";
    text: string;
    attachmentIds: never[];
  };
  assets: ReturnType<typeof createAssetStore>;
  directory: string;
} {
  mkdirSync(join(process.cwd(), ".tmp", "scratch"), { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "scratch", "2026-10-15-workflow-test-"));
  directories.push(directory);
  mkdirSync(join(directory, "assets"));
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateDatabase(database, VERBO_MIGRATIONS);
  database.prepare("INSERT INTO threads(id,title,created_at,updated_at) VALUES('thread','Workflow',1,1)").run();
  const effects = vi.fn(() => ({
    action: "files.fixture",
    status: "success" as const,
    summary: "Created the requested fixture note.",
  }));
  const registry = createRegistry(
    [
      {
        id: "files.fixture",
        description: "Fixture create",
        kind: "mutation",
        args: z.object({ text: z.string() }).strict(),
        approval: "none",
        example: { text: "test" },
        execute: effects,
      },
      ...capabilities,
    ],
    { finalize: (value) => persistCommandReceipt(database, value) },
  );
  const assets = createAssetStore(database, join(directory, "assets"));
  const dispatcher = createTurnDispatcher(database);
  const gate = createRequestGate();
  const events: ChatEvent[] = [];
  const controller = createTurnController({
    database,
    dispatcher,
    retryDelays: [],
    work: (input) =>
      runWorkflowTurn({
        ...input,
        database,
        settings: DEFAULT_CHAT_SETTINGS,
        assets,
        registry,
        gate,
        inventory: {
          folders: [],
          truncated: false,
          generation: 1,
          refreshedAt: 1,
        },
        awaitDecision: undefined,
        invoke,
        route,
        guidance: guidance?.(),
      }),
  });
  const envelope = {
    threadId: "thread",
    userMessageId: "user-one",
    assistantMessageId: "assistant-one",
    source: "typed" as const,
    admission: "immediate" as const,
    text: "Create the fixture",
    attachmentIds: [],
  };
  return { database, effects, controller, events, envelope, assets, directory };
}

describe("Controller workflow integration", { timeout: 20_000 }, () => {
  it.each(["commander", "conversational"] as const)("supplies current module awareness to %s", async (agentId) => {
    const requests: Parameters<typeof invokeAgent>[0][] = [];
    const invoke: typeof invokeAgent = async (input) => {
      if (input.modelProfileId === "responder") throw new Error("Use deterministic presentation");
      requests.push(input);
      return {
        output: agentId === "conversational" ? { body: "Available commands." } : { findings: [], receiptIds: [] },
        outcome: { stop: "completed", content: "", results: [] },
      } as never;
    };
    const fixture = setup(async () => ({ value: { kind: "new", workflowId: agentId }, corrections: 0 }), invoke);
    await fixture.controller.admitTurn(fixture.envelope, () => undefined).completion;
    expect(requests[0]?.cts.sourceIds).toContain("commands");
    expect(requests[0]?.cts.instructions).toContain("- files:");
    expect(requests[0]?.cts.instructions).toContain("capabilities.search");
  });
  it("gives Commander prior receipt identities only from the selected branch", async () => {
    const requests: Parameters<typeof invokeAgent>[0][] = [];
    const invoke: typeof invokeAgent = async (input) => {
      if (input.modelProfileId === "responder") throw new Error("Use deterministic presentation");
      requests.push(input);
      return { output: { findings: [], receiptIds: [] }, outcome: { stop: "completed", content: "", results: [] } } as never;
    };
    const fixture = setup(async () => ({ value: { kind: "new", workflowId: "commander" }, corrections: 0 }), invoke);
    const receiptId = "84488558-522d-40ad-af0a-dc2c515761d9";
    appendStoredMessage(fixture.database, "thread", undefined, { id: "earlier-user", role: "user", content: [] });
    appendStoredMessage(fixture.database, "thread", "earlier-user", {
      id: "earlier-assistant",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolName: "actions.invoke",
          result: {
            action: "files.rename",
            status: "success",
            summary: "rename 1 item.",
            receiptId,
            detail: JSON.stringify({ operationId: receiptId }),
          },
        },
      ],
    });
    await fixture.controller.admitTurn({ ...fixture.envelope, text: "Undo the rename", branchAnchor: "earlier-assistant" }, () => undefined)
      .completion;
    expect(requests[0]?.value).toMatchObject({ priorCommandResults: [{ messageId: "earlier-assistant", result: { receiptId } }] });
    await fixture.controller.admitTurn(
      {
        ...fixture.envelope,
        text: "Different branch",
        branchAnchor: "earlier-user",
        userMessageId: "alternate-user",
        assistantMessageId: "alternate-assistant",
      },
      () => undefined,
    ).completion;
    expect(requests[1]?.value).toMatchObject({ priorCommandResults: [] });
  });
  it("marks a routing clarification as waiting for input, not successful completion", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("A clarification must not invoke a worker.");
    });
    const { controller, envelope, events, effects } = setup(
      async () => ({ value: { kind: "clarify", question: "Which folder should I use?" }, corrections: 0 }),
      invoke,
    );
    await controller.admitTurn(envelope, (event) => events.push(event)).completion;
    expect(events).toContainEqual(expect.objectContaining({ type: "input_required" }));
    expect(replyAttention(events)).toBe("question");
    expect(invoke).not.toHaveBeenCalled();
    expect(effects).not.toHaveBeenCalled();
  });
  it("gives Commander a usable folder root while retaining the selected registration ID", async () => {
    const requests: Parameters<typeof invokeAgent>[0][] = [];
    const invoke: typeof invokeAgent = async (input) => {
      if (input.modelProfileId === "responder") throw new Error("Use deterministic presentation");
      requests.push(input);
      return {
        output: { findings: ["Listed the folder"], receiptIds: [] },
        outcome: { stop: "completed", content: "", results: [] },
      } as never;
    };
    const fixture = setup(
      async () => ({
        value: { kind: "new", workflowId: "commander", targetHint: "garden" },
        corrections: 0,
      }),
      invoke,
    );
    const saved = await createScopeStore(fixture.database).apply({
      removeIds: [],
      updates: [],
      additions: [
        {
          alias: "garden",
          path: fixture.directory,
          read: true,
          write: true,
          defaultSave: false,
          kind: "obsidian",
        },
      ],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    await fixture.controller.admitTurn({ ...fixture.envelope, text: "List folders in garden" }, () => undefined).completion;
    expect(requests[0]?.value).toMatchObject({ target: "garden:/" });
    expect(requests[0]?.cts.instructions).toContain("Selected folder root: garden:/");
    expect(requests[0]?.cts.instructions).toContain("files.next");
    expect(requests[0]?.cts.instructions).toContain("never ask whether to continue");
    const execution = fixture.database.prepare("SELECT parameters_json FROM workflow_executions LIMIT 1").get();
    expect(JSON.parse(String(execution?.parameters_json)).target).toBe(saved.scopes[0].id);
  });
  it("passes one selected branch history without redundant conversational excerpts", async () => {
    const requests: Parameters<typeof invokeAgent>[0][] = [];
    const invoke: typeof invokeAgent = (input) => {
      requests.push(input);
      return invokeAgent({
        ...input,
        model: async (messages, _hooks, options) => {
          const latest = JSON.parse(messages.at(-1)!.content);
          expect(latest.contentRefs).toEqual([]);
          options.onCompletion?.({ done: true, prompt_eval_count: 55 });
          return [
            {
              done: true,
              message: {
                content: JSON.stringify({
                  body: `unique reply ${requests.length}`,
                }),
              },
            },
          ];
        },
      });
    };
    const { controller, envelope, database } = setup(
      async () => ({
        value: { kind: "new", workflowId: "conversational" },
        corrections: 0,
      }),
      invoke,
    );
    await controller.admitTurn(envelope, () => undefined).completion;
    await controller.admitTurn(
      {
        ...envelope,
        text: "current request",
        branchAnchor: "assistant-one",
        userMessageId: "user-two",
        assistantMessageId: "assistant-two",
      },
      () => undefined,
    ).completion;
    expect(requests[0]?.history).toEqual([]);
    expect(requests[1]?.history?.map((message) => message.messageId)).toEqual(["user-one", "assistant-one"]);
    expect(requests[1]?.history?.some((message) => message.content === "current request")).toBe(false);
    expect(loadThreadHistory(database, "thread").messages).toHaveLength(4);
    await controller.admitTurn(
      {
        ...envelope,
        text: "alternate branch",
        branchAnchor: "user-one",
        userMessageId: "user-alternate",
        assistantMessageId: "assistant-alternate",
      },
      () => undefined,
    ).completion;
    expect(requests[2]?.history?.map((message) => message.messageId)).toEqual(["user-one"]);
    database.prepare("INSERT INTO threads(id,title,created_at,updated_at) VALUES('other','Other',1,1)").run();
    await controller.admitTurn(
      {
        ...envelope,
        threadId: "other",
        text: "other chat",
        userMessageId: "other-user",
        assistantMessageId: "other-assistant",
      },
      () => undefined,
    ).completion;
    expect(requests[3]?.history).toEqual([]);
  });
  it.each(["write", "edit", "move", "rename", "delete"] as const)(
    "runs the %s Obsidian composition with retained body/identity and truthful unsupported results",
    async (operation) => {
      let originalRef = "";
      const dispatched: { operation: string; args: Record<string, unknown> }[] = [];
      const capabilities = ["read", "create", "edit", "move", "rename", "delete"].map((name): Capability => ({
        id: `obsidian.${name}`,
        description: `Fixture ${name}`,
        kind: name === "read" ? "read" : "mutation",
        approval: "none",
        example: {},
        args: z
          .object({
            vault: z.string(),
            path: z.string().optional(),
            contentRef: z.string().optional(),
            revision: z.string().optional(),
          })
          .strict(),
        execute: (args) => {
          dispatched.push({ operation: name, args });
          return {
            action: `obsidian.${name}`,
            status: ["edit", "delete"].includes(name) ? "not_supported" : "success",
            summary: ["edit", "delete"].includes(name) ? `Fixture ${name} semantics are unsupported.` : `Fixture ${name} verified.`,
            ...(name === "read"
              ? {
                  data: {
                    contentRef: originalRef,
                    path: "Inbox/Exact.md",
                    revision: "a".repeat(64),
                  },
                }
              : {}),
          };
        },
      }));
      const invoked: string[] = [];
      const invoke: typeof invokeAgent = async (input) => {
        if (input.modelProfileId === "responder") throw new Error("Deterministic fallback");
        invoked.push(input.agentId);
        const value = input.value as Record<string, unknown>;
        let output: unknown;
        const results: import("../../shared/action-contract").ActionResult[] = [];
        if (input.agentId === "decision") output = { kind: "selected", value: operation };
        else if (input.agentId === "writer") {
          if (operation === "edit")
            expect(value).toMatchObject({
              source: "Original exact note",
              path: "Inbox/Exact.md",
              revision: "a".repeat(64),
            });
          output = { body: "Composed fixture body" };
        } else {
          const name = value.operation === "write" ? "create" : String(value.operation);
          if (name === "edit")
            expect(value).toMatchObject({
              path: "Inbox/Exact.md",
              revision: "a".repeat(64),
            });
          if (typeof value.contentRef === "string")
            expect(await fixture.assets.text("thread", value.contentRef)).toBe("Composed fixture body");
          const result = await withInvocation(input.cts.policy, () =>
            input.registry.invoke(
              `obsidian.${name}`,
              {
                vault: value.target,
                ...(value.path ? { path: value.path } : {}),
                ...(value.revision ? { revision: value.revision } : {}),
                ...(value.contentRef ? { contentRef: value.contentRef } : {}),
              },
              { ...input.context, invocation: input.cts.policy },
            ),
          );
          results.push(result);
          output = { findings: [], receiptIds: [result.receiptId] };
        }
        return {
          output: input.outputSchema.parse(output),
          outcome: {
            stop: "completed",
            content: JSON.stringify(output),
            results,
            rounds: 1,
            toolRequests: results.length,
            removedCount: 0,
          },
        };
      };
      const fixture = setup(
        async () => ({
          value: { kind: "new", workflowId: "obsidian", targetHint: "garden" },
          corrections: 0,
        }),
        invoke,
        undefined,
        capabilities,
      );
      mkdirSync(join(fixture.directory, ".obsidian"));
      expect(
        (
          await createScopeStore(fixture.database).apply({
            removeIds: [],
            updates: [],
            additions: [
              {
                alias: "garden",
                path: fixture.directory,
                kind: "obsidian",
                read: true,
                write: true,
                defaultSave: false,
              },
            ],
          })
        ).ok,
      ).toBe(true);
      const original = fixture.assets.put({
        threadId: "thread",
        name: "original.md",
        mediaType: "text/markdown",
        bytes: Buffer.from("Original exact note"),
      });
      if (!original.ok) throw new Error(original.summary);
      originalRef = original.attachment.id;
      await fixture.controller.admitTurn(fixture.envelope, () => undefined).completion;
      const execution = createWorkflowExecutionStore(fixture.database).list("thread")[0]!;
      expect(execution.status).toBe(["edit", "delete"].includes(operation) ? "failed" : "completed");
      expect(execution.outcome?.status).toBe(operation === "edit" ? "partial" : operation === "delete" ? "blocked" : "completed");
      expect(dispatched.map((entry) => entry.operation)).toEqual(
        operation === "edit" ? ["read", "edit"] : [operation === "write" ? "create" : operation],
      );
      expect(invoked).toEqual(
        operation === "write"
          ? ["decision", "writer", "commander"]
          : operation === "edit"
            ? ["decision", "commander", "writer", "commander"]
            : ["decision", "commander"],
      );
    },
  );
  it.each(["removed", "reassigned", "retargeted"])(
    "blocks continuation when guidance is %s, including another role's assignment",
    async (change) => {
      let assignments: GuidanceAssignment[] = [
        {
          id: "style",
          reference: "work:/style.md",
          scopeId: "work",
          audiences: ["writer"],
          sha256: "a".repeat(64),
        },
      ];
      let calls = 0;
      const invoke: typeof invokeAgent = async (input) => {
        if (input.modelProfileId === "responder") throw new Error("Fallback");
        calls += 1;
        return {
          output: input.outputSchema.parse({
            findings: [],
            receiptIds: [],
            question: {
              text: "Continue?",
              required: true,
              expected: { type: "boolean" },
              binding: "continue",
            },
          }),
          outcome: {
            stop: "completed",
            content: "",
            results: [],
            rounds: 1,
            toolRequests: 0,
            removedCount: 0,
          },
        };
      };
      const fixture = setup(
        async (input) =>
          input.request === "yes"
            ? {
                value: {
                  kind: "resume",
                  executionId: input.pending[0]!.id,
                  expectedRevision: input.pending[0]!.revision,
                  answer: true,
                },
                corrections: 0,
              }
            : {
                value: { kind: "new", workflowId: "commander" },
                corrections: 0,
              },
        invoke,
        () => assignments,
      );
      await fixture.controller.admitTurn(fixture.envelope, () => undefined).completion;
      const store = createWorkflowExecutionStore(fixture.database);
      const waiting = store.list("thread")[0]!;
      expect(waiting.status).toBe("awaiting_input");
      assignments =
        change === "removed"
          ? []
          : assignments.map((entry) => ({
              ...entry,
              ...(change === "reassigned" ? { audiences: ["commander" as const] } : { reference: "work:/other.md" }),
            }));
      await fixture.controller.admitTurn(
        {
          ...fixture.envelope,
          text: "yes",
          branchAnchor: "assistant-one",
          userMessageId: "next-user",
          assistantMessageId: "next-assistant",
        },
        () => undefined,
      ).completion;
      expect(calls).toBe(1);
      expect(store.read(waiting.id)?.checkpoint.result).toMatchObject({
        status: "blocked",
        code: "guidance_changed",
      });
    },
  );
  it("delivers one tool-free conversational invocation without a Responder, and retains draft references", async () => {
    const calls: string[] = [];
    let capturedInput: Parameters<typeof invokeAgent>[0] | undefined;
    const invoke: typeof invokeAgent = async (input) => {
      calls.push(input.modelProfileId);
      capturedInput = input;
      return {
        output: input.outputSchema.parse({ body: "Hello from conversation" }),
        outcome: {
          stop: "completed",
          content: '{"body":"Hello from conversation"}',
          results: [],
          rounds: 1,
          toolRequests: 0,
          removedCount: 0,
        },
      };
    };
    const { controller, envelope, database, assets } = setup(
      async () => ({
        value: { kind: "new", workflowId: "conversational" },
        corrections: 0,
      }),
      invoke,
    );
    await controller.admitTurn(envelope, () => undefined).completion;
    expect(calls).toEqual(["conversational"]);
    expect(capturedInput?.value).toMatchObject({
      request: "Create the fixture",
      contentRefs: [],
      attachments: "",
    });
    expect(capturedInput?.value).not.toHaveProperty("answers");
    expect(capturedInput?.value).not.toHaveProperty("completedReceipts");
    expect(capturedInput?.cts.instructions).toContain(
      "Reference facts about Verbo and this workspace",
    );
    expect(capturedInput?.cts.instructions).not.toContain("Untrusted task data (notes.conversational)");
    const execution = createWorkflowExecutionStore(database).list("thread")[0]!;
    expect(execution.status).toBe("completed");
    const output = execution.checkpoint.outputs.reply as { contentRef: string };
    expect(await assets.text("thread", output.contentRef)).toBe("Hello from conversation");
    expect(assets.remove("thread", output.contentRef)).toBe(false);
    expect(JSON.stringify(execution.checkpoint)).not.toContain("Hello from conversation");
    expect(loadThreadHistory(database, "thread").messages.at(-1)?.message.content).toContainEqual({
      type: "text",
      text: "Hello from conversation",
    });
  });

  it("handles conversational invocation failure directly without responder, recording status failed", async () => {
    let responderCalled = false;
    const invoke: typeof invokeAgent = async (input) => {
      if (input.modelProfileId === "responder") {
        responderCalled = true;
        throw new Error("responder should not be called");
      }
      if (input.agentId === "conversational") {
        throw new Error("The conversational invocation reached its time limit.");
      }
      return { output: { body: "ok" } } as never;
    };
    const emittedEvents: ChatEvent[] = [];
    const { controller, envelope, database } = setup(
      async () => ({
        value: { kind: "new", workflowId: "conversational" },
        corrections: 0,
      }),
      invoke,
    );
    await controller.admitTurn(envelope, (event) => emittedEvents.push(event)).completion;

    expect(responderCalled).toBe(false);
    const store = createWorkflowExecutionStore(database);
    const executions = store.list("thread");
    expect(executions).toHaveLength(1);
    expect(executions[0]?.status).toBe("failed");
    expect(executions[0]?.outcome?.status).toBe("failed");

    const deltas = emittedEvents.filter((e) => e.type === "delta");
    expect(deltas.map((d) => (d as { type: "delta"; text: string }).text).join("")).toContain(
      "The conversational invocation reached its time limit.",
    );

    expect(loadThreadHistory(database, "thread").messages.at(-1)?.message.content).toContainEqual({
      type: "text",
      text: "The conversational invocation reached its time limit.",
    });
  });

  it("resumes a required answer without repeating an already completed mutation even when the worker asks again", async () => {
    let commanderCalls = 0;
    const invoke: typeof invokeAgent = async (input) => {
      if (input.modelProfileId === "responder") throw new Error("Responder unavailable");
      commanderCalls += 1;
      const result = await withInvocation(input.cts.policy, () =>
        input.registry.invoke("files.fixture", { text: "saved body" }, { ...input.context, invocation: input.cts.policy }),
      );
      const output = {
        findings: [],
        receiptIds: [result.receiptId!],
        ...{
          question: {
            text: "Continue with the next part?",
            required: true,
            expected: { type: "boolean" },
            binding: "continue",
          },
        },
      };
      return {
        output: input.outputSchema.parse(output),
        outcome: {
          stop: "completed",
          content: JSON.stringify(output),
          results: [result],
          rounds: 1,
          toolRequests: 1,
          removedCount: 0,
        },
      };
    };
    const route: typeof routeGlobalRequest = async (input) =>
      input.request === "yes"
        ? {
            value: {
              kind: "resume",
              executionId: input.pending[0]!.id,
              expectedRevision: input.pending[0]!.revision,
              answer: true,
            },
            corrections: 0,
          }
        : { value: { kind: "new", workflowId: "commander" }, corrections: 0 };
    const { controller, envelope, database, effects, events } = setup(route, invoke);
    await controller.admitTurn(envelope, (event) => events.push(event)).completion;
    const waiting = createWorkflowExecutionStore(database).list("thread")[0]!;
    expect(waiting.status).toBe("awaiting_input");
    expect(effects).toHaveBeenCalledTimes(1);
    const firstReceipt = createWorkflowExecutionStore(database).attempts(waiting.id)[0]?.receipt_id;
    await controller.admitTurn(
      {
        ...envelope,
        text: "yes",
        branchAnchor: "assistant-one",
        userMessageId: "user-two",
        assistantMessageId: "assistant-two",
      },
      (event) => events.push(event),
    ).completion;
    const finished = createWorkflowExecutionStore(database).read(waiting.id)!;
    expect(finished.status).toBe("completed");
    expect(commanderCalls).toBe(2);
    expect(effects).toHaveBeenCalledTimes(1);
    expect(createWorkflowExecutionStore(database).attempts(waiting.id)).toHaveLength(1);
    expect(createWorkflowExecutionStore(database).attempts(waiting.id)[0]?.receipt_id).toBe(firstReceipt);
    expect(finished.outcome?.receiptIds).toContain(firstReceipt);
    expect(loadThreadHistory(database, "thread").messages.filter((item) => item.message.role === "assistant")).toHaveLength(2);
  });

  it("suspends preexisting pending work when a queued yes is promoted, without binding it as an answer", async () => {
    const invoke: typeof invokeAgent = async (input) => {
      if (input.modelProfileId === "responder") throw new Error("Fallback");
      if (input.agentId === "conversational")
        return {
          output: input.outputSchema.parse({ body: "Queued interruption" }),
          outcome: {
            stop: "completed",
            content: "",
            results: [],
            rounds: 1,
            toolRequests: 0,
            removedCount: 0,
          },
        };
      return {
        output: input.outputSchema.parse({
          findings: [],
          receiptIds: [],
          question: {
            text: "Ready?",
            required: true,
            expected: { type: "boolean" },
            binding: "ready",
          },
        }),
        outcome: {
          stop: "completed",
          content: "",
          results: [],
          rounds: 1,
          toolRequests: 0,
          removedCount: 0,
        },
      };
    };
    const route: typeof routeGlobalRequest = async (input) => {
      if (input.request === "yes") {
        expect(input.queuedInterruption).toBe(true);
        expect(input.pending[0]?.status).toBe("suspended");
        return {
          value: { kind: "new", workflowId: "conversational" },
          corrections: 0,
        };
      }
      return {
        value: { kind: "new", workflowId: "commander" },
        corrections: 0,
      };
    };
    const { controller, envelope, database } = setup(route, invoke);
    await controller.admitTurn(envelope, () => undefined).completion;
    const first = createWorkflowExecutionStore(database).list("thread")[0]!;
    await controller.admitTurn(
      {
        ...envelope,
        admission: "promoted",
        text: "yes",
        userMessageId: "queued-yes",
        assistantMessageId: "second",
        branchAnchor: "assistant-one",
      },
      () => undefined,
    ).completion;
    expect(createWorkflowExecutionStore(database).read(first.id)).toMatchObject({
      status: "suspended",
      reason: "queued_interruption",
      parameters: { target: null },
    });
    expect(createWorkflowExecutionStore(database).read(first.id)?.parameters.answers).toBeUndefined();
  });

  it("retries a conversational reply with higher temperature, seed, and anti-repetition directive when repetitive", async () => {
    const requests: Parameters<typeof invokeAgent>[0][] = [];
    let callCount = 0;
    const firstReply =
      "I am Verbo, a local desktop AI assistant running on your machine with Electron, Ollama for inference, and local SQLite persistence.";
    const diversifiedReply =
      "Under the hood, Verbo coordinates three distinct workflows: conversational, commander, and obsidian. It provides speech recognition and local TTS.";
    const invoke: typeof invokeAgent = async (input) => {
      requests.push(input);
      callCount += 1;
      const body = callCount === 1 ? firstReply : callCount === 2 ? firstReply : diversifiedReply;
      return {
        output: input.outputSchema.parse({ body }),
        outcome: {
          stop: "completed",
          content: JSON.stringify({ body }),
          results: [],
          rounds: 1,
          toolRequests: 0,
          removedCount: 0,
        },
      };
    };
    const route: typeof routeGlobalRequest = async () => ({
      value: { kind: "new", workflowId: "conversational" },
      corrections: 0,
    });
    const fixture = setup(route, invoke);
    await fixture.controller.admitTurn(fixture.envelope, () => undefined).completion;

    await fixture.controller.admitTurn(
      {
        ...fixture.envelope,
        text: "Tell me more about yourself",
        branchAnchor: "assistant-one",
        userMessageId: "user-two",
        assistantMessageId: "assistant-two",
      },
      () => undefined,
    ).completion;

    expect(callCount).toBe(3);
    const retryInvocation = requests[2]!;
    expect(retryInvocation.temperature).toBeGreaterThanOrEqual(0.75);
    expect(typeof retryInvocation.seed).toBe("number");
    expect(retryInvocation.seed).toBeGreaterThan(0);
    expect(retryInvocation.value).toMatchObject({
      avoidRepeatingPriorReplies: [firstReply],
      diversificationDirective: expect.stringContaining("repeated an earlier assistant message"),
    });
    const history = loadThreadHistory(fixture.database, "thread").messages;
    expect(history).toHaveLength(4);
    expect(history.at(-1)?.message.content).toContainEqual({
      type: "text",
      text: diversifiedReply,
    });
  });
});

describe("isRepetitiveConversationalReply", () => {
  it("detects exact duplicate replies", () => {
    const reply = "I am Verbo, a local desktop AI assistant.";
    expect(isRepetitiveConversationalReply(reply, [reply])).toBe(true);
  });

  it("detects near-duplicates differing only by a word or two", () => {
    const prior =
      "Verbo is a desktop assistant running on your machine with Electron, Ollama for inference, and local SQLite persistence. It helps you think through problems and explore ideas without cloud dependencies.";
    const candidate =
      "Verbo is a desktop assistant running directly on your machine with Electron, Ollama for inference, and local SQLite persistence. It helps you think through problems and explore ideas without cloud dependencies.";
    expect(isRepetitiveConversationalReply(candidate, [prior])).toBe(true);
  });

  it("returns false for genuinely distinct follow-up replies", () => {
    const prior =
      "Verbo is a desktop assistant running on your machine with Electron, Ollama for inference, and local SQLite persistence. It helps you think through problems and explore ideas without cloud dependencies.";
    const candidate =
      "Under the hood, Verbo coordinates three distinct workflows: conversational, commander, and obsidian. It provides speech recognition via Whisper and local TTS.";
    expect(isRepetitiveConversationalReply(candidate, [prior])).toBe(false);
  });

  it("returns false when candidate is blank or prior replies list is empty", () => {
    expect(isRepetitiveConversationalReply("", ["prior reply text"])).toBe(false);
    expect(isRepetitiveConversationalReply("some response", [])).toBe(false);
  });
});
