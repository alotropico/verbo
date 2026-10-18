import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { ActionResult } from "../../shared/action-contract";
import type { MemoryStore } from "../db/memory";
import { executeLocalCommand } from "../runtime/local-command";
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
  it("ranks exact IDs and aliases above description matches without changing execution resolution", () => {
    const registry = createProductionRegistry();
    expect(registry.search("files.read").matches[0].id).toBe("files.read");
    expect(registry.search("fs.cat").matches[0]).toMatchObject({
      id: "files.read",
      reasons: ["alias path"],
    });
    expect(
      registry
        .search("read text")
        .matches.some((match) => match.id === "files.read"),
    ).toBe(true);
    expect(registry.resolve("read text").ok).toBe(false);
  });
  it("lists production categories, platform, and memory actions", () => {
    const registry = createProductionRegistry();
    expect(registry.list().children.map((child) => child.id)).toEqual([
      "ags",
      "environment",
      "files",
      "memory",
      "obsidian",
      "projects",
      "software",
      "web",
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

  it("keeps fixture actions off the production catalog", async () => {
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
      (await withFixture.invoke("files.fixture", { path: "a" }, context))
        .summary,
    ).toBe("fixture");
  });

  it("describes a contract without the executor and rejects unknown tools", async () => {
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
    const unknown = await dispatchModelTool(
      registry,
      "files.fixture",
      {},
      context,
    );
    expect(unknown.code).toBe("unknown_tool");
    expect(MODEL_TOOL_NAMES).toEqual([
      "capabilities.list",
      "capabilities.search",
      "capabilities.describe",
      "actions.invoke",
    ]);
  });

  it("invokes platform facts and rejects bad or unknown actions", async () => {
    const registry = createProductionRegistry();
    const listed = await dispatchModelTool(
      registry,
      "capabilities.list",
      { category: "environment" },
      context,
    );
    expect(listed.status).toBe("success");
    expect(listed.summary).toContain(
      "Listed command definitions in category 'environment'",
    );
    expect(listed.detail).toContain("environment.platform");
    const legacy = await dispatchModelTool(
      registry,
      "capabilities.list",
      { path: "environment" },
      context,
    );
    expect(legacy.status).toBe("success");
    expect(JSON.parse(legacy.detail ?? "{}")).toMatchObject({
      category: "environment",
    });
    const invoked = await dispatchModelTool(
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
      (
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "environment.platform", args: { approved: true } },
          context,
        )
      ).code,
    ).toBe("invalid_args");
    const nulledList = await dispatchModelTool(
      registry,
      "actions.invoke",
      {
        name: "files.list",
        args: {
          root: "desktop:",
          path: null,
          name: null,
          glob: null,
          extensions: null,
          minSize: null,
          maxSize: null,
          modifiedAfter: null,
          modifiedBefore: null,
          cursor: null,
        },
      },
      context,
    );
    expect(nulledList.code).toBe("unavailable");
    expect(
      (
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "files.list", args: { root: null } },
          context,
        )
      ).code,
    ).toBe("invalid_args");
    expect(
      (
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "files.fixture", args: {} },
          context,
        )
      ).code,
    ).toBe("unknown_action");
  });

  it("lists the files category inside the detail contract", async () => {
    const registry = createProductionRegistry();
    const listed = await dispatchModelTool(
      registry,
      "capabilities.list",
      { category: "files" },
      context,
    );
    expect(listed.status).toBe("success");
    expect(listed.summary).toBe(
      "Listed command definitions in category 'files'. Syntax is complete. Descriptions were shortened or omitted.",
    );
    expect(listed.detail?.length ?? 0).toBeLessThanOrEqual(4000);
    const body = JSON.parse(listed.detail ?? "{}") as {
      category?: string;
      children: Array<{ id: string; description?: string; syntax?: string }>;
    };
    expect(body.category).toBe("files");
    expect(body).not.toHaveProperty("path");
    const create = body.children.find((child) => child.id === "files.create");
    expect(
      registry.describe(["files.create"]).entries[0]?.description,
    ).toContain("Create");
    expect(create?.syntax).toBe(
      '{path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} or {items:[{path, kind:"file"|"directory", content?, format?}]}',
    );
    for (const child of body.children) {
      expect(child.syntax?.length ?? 0).toBeGreaterThan(0);
    }
    const listCommand = body.children.find(
      (child) => child.id === "files.list",
    );
    expect(Object.keys(listCommand ?? {}).slice(0, 3)).toEqual([
      "id",
      "kind",
      "syntax",
    ]);
    if (listCommand?.description) {
      expect(listCommand.description).toContain(
        "Query page, not a mutation source",
      );
    }
    expect(listCommand?.syntax).toContain("root");
    expect(registry.describe(["files.list"]).entries[0]?.description).toContain(
      "Query page, not a mutation source",
    );
    const move = body.children.find((child) => child.id === "files.move");
    expect(move?.syntax?.startsWith("{in, toDirectory")).toBe(true);
    if (move?.description) {
      expect(move.description.startsWith("Move. Widest:")).toBe(true);
    }
    expect(registry.describe(["files.move"]).entries[0]?.description).toMatch(
      /^Move\. Widest:/,
    );
    expect(
      body.children.find((child) => child.id === "files.search")?.syntax,
    ).toContain('mode:"filename"|"content"');
    expect(
      body.children.find((child) => child.id === "files.edit")?.syntax,
    ).toContain('mode:"full"');
    const ids = registry.list("files").children.map((child) => child.id);
    for (let index = 0; index < ids.length; index += 8) {
      const described = await dispatchModelTool(
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
    const one = await dispatchModelTool(
      registry,
      "capabilities.describe",
      { ids: ["files.create"] },
      context,
    );
    expect(one.detail).toContain("files.create");
    const created = JSON.parse(one.detail ?? "{}") as {
      entries: Array<Record<string, unknown>>;
    };
    expect(Object.keys(created.entries[0] ?? {})).toEqual([
      "id",
      "kind",
      "approval",
      "syntax",
      "example",
      "description",
      "args",
    ]);
    expect(created).toMatchObject({
      entries: [
        {
          id: "files.create",
          kind: "mutation",
          syntax:
            '{path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} or {items:[{path, kind:"file"|"directory", content?, format?}]}',
        },
      ],
    });
    const missed = await dispatchModelTool(
      registry,
      "actions.invoke",
      { name: "files.create", args: { path: "test.txt", kind: "text" } },
      context,
    );
    expect(missed.code).toBe("invalid_args");
    expect(missed.summary).toContain('kind:"file"|"directory"');
  });

  it("searches every command and alias in one call", async () => {
    const registry = createProductionRegistry();
    const moved = await dispatchModelTool(
      registry,
      "capabilities.search",
      { query: "move" },
      context,
    );
    expect(moved.status).toBe("success");
    const moveBody = JSON.parse(moved.detail ?? "{}") as {
      matches: Array<{ id: string }>;
    };
    expect(moveBody.matches.map((match) => match.id)).toContain("files.move");
    const flatten = await dispatchModelTool(
      registry,
      "capabilities.search",
      { query: "move files nested within subfolders to root" },
      context,
    );
    const flattenBody = JSON.parse(flatten.detail ?? "{}") as {
      matches: Array<{ id: string; example?: { in?: string } }>;
    };
    expect(flattenBody.matches[0]?.id).toBe("files.move");
    expect(flattenBody.matches[0]?.example).toEqual({
      in: "tmp:/agent-files",
      toDirectory: "tmp:/agent-files",
    });
    const grep = await dispatchModelTool(
      registry,
      "capabilities.search",
      { query: "grep" },
      context,
    );
    const grepBody = JSON.parse(grep.detail ?? "{}") as {
      matches: Array<{ id: string; aliases?: string[] }>;
    };
    expect(
      grepBody.matches.find((match) => match.id === "files.search")?.aliases,
    ).toContain("/files grep");
    expect(
      (
        await dispatchModelTool(
          registry,
          "capabilities.search",
          { query: "zzzzqq" },
          context,
        )
      ).summary,
    ).toBe("No commands match zzzzqq.");
    expect(
      (await dispatchModelTool(registry, "capabilities.search", {}, context))
        .code,
    ).toBe("invalid_args");
    const unused = (): never => {
      throw new Error("unused");
    };
    const store: MemoryStore = {
      budget: 0,
      list: unused,
      get: unused,
      add: unused,
      update: unused,
      remove: unused,
      snapshot: unused,
      usage: unused,
      recentChanges: unused,
    };
    expect(
      (
        await executeLocalCommand({
          text: "/search remember",
          store,
          registry,
        })
      ).summary,
    ).toContain("memory.add");
  });

  it("rejects a folder path as a command category without prescribing invoke", async () => {
    const registry = createProductionRegistry();
    const folder = "C:\\Users\\Leandro\\Desktop\\agent-files";
    const listed = await dispatchModelTool(
      registry,
      "capabilities.list",
      { category: folder },
      context,
    );
    expect(listed.status).toBe("error");
    expect(listed.code).toBe("unknown_category");
    expect(listed.summary).toBe(
      `No command category named ${folder}. category lists command definitions, such as "files". It is not a folder.`,
    );
    expect(listed.summary).not.toContain("actions.invoke");
    expect(JSON.parse(listed.detail ?? "{}")).toMatchObject({
      category: folder,
    });
    const legacy = await dispatchModelTool(
      registry,
      "capabilities.list",
      { path: "tmp:/Users/Leandro/Desktop/agent-files" },
      context,
    );
    expect(legacy.code).toBe("unknown_category");
    expect(legacy.summary).toContain("It is not a folder.");
    const unknown = await dispatchModelTool(
      registry,
      "capabilities.list",
      { category: "widgets" },
      context,
    );
    expect(unknown.summary).toBe(
      'No command category named widgets. category is a command-category id such as "files". Omit it to list root categories.',
    );
    expect(unknown.summary).not.toContain("actions.invoke");
    const root = await dispatchModelTool(
      registry,
      "capabilities.list",
      {},
      context,
    );
    expect(root.summary.startsWith("Listed root command categories.")).toBe(
      true,
    );
  });

  it("rejects a model payload that claims approval", async () => {
    const registry = createProductionRegistry();
    expect(
      (
        await dispatchModelTool(
          registry,
          "actions.invoke",
          { name: "environment.platform", args: {}, approved: true },
          context,
        )
      ).code,
    ).toBe("invalid_args");
  });
});
