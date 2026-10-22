import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aloCall } from "../alo/client";
import { createProductionRegistry } from "../capabilities/catalog";
import { dispatchModelTool } from "../capabilities/registry";
import { commandContextSource } from "./command-context";
import { resolveCTS } from "./cts";

describe("command awareness", () => {
  it("exposes every installed module and project discovery to both agents without granting conversation tools", async () => {
    const profile = process.env.VERBO_ALO_PROFILE;
    if (!profile) throw new Error("An isolated Alo test profile is required.");
    for (const alias of ["first-project", "second-project"]) {
      const path = join(dirname(profile), alias);
      mkdirSync(path);
      writeFileSync(join(path, "package.json"), JSON.stringify({ name: alias, description: "Registered test project" }));
      expect(
        await aloCall({
          method: "settings.projects.add",
          args: { alias, path },
          context: { actor: "ui", threadId: "fixture" },
        }),
      ).toMatchObject({ ok: true });
    }
    const registry = createProductionRegistry();
    const nodes = await registry.nodes();
    const modules = nodes.filter((node) => !node.id.includes("."));
    const source = commandContextSource(nodes);
    for (const agentId of ["conversational", "commander"] as const) {
      const cts = resolveCTS({
        invocationId: agentId,
        agentId,
        ceiling: { modules: modules.map((node) => node.id), actions: [] },
        sources: [source],
      });
      expect(cts.sourceIds).toContain("commands");
      for (const module of modules) {
        expect(cts.instructions).toContain(`- ${module.id}: ${module.description}`);
        if (agentId === "commander") expect(cts.policy.allowed.modules).toContain(module.id);
      }
      expect(cts.instructions).toContain("projects.list");
      expect(cts.instructions).toContain("separate from workspace folder scopes");
      if (agentId === "conversational") {
        expect(cts.policy.allowed.modules).toEqual([]);
        expect(cts.policy.exposed).toBe(false);
      } else {
        const context = { actor: "model" as const, threadId: "fixture", invocation: cts.policy };
        const discovered = await dispatchModelTool(registry, "capabilities.search", { query: "projects" }, context);
        expect(discovered.status).toBe("success");
        expect(discovered.detail).toContain("projects.list");
        const listed = await dispatchModelTool(registry, "actions.invoke", { name: "projects.list", args: {} }, context);
        expect(listed).toMatchObject({
          action: "projects.list",
          status: "success",
        });
        expect(listed.detail).toContain("first-project");
        expect(listed.detail).toContain("second-project");
      }
    }
  });
});
