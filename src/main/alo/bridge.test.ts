import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createProductionRegistry } from "../capabilities/catalog";
import { dispatchModelTool } from "../capabilities/registry";
import { createInvocationPolicy } from "../agents/policy";
import { runTurn } from "../runtime/turn";
import { createRequestGate } from "../runtime/request-gate";
import { PERMANENT_OLLAMA_TOOLS } from "../runtime/ollama-wire";
import {
  applyAloSettingsSnapshot,
  readAloSettings,
  saveAloSetting,
} from "../test-support/alo-settings";
import { aloCall, aloCallSync } from "./client";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import { streamOllamaTurn } from "../services/ollama-turn-stream";
import { toOllamaMessages } from "../runtime/ollama-wire";

const directories: string[] = [];
function fixture(): {
  actor: "model";
  threadId: string;
  invocation: ReturnType<typeof createInvocationPolicy>;
} {
  const directory = mkdtempSync(join(tmpdir(), "verbo-alo-"));
  directories.push(directory);
  vi.stubEnv("VERBO_ALO_NODE", process.execPath);
  vi.stubEnv("VERBO_ALO_ENTRY", resolve("../alo/dist/cli/main.js"));
  vi.stubEnv("VERBO_ALO_PROFILE", join(directory, "alo.sqlite"));
  const policy = createInvocationPolicy({
    id: "slice",
    agentId: "commander",
    exposed: true,
    allowed: { modules: ["environment"], actions: [] },
    discoverable: { modules: ["environment"], actions: [] },
    forbidden: [],
  });
  return { actor: "model" as const, threadId: "fixture", invocation: policy };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("Alo subprocess extraction slice", () => {
  it("accepts a discovered root repeated in path for file queries", async () => {
    const context = fixture();
    context.invocation = createInvocationPolicy({
      ...context.invocation,
      allowed: { modules: ["files"], actions: [] },
      discoverable: { modules: ["files"], actions: [] },
    });
    const root = join(directories[directories.length - 1], "notes");
    mkdirSync(join(root, "Inbox"), { recursive: true });
    writeFileSync(join(root, "Inbox", "idea.md"), "idea");
    expect(
      aloCallSync({
        method: "settings.scopes.apply",
        context: { actor: "ui", threadId: context.threadId },
        args: {
          removeIds: [],
          updates: [],
          additions: [
            {
              alias: "nous",
              path: root,
              read: true,
              write: false,
              defaultSave: false,
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true });
    const registry = createProductionRegistry();
    const scopes = await dispatchModelTool(
      registry,
      "actions.invoke",
      { name: "files.scopes", args: {} },
      context,
    );
    expect(scopes.status).toBe("success");
    const scope = JSON.parse(scopes.detail!).scopes[0] as {
      id: string;
      root: string;
    };
    expect(scope.root).toBe("nous:/");
    for (const reference of [scope.root, scope.id]) {
      for (const [name, extra] of [
        ["files.list", { entryType: "directories", includeHidden: true }],
        ["files.search", { mode: "filename", query: "idea" }],
        ["files.summary", {}],
      ] as const) {
        const result = await dispatchModelTool(
          registry,
          "actions.invoke",
          { name, args: { root: reference, path: reference, ...extra } },
          context,
        );
        expect(result.status, `${name}: ${result.summary}`).toBe("success");
        const detail = JSON.parse(result.detail!);
        if (name === "files.summary") {
          expect(detail).toMatchObject({ files: 1, directories: 1 });
        } else {
          expect(
            detail.items.map((item: { path: string }) => item.path),
          ).toEqual([
            name === "files.list" ? "nous:/Inbox" : "nous:/Inbox/idea.md",
          ]);
        }
      }
    }
  }, 30000);
  it.skipIf(process.env.VERBO_LIVE_ALO !== "1")(
    "runs the actual Qwen tool loop through Alo",
    async () => {
      const context = fixture();
      const registry = createProductionRegistry();
      const outcome = await runTurn({
        userText:
          'Use the registered tools. Call capabilities.list with {"category":"environment"}. Then capabilities.describe with {"ids":["environment.platform"]}. Then actions.invoke with {"name":"environment.platform","args":{}}. Reply with the platform from the invoke result.',
        history: [],
        numCtx: 8192,
        registry,
        context,
        gate: createRequestGate(),
        model: (messages, hooks) =>
          streamOllamaTurn(
            toOllamaMessages(messages),
            { ...DEFAULT_CHAT_SETTINGS, think: false, temperature: 0.2 },
            hooks.signal ?? AbortSignal.timeout(120000),
            hooks.onText,
          ),
      });
      console.info(
        "Alo live Qwen acceptance",
        JSON.stringify({
          stop: outcome.stop,
          content: outcome.content,
          results: outcome.results.map((result) => ({
            action: result.action,
            status: result.status,
            code: result.code,
          })),
        }),
      );
      expect(outcome.stop).toBe("completed");
      expect(
        outcome.results.find(
          (result) => result.action === "environment.platform",
        )?.status,
      ).toBe("success");
      expect(
        outcome.results.find(
          (result) => result.action === "environment.platform",
        )?.detail,
      ).toContain(`"platform":"${platform()}"`);
      expect(outcome.content.toLowerCase()).toMatch(
        platform() === "win32" ? /windows|win32/ : new RegExp(platform()),
      );
    },
    180000,
  );
  it("preserves the exact four Ollama declarations", () => {
    fixture();
    const load = createRequire(import.meta.url);
    const extracted = load(resolve("../alo/dist/contracts/model-tools.js")) as {
      PERMANENT_OLLAMA_TOOLS: unknown;
    };
    expect(extracted.PERMANENT_OLLAMA_TOOLS).toEqual(PERMANENT_OLLAMA_TOOLS);
  });
  it("forwards all four tools through a real child and never exposes old Web or guessed commands", async () => {
    const context = fixture();
    const registry = createProductionRegistry();
    for (const [name, args] of [
      ["capabilities.list", { category: "environment" }],
      ["capabilities.search", { query: "platform" }],
      ["capabilities.describe", { ids: ["environment.platform"] }],
      ["actions.invoke", { name: "environment.platform", args: {} }],
    ] as const) {
      const result = await dispatchModelTool(registry, name, args, context);
      expect(result.status).toBe("success");
      expect(result.detail).toContain(
        name === "actions.invoke" ? platform() : "environment.platform",
      );
    }
    expect(
      (
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "web.search", args: { query: "hello" } },
          context,
        )
      ).code,
    ).toBe("unknown_action");
    expect(
      (
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "files.trash", args: {} },
          context,
        )
      ).status,
    ).toBe("denied");
  });
  it("keeps the existing turn loop, tool-result publication and workflow ledger around the child", async () => {
    const context = fixture();
    const before = vi.fn(() => ({ id: "attempt", receiptId: "receipt" }));
    const after = vi.fn();
    context.invocation = createInvocationPolicy({
      ...context.invocation,
      ledger: { before, after },
    });
    const registry = createProductionRegistry();
    let rounds = 0;
    const events: string[] = [];
    const outcome = await runTurn({
      userText: "Report the platform",
      history: [],
      numCtx: 8192,
      registry,
      context,
      gate: createRequestGate(),
      onUpdate: (update) => {
        events.push(update.type);
      },
      model: async () =>
        ++rounds === 1
          ? [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      function: {
                        name: "actions.invoke",
                        arguments: { name: "environment.platform", args: {} },
                      },
                    },
                  ],
                },
                done: true,
              },
            ]
          : [
              {
                message: {
                  role: "assistant",
                  content: `Platform is ${platform()}.`,
                },
                done: true,
              },
            ],
    });
    expect(outcome.stop).toBe("completed");
    expect(outcome.results[0]?.status).toBe("success");
    expect(outcome.content).toContain(platform());
    expect(events).toContain("tool_result");
    expect(before).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    expect(after.mock.calls[0]?.[1].receiptId).toBe("receipt");
  });
  it("settings use the same fields and refresh a terminal edit without caching a competing value", async () => {
    fixture();
    const saved = await saveAloSetting({
      nodeId: "environment.platform",
      version: 1,
      aliases: ["workstation"],
    });
    expect(saved.ok).toBe(true);
    expect(
      readAloSettings().nodes.find((node) => node.id === "environment.platform")
        ?.aliases,
    ).toEqual(["workstation"]);
    await aloCall({
      method: "settings.save",
      args: {
        nodeId: "environment.platform",
        version: 1,
        aliases: ["external-edit"],
      },
      context: { actor: "user_command", threadId: "terminal" },
    });
    const nodes = applyAloSettingsSnapshot([
      { id: "environment.platform", description: "Platform", aliases: [] },
    ]);
    expect(nodes[0].aliases).toEqual(["external-edit"]);
    expect(createProductionRegistry().resolve("env.external-edit")).toEqual({
      ok: true,
      id: "environment.platform",
    });
  });
  it("enforces hidden invocation policy and never promotes a model without trusted context", async () => {
    const context = fixture();
    const registry = createProductionRegistry();
    context.invocation = createInvocationPolicy({
      ...context.invocation,
      discoverable: { modules: [], actions: [] },
    });
    expect(
      (
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "environment.platform" },
          context,
        )
      ).status,
    ).toBe("denied");
    expect(
      (
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "environment.platform" },
          { actor: "model", threadId: "missing-policy" },
        )
      ).status,
    ).toBe("denied");
  });
  it("returns an error without running the local platform handler when Alo disappears", async () => {
    const context = fixture();
    const registry = createProductionRegistry();
    vi.stubEnv("VERBO_ALO_ENTRY", resolve("../alo/dist/missing.js"));
    const result = await dispatchModelTool(
      registry,
      "actions.invoke",
      { name: "environment.platform" },
      context,
    );
    expect(result.status).toBe("error");
    expect(result.code).toBe("alo_unavailable");
  });
});
