import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  actionResultSchema,
  type ActionResult,
} from "../../shared/action-contract";
import {
  createModuleRegistry,
  type CommandDefinition,
  type CommandModule,
  type TrustedCommandBindings,
} from "./modules";
import { bindTrustedProcess } from "./process";

const context = { actor: "user_command" as const, threadId: "fixture-thread" };
function command(
  id: string,
  execution: CommandDefinition["execution"],
  aliases: string[] = [],
): CommandDefinition {
  return {
    id,
    aliases,
    description: "Fixture command",
    kind: "read",
    approval: "none",
    args: z.object({ text: z.string().default("fixture") }).strict(),
    example: {},
    execution,
    tags: [],
    parameterHelp: {},
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none",
    configurable: ["aliases"],
  };
}
function module(commands: CommandDefinition[]): CommandModule {
  return {
    id: "web",
    aliases: ["internet"],
    description: "Fixture web module",
    version: 1,
    scopes: [
      { id: "web.page", aliases: ["site"], description: "Pages" },
      { id: "web.page.content", aliases: ["article"], description: "Content" },
    ],
    commands,
  };
}
const handlers: TrustedCommandBindings = {
  handlers: {
    "fixture.read": async (args) => ({
      action: "web.page.content.extract",
      status: "success",
      summary: String(args.text),
    }),
  },
  processes: {},
  aggregators: {
    "fixture.collect": (action, children) => ({
      action,
      status: children.every((child) => child.status === "success")
        ? "success"
        : "error",
      summary: children.map((child) => child.summary).join("; "),
      totalItems: children.length,
    }),
  },
};

