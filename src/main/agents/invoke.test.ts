import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import {
  createRegistry,
  dispatchModelTool,
  type Capability,
} from "../test-support/registry";
import { createRequestGate } from "../runtime/request-gate";
import { ollamaChatBody } from "../services/ollama-turn-stream";
import { resolveCTS } from "./cts";
import { invokeAgent, createTurnBudget } from "./invoke";
import { withApprovalInvocation, withInvocation } from "./policy";
import { inferenceMeasurements } from "../runtime/prompt-eval";

const write = vi.fn(() => ({
  action: "files.create",
  status: "success" as const,
  summary: "Created",
}));
const capability: Capability = {
  id: "files.create",
  aliases: ["make"],
  description: "Create",
  args: z.object({}).strict(),
  kind: "mutation",
  approval: "none",
  example: {},
  execute: write,
};
const context = { actor: "model" as const, threadId: "thread" };
describe("backend invocation boundaries", () => {
  it("reports a profile deadline as a timeout rather than a user stop", async () => {
    const budget = createTurnBudget({ signal: new AbortController().signal });
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    try {
      const pending = invokeAgent({
        agentId: "writer",
        modelProfileId: "writer",
        configured: DEFAULT_CHAT_SETTINGS,
        cts: resolveCTS({
          invocationId: "deadline",
          agentId: "writer",
          ceiling: { modules: [], actions: [] },
          sources: [],
        }),
        value: {},
        outputSchema: z.object({ body: z.string() }),
        registry: createRegistry([]),
        context,
        gate: createRequestGate(),
        budget,
        model: async (_messages, hooks) =>
          new Promise((_resolve, reject) => {
            if (hooks.signal?.aborted) reject(hooks.signal.reason);
            else
              hooks.signal?.addEventListener(
                "abort",
                () => reject(hooks.signal?.reason),
                { once: true },
              );
          }),
      });
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      await expect(pending).rejects.toThrow(
        "writer invocation reached its time limit",
      );
    } finally {
      timeout.mockRestore();
    }
  });
  it("repairs malformed Commander output once without tools or repeating completed effects", async () => {
    const effect = vi.fn(() => ({
      action: "files.create",
      status: "success" as const,
      summary: "Created",
      receiptId: "receipt",
    }));
    const registry = createRegistry([{ ...capability, execute: effect }]);
    const cts = resolveCTS({
      invocationId: "repair",
      agentId: "commander",
      ceiling: { modules: ["files"], actions: [] },
      sources: [],
    });
    const schema = z.object({
      findings: z.array(z.string()),
      receiptIds: z.array(z.string()),
    });
    let rounds = 0;
    const result = await invokeAgent({
      agentId: "commander",
      modelProfileId: "commander",
      cts,
      configured: DEFAULT_CHAT_SETTINGS,
      registry,
      context,
      gate: createRequestGate(),
      budget: createTurnBudget({ signal: new AbortController().signal }),
      value: { request: "Create a file" },
      outputSchema: schema,
      outputJsonSchema: z.toJSONSchema(schema),
      model: async (_messages, _hooks, options) => {
        rounds += 1;
        options.onCompletion?.({ done: true, prompt_eval_count: rounds * 100 });
        if (rounds === 1)
          return [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "actions.invoke",
                      arguments: { name: "files.create", args: {} },
                    },
                  },
                ],
              },
              done: true,
            },
          ];
        if (rounds === 2)
          return [{ message: { content: "Created." }, done: true }];
        expect(options.tools).toBe(false);
        expect(options.format).toEqual(z.toJSONSchema(schema));
        return [
          {
            message: {
              content: '{"findings":["Created"],"receiptIds":["receipt"]}',
            },
            done: true,
          },
        ];
      },
    });
    expect(result.output.receiptIds).toEqual(["receipt"]);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(rounds).toBe(3);
    expect(result.outcome.results).toHaveLength(1);
    const measurements = inferenceMeasurements
      .list()
      .filter((item) => item.invocationId === "repair");
    expect(measurements).toHaveLength(3);
    expect(new Set(measurements.map((item) => item.requestId)).size).toBe(3);
    expect(measurements.map((item) => item.promptTokens)).toEqual([
      100, 200, 300,
    ]);
    expect(measurements.every((item) => item.status === "completed")).toBe(
      true,
    );
  });
  it.each(["decision", "writer", "conversational"] as const)(
    "denies %s direct dispatch and discovery, omits tools on the wire",
    async (agentId) => {
      const cts = resolveCTS({
        invocationId: "invocation",
        agentId,
        ceiling: { modules: ["files"], actions: [] },
        sources: [],
      });
      const registry = createRegistry([capability]);
      const bound = { ...context, invocation: cts.policy };
      expect(await registry.invoke("make", {}, bound)).toMatchObject({
        status: "denied",
        code: "invocation_forbidden",
      });
      expect(
        await dispatchModelTool(registry, "capabilities.list", {}, bound),
      ).toMatchObject({ status: "denied" });
      expect(
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "files.create", args: {} },
          bound,
        ),
      ).toMatchObject({ status: "denied" });
      const result = await invokeAgent({
        agentId,
        modelProfileId: agentId,
        cts,
        configured: DEFAULT_CHAT_SETTINGS,
        registry,
        context,
        gate: createRequestGate(),
        budget: createTurnBudget({ signal: new AbortController().signal }),
        value: {
          request: "Hello",
          contentRefs: [{ messageId: "source", excerpt: "needed context" }],
        },
        outputSchema: z.object({ text: z.string() }),
        model: async (messages, _hooks, options) => {
          expect(messages).toHaveLength(2);
          expect(JSON.parse(messages.at(-1)!.content).contentRefs).toEqual([
            { messageId: "source", excerpt: "needed context" },
          ]);
          expect(
            ollamaChatBody([], DEFAULT_CHAT_SETTINGS, options),
          ).not.toHaveProperty("tools");
          return [{ message: { content: '{"text":"Hello"}' }, done: true }];
        },
      });
      expect(result.output).toEqual({ text: "Hello" });
    },
  );
  it("filters discovery and preserves policy through newly constructed registries and approvals", async () => {
    const cts = resolveCTS({
      invocationId: "limited",
      agentId: "commander",
      ceiling: { modules: ["files", "software"], actions: [] },
      sources: [],
      capabilities: { mode: "replace", actions: ["files.create"] },
    });
    const unauthorized: Capability = {
      ...capability,
      id: "software.open",
      aliases: [],
      execute: () => {
        throw new Error("must not run");
      },
    };
    const registry = createRegistry([capability, unauthorized]);
    withInvocation(cts.policy, () => {
      expect(registry.search("open").matches).toEqual([]);
      expect(registry.describe(["software.open"]).entries).toEqual([
        { id: "software.open", code: "unknown" },
      ]);
      expect(registry.list().children.map((entry) => entry.id)).toEqual([
        "files",
      ]);
    });
    const parent: Capability = {
      ...capability,
      execute: async () =>
        createRegistry([unauthorized]).invoke("software.open", {}, context),
    };
    expect(
      await createRegistry([parent]).invoke(
        "files.create",
        {},
        { ...context, invocation: cts.policy },
      ),
    ).toMatchObject({ status: "denied" });
    const approval: Capability = {
      ...capability,
      execute: () => ({
        action: "files.create",
        status: "requires_confirmation",
        summary: "Confirm",
        operationId: "approved",
      }),
    };
    await createRegistry([approval]).invoke(
      "files.create",
      {},
      { ...context, invocation: cts.policy },
    );
    expect(
      await withApprovalInvocation("approved", "thread", () =>
        registry.invoke("software.open", {}, context),
      ),
    ).toMatchObject({ status: "denied" });
  });
  it("removes a cancelled request from the gate before model admission", async () => {
    const gate = createRequestGate();
    let release!: () => void;
    const active = gate.schedule(
      0,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const abort = new AbortController();
    const model = vi.fn();
    const pending = gate.schedule(0, model, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    release();
    await active;
    await gate.schedule(0, async () => undefined);
    expect(model).not.toHaveBeenCalled();
  });
});
