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
    id: "files.read",
    description: "Test-only reader. Not part of the production catalog.",
    kind: "read",
    approval: "none",
    args: z.object({ path: z.string() }).strict(),
    example: { path: "notes:/a.md" },
    execute(): ActionResult {
      return {
        action: "files.read",
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
      "environment",
      "files",
      "memory",
    ]);
    expect(registry.list("environment").children).toEqual([
      {
        id: "environment.platform",
        description: "Operating system name, version, and architecture.",
        kind: "read",
      },
    ]);
    expect(registry.list("memory").children.map((child) => child.id)).toEqual([
      "memory.add",
      "memory.get",
      "memory.list",
      "memory.remove",
      "memory.update",
    ]);
    expect(JSON.stringify(registry.list())).not.toContain("files.read");
  });

  it("keeps fixture actions off the production catalog", () => {
    const production = createProductionRegistry();
    const withFixture = createRegistry([platformCapability(), fixtureRead()]);
    expect(production.list("files").children.map((child) => child.id)).toEqual([
      "files.list",
      "files.scopes",
      "files.search",
      "files.stat",
      "files.summary",
    ]);
    expect(withFixture.list("files").children[0]?.id).toBe("files.read");
    expect(
      withFixture.invoke("files.read", { path: "a" }, context).summary,
    ).toBe("fixture");
  });

  it("describes a contract without the executor and rejects unknown tools", () => {
    const registry = createProductionRegistry();
    const described = registry.describe(["environment.platform", "files.read"]);
    expect(described.entries[0]?.kind).toBe("read");
    expect(described.entries[0]?.approval).toBe("none");
    expect(described.entries[1]).toEqual({ id: "files.read", code: "unknown" });
    expect(JSON.stringify(described)).not.toContain("execute");
    const unknown = dispatchModelTool(registry, "files.read", {}, context);
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
        { name: "files.read", args: {} },
        context,
      ).code,
    ).toBe("unknown_action");
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
