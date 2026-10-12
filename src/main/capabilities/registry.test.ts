import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { ActionResult } from "../../shared/action-contract";
import { createProductionRegistry } from "./catalog";
import { platformCapability } from "./environment";
import {
  createRegistry,
  dispatchModelTool,
  MODEL_TOOL_NAMES,
  type ActionContext,
  type Capability,
} from "./registry";

const context: ActionContext = {
  actor: "model",
  threadId: "thread-1",
  turnId: "turn-1",
};

function fixtureRead(): Capability {
  return {
    id: "files.fixture",
    description: "Test-only reader. Not part of the production catalog.",
    kind: "read",
    approval: "none",
    args: z.object({ path: z.string() }).strict(),
    example: { path: "notes:/a.md" },
    execute(): ActionResult {
      return {
        action: "files.fixture",
        status: "success",
        summary: "fixture",
      };
    },
  };
}

describe("capability registry", () => {
  it("lists production categories, platform, and memory actions", () => {
    const registry = createProductionRegistry();
    expect(registry.list().children.map((child) => child.id)).toEqual([
      "ags",
      "environment",
      "files",
      "memory",
      "projects",
      "software",
    ]);
    expect(registry.list("environment").children).toEqual([
      {
        id: "environment.paths",
        description:
          "Well-known folders and registered aliases. Does not list environment variables or secrets.",
        kind: "read",
        syntax: "{}",
      },
      {
        id: "environment.platform",
        description: "Operating system name, version, and architecture.",
        kind: "read",
        syntax: "{}",
      },
    ]);
    expect(registry.list("memory").children.map((child) => child.id)).toEqual([
      "memory.add",
      "memory.get",
      "memory.list",
      "memory.remove",
      "memory.update",
    ]);
    expect(JSON.stringify(registry.list())).not.toContain("files.fixture");
  });

  it("keeps fixture actions off the production catalog", () => {
    const production = createProductionRegistry();
    const withFixture = createRegistry([platformCapability(), fixtureRead()]);
    expect(production.list("files").children.map((child) => child.id)).toEqual([
      "files.batch",
      "files.compare",
      "files.copy",
      "files.create",
      "files.edit",
      "files.hash",
      "files.inspect_image",
      "files.list",
      "files.move",
      "files.next",
      "files.read",
      "files.rename",
      "files.scopes",
      "files.search",
      "files.stat",
      "files.summary",
      "files.trash",
      "files.undo",
    ]);
    expect(withFixture.list("files").children[0]?.id).toBe("files.fixture");
    expect(
      withFixture.invoke("files.fixture", { path: "a" }, context).summary,
    ).toBe("fixture");
  });

  it("describes a contract without the executor and rejects unknown tools", () => {
    const registry = createProductionRegistry();
    const described = registry.describe([
      "environment.platform",
      "files.fixture",
    ]);
    expect(described.entries[0]?.kind).toBe("read");
    expect(described.entries[0]?.approval).toBe("none");
    expect(described.entries[1]).toEqual({
      id: "files.fixture",
      code: "unknown",
    });
    expect(JSON.stringify(described)).not.toContain("execute");
    const unknown = dispatchModelTool(registry, "files.fixture", {}, context);
    expect(unknown.code).toBe("unknown_tool");
    expect(MODEL_TOOL_NAMES).toEqual([
      "capabilities.list",
      "capabilities.describe",
      "actions.invoke",
    ]);
  });

  it("invokes platform facts and rejects bad or unknown actions", () => {
    const registry = createProductionRegistry();
    const listed = dispatchModelTool(
      registry,
      "capabilities.list",
      { path: "environment" },
      context,
    );
    expect(listed.status).toBe("success");
    expect(listed.detail).toContain("environment.platform");
    const invoked = dispatchModelTool(
      registry,
      "actions.invoke",
      { name: "environment.platform", args: {} },
      context,
    );
    expect(invoked.status).toBe("success");
    const facts = JSON.parse(invoked.detail ?? "{}") as {
      platform: string;
      release: string;
      arch: string;
    };
    expect(facts.platform).toBe(process.platform);
    expect(Object.keys(facts).sort()).toEqual(["arch", "platform", "release"]);
    expect(
      dispatchModelTool(
        registry,
        "actions.invoke",
        { name: "environment.platform", args: { approved: true } },
        context,
      ).code,
    ).toBe("invalid_args");
    expect(
      dispatchModelTool(
        registry,
        "actions.invoke",
        { name: "files.fixture", args: {} },
        context,
      ).code,
    ).toBe("unknown_action");
  });

  it("lists the files category inside the detail contract", () => {
    const registry = createProductionRegistry();
    const listed = dispatchModelTool(
      registry,
      "capabilities.list",
      { path: "files" },
      context,
    );
    expect(listed.status).toBe("success");
    expect(listed.detail?.length ?? 0).toBeLessThanOrEqual(4000);
    const body = JSON.parse(listed.detail ?? "{}") as {
      children: Array<{ id: string; description?: string; syntax?: string }>;
    };
    const create = body.children.find((child) => child.id === "files.create");
    expect(create?.description).toContain("Create");
    expect(create?.syntax).toBe(
      '{path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} or {items:[{path, kind:"file"|"directory", content?, format?}]}',
    );
    for (const child of body.children) {
      expect(child.syntax?.length ?? 0).toBeGreaterThan(0);
    }
    expect(
      body.children.find((child) => child.id === "files.list")?.syntax,
    ).toContain("root");
    expect(
      body.children.find((child) => child.id === "files.search")?.syntax,
    ).toContain('mode:"filename"|"content"');
    expect(
      body.children.find((child) => child.id === "files.edit")?.syntax,
    ).toContain('mode:"full"');
    const ids = registry.list("files").children.map((child) => child.id);
    for (let index = 0; index < ids.length; index += 8) {
      const described = dispatchModelTool(
        registry,
        "capabilities.describe",
        { ids: ids.slice(index, index + 8) },
        context,
      );
      expect(described.status).toBe("success");
      expect(described.detail?.length ?? 0).toBeLessThanOrEqual(4000);
      const entries = JSON.parse(described.detail ?? "{}") as {
        entries: Array<{ id: string; syntax?: string }>;
      };
      expect(entries.entries.map((entry) => entry.id)).toEqual(
        ids.slice(index, index + 8),
      );
      for (const entry of entries.entries) {
        expect(entry.syntax?.length ?? 0).toBeGreaterThan(0);
      }
    }
    const one = dispatchModelTool(
      registry,
      "capabilities.describe",
      { ids: ["files.create"] },
      context,
    );
    expect(one.detail).toContain("files.create");
    expect(JSON.parse(one.detail ?? "{}")).toMatchObject({
      entries: [
        {
          id: "files.create",
          kind: "mutation",
          syntax:
            '{path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} or {items:[{path, kind:"file"|"directory", content?, format?}]}',
        },
      ],
    });
    const missed = dispatchModelTool(
      registry,
      "actions.invoke",
      { name: "files.create", args: { path: "test.txt", kind: "text" } },
      context,
    );
    expect(missed.code).toBe("invalid_args");
    expect(missed.summary).toContain('kind:"file"|"directory"');
  });

  it("rejects a model payload that claims approval", () => {
    const registry = createProductionRegistry();
    expect(
      dispatchModelTool(
        registry,
        "actions.invoke",
        { name: "environment.platform", args: {}, approved: true },
        context,
      ).code,
    ).toBe("invalid_args");
  });
});