describe("shared command architecture", () => {
  it("resolves deep aliases, lists arbitrary scopes and validates the same handler input", async () => {
    const registry = createModuleRegistry(
      [
        module([
          command(
            "web.page.content.extract",
            { type: "handler", handler: "fixture.read" },
            ["get", "parse"],
          ),
        ]),
      ],
      handlers,
    );
    expect(registry.resolve("INTERNET.SITE.ARTICLE.GET")).toEqual({
      ok: true,
      id: "web.page.content.extract",
    });
    expect(registry.list("internet.site").children[0].id).toBe(
      "web.page.content",
    );
    expect(registry.list("web.page.content").children[0].kind).toBe("read");
    expect(
      registry.search("internet.site.article.get").matches[0],
    ).toMatchObject({
      id: "web.page.content.extract",
      reasons: ["alias path"],
    });
    expect(
      (
        await registry.invoke(
          "internet.site.article.get",
          { text: "same result" },
          context,
        )
      ).summary,
    ).toBe("same result");
    expect(
      (
        await registry.invoke(
          "internet.site.article.get",
          { approved: true },
          context,
        )
      ).code,
    ).toBe("invalid_args");
  });

  it("rejects missing references, collisions and indirect cycles at compilation", () => {
    expect(() =>
      createModuleRegistry(
        [
          module([
            command("web.read", { type: "handler", handler: "missing.read" }),
          ]),
        ],
        handlers,
      ),
    ).toThrow("Unknown handler");
    expect(() =>
      createModuleRegistry(
        [
          module([
            command("web.read", { type: "handler", handler: "fixture.read" }, [
              "search",
            ]),
            command("web.search", { type: "handler", handler: "fixture.read" }),
          ]),
        ],
        handlers,
      ),
    ).toThrow("collision");
    const composite = (target: string): CommandDefinition["execution"] => ({
      type: "composite",
      steps: [{ id: "first", command: target, args: {} }],
      aggregate: "fixture.collect",
      onFailure: "stop",
    });
    expect(() =>
      createModuleRegistry(
        [
          module([
            command("web.first", composite("web.second")),
            command("web.second", composite("web.first")),
          ]),
        ],
        handlers,
      ),
    ).toThrow("cycle");
  });

  it("dispatches ordered composite children with validated references and failure stopping", async () => {
    const calls: string[] = [];
    const definitions = [
      command("web.read", { type: "handler", handler: "fixture.echo" }),
      command("web.collect", {
        type: "composite",
        onFailure: "stop",
        aggregate: "fixture.collect",
        steps: [
          {
            id: "first",
            command: "web.read",
            args: { text: { from: "input", path: ["text"] } },
          },
          {
            id: "second",
            command: "web.read",
            args: { text: { from: "step", step: "first", path: ["summary"] } },
          },
        ],
      }),
    ];
    const registry = createModuleRegistry([module(definitions)], {
      ...handlers,
      handlers: {
        "fixture.echo": async (args) => {
          calls.push(String(args.text));
          return {
            action: "web.read",
            status: args.text === "fail" ? "error" : "success",
            summary: String(args.text),
          };
        },
      },
    });
    expect(
      (await registry.invoke("web.collect", { text: "bound" }, context))
        .totalItems,
    ).toBe(2);
    expect(calls).toEqual(["bound", "bound"]);
    calls.length = 0;
    expect(
      (await registry.invoke("web.collect", { text: "fail" }, context)).status,
    ).toBe("error");
    expect(calls).toEqual(["fail"]);
  });

  it("uses an actual predefined process with literal Unicode and shell metacharacters", async () => {
    const processBinding = bindTrustedProcess({
      executable: process.execPath,
      args: [
        { literal: "-e" },
        { literal: "process.stdout.write(process.argv[1])" },
        { parameter: "text" },
      ],
      cwd: () => process.cwd(),
      authorizeCwd: (path) => path === process.cwd(),
      timeoutMs: 5000,
      successCodes: [0],
      parse: (outcome) => ({
        action: "web.process",
        status: outcome.code === 0 ? "success" : "error",
        summary: outcome.stdout,
      }),
    });
    const registry = createModuleRegistry(
      [
        module([
          command("web.process", { type: "process", process: "fixture.node" }),
        ]),
      ],
      { ...handlers, processes: { "fixture.node": processBinding } },
    );
    const result = await registry.invoke(
      "web.process",
      { text: 'á space & | $() ` quote"' },
      context,
    );
    expect(result.status).toBe("success");
    expect(result.summary).toBe('á space & | $() ` quote"');
  });
  it("shares the runtime step budget across nested registry invocations", async () => {
    let calls = 0;
    const repeat = command("web.repeat", { type: "composite", aggregate: "fixture.collect", onFailure: "stop",
      steps: Array.from({ length: 32 }, (_, index) => ({ id: `step${index}`, command: "web.read", args: {} })) });
    const root = command("web.root", { type: "composite", aggregate: "fixture.collect", onFailure: "stop",
      steps: Array.from({ length: 4 }, (_, index) => ({ id: `repeat${index}`, command: "web.repeat", args: {} })) });
    const registry = createModuleRegistry([module([root, repeat, command("web.read", { type: "handler", handler: "fixture.count" })])], {
      ...handlers, handlers: { "fixture.count": () => { calls += 1; return { action: "web.read", status: "success", summary: "Read." }; } },
    });
    const result = await registry.invoke("web.root", {}, context);
    expect(result.status).toBe("error"); expect(calls).toBeGreaterThan(64); expect(calls).toBeLessThan(100);
    expect(result.summary).toContain("execution limit reached");
  });

  it("cancels before any handler or process effect", async () => {
    let ran = false;
    const controller = new AbortController();
    controller.abort();
    const registry = createModuleRegistry(
      [
        module([
          command("web.read", { type: "handler", handler: "fixture.cancel" }),
        ]),
      ],
      {
        ...handlers,
        handlers: {
          "fixture.cancel": (): ActionResult => {
            ran = true;
            return {
              action: "web.read",
              status: "success",
              summary: "unexpected",
            };
          },
        },
      },
    );
    expect(
      (
        await registry.invoke(
          "web.read",
          {},
          { ...context, signal: controller.signal },
        )
      ).status,
    ).toBe("cancelled");
    expect(ran).toBe(false);
  });
});
