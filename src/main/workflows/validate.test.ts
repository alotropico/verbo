import { describe, expect, it } from "vitest";
import { createWorkflowRegistry } from "./registry";
import { validateWorkflow } from "./validate";

describe("workflow structural and dataflow validation", () => {
  it.each([
    "cycle",
    "skipped-producer",
    "uncovered",
    "prototype",
    "type",
    "tool-free-grant",
    "duplicate",
    "version",
    "callback",
  ])("rejects %s before actions", (scenario) => {
    const registry = createWorkflowRegistry();
    const definition = registry.get("obsidian");
    const branch = definition.steps[1]!;
    const write = definition.steps[2]!;
    if (branch.type !== "branch" || write.type !== "agent")
      throw new Error("fixture");
    if (scenario === "cycle") branch.cases[0]!.goto = "operation";
    if (scenario === "skipped-producer") branch.cases[0]!.goto = "save-new";
    if (scenario === "uncovered") branch.cases.pop();
    if (scenario === "prototype")
      write.input.request = { ref: "input.constructor" };
    if (scenario === "type") write.input.request = false;
    if (scenario === "tool-free-grant")
      write.capabilities = { mode: "replace", modules: ["files"] };
    if (scenario === "duplicate") write.id = "route";
    if (scenario === "version") definition.version = 0;
    if (scenario === "callback")
      Object.assign(write, { callback: () => undefined });
    expect(() =>
      validateWorkflow(definition, { schemas: registry.schemas }),
    ).toThrow();
  });
});
