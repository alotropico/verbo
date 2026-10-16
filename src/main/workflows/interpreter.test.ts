import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { interpretWorkflow } from "./interpreter";
import { createWorkflowRegistry } from "./registry";
import { createSchemaRegistry } from "./schemas";
import { validateWorkflow } from "./validate";
import type { WorkflowDefinition } from "./definition";

describe("workflow transitions", () => {
  it.each([
    ["write", ["operation", "write-body", "save-new"]],
    ["edit", ["operation", "read-existing", "edit-body", "save-edit"]],
    ["move", ["operation", "move-note"]],
    ["rename", ["operation", "rename-note"]],
    ["delete", ["operation", "delete-note"]],
  ])(
    "executes only the %s route and ends before the following actions",
    async (choice, expected) => {
      const registry = createWorkflowRegistry();
      const order: string[] = [];
      const settled: string[] = [];
      const final = await interpretWorkflow({
        definition: registry.get("obsidian"),
        schemas: registry.schemas,
        parameters: { request: "Operate", target: "vault" },
        run: async (step, bound) => {
          order.push(step.id);
          if (step.id !== "operation")
            expect(settled.at(-1)).toBe(
              step.id === "write-body" ||
                step.id === "read-existing" ||
                step.id.endsWith("note")
                ? "route"
                : expected[order.length - 2],
            );
          if (step.type === "decide")
            return { status: "succeeded", output: { value: choice } };
          if (step.agentId === "writer")
            return {
              status: "succeeded",
              output: { contentRef: "new-body-ref" },
            };
          if (step.id === "save-edit")
            expect(bound).toMatchObject({
              path: "same.md",
              revision: "original-revision",
              contentRef: "new-body-ref",
            });
          return {
            status: "succeeded",
            output: {
              findings: [],
              receiptIds: [],
              path: "same.md",
              revision: "original-revision",
              contentRef: "source-content",
            },
          };
        },
        settle: (step) => {
          settled.push(step.id);
        },
      });
      expect(order).toEqual(expected);
      expect(final.status).toBe("completed");
    },
  );

  it("cannot fall through into effects after an invalid decision, failed or unsupported step", async () => {
    const registry = createWorkflowRegistry();
    const run = vi.fn(async () => ({
      status: "succeeded" as const,
      output: { value: "unknown" },
    }));
    const final = await interpretWorkflow({
      definition: registry.get("obsidian"),
      schemas: registry.schemas,
      parameters: { request: "unclear", target: null },
      run,
      settle: () => undefined,
    });
    expect(final.status).toBe("failed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reserves referenced workflows explicitly instead of invoking a runner", async () => {
    const registry = createWorkflowRegistry();
    const definition: WorkflowDefinition = {
      id: "parent",
      version: 1,
      description: "Parent",
      routing: "Parent",
      inputSchemaId: "request.v1",
      outputSchemaId: "conversation.v1",
      steps: [
        {
          id: "child",
          type: "workflow",
          workflowId: "conversational",
          version: 1,
          input: { request: { ref: "input.request" } },
          inputSchemaId: "request.v1",
          outputSchemaId: "conversation.v1",
          end: true,
        },
      ],
    };
    const run = vi.fn();
    const validated = validateWorkflow(definition, {
      schemas: registry.schemas,
      workflow: (id, version) => registry.get(id, version),
    });
    const result = await interpretWorkflow({
      definition: validated,
      schemas: registry.schemas,
      parameters: { request: "Hi" },
      run,
      settle: () => undefined,
    });
    expect(result.result).toMatchObject({
      status: "not_supported",
      code: "nested_workflow_reserved",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("allows intentional unmatched finite fallthrough and stops at a pending question", async () => {
    const schemas = createSchemaRegistry({
      "choice.v1": z.object({ value: z.enum(["a", "b"]) }),
    });
    const registry = createWorkflowRegistry();
    const reply = registry.get("conversational").steps[0]!;
    const definition: WorkflowDefinition = {
      ...registry.get("conversational"),
      steps: [
        {
          id: "choice",
          type: "decide",
          choices: ["a", "b"],
          modelProfileId: "decision",
          input: { request: { ref: "input.request" } },
          inputSchemaId: "request.v1",
          outputSchemaId: "choice.v1",
        },
        {
          id: "branch",
          type: "branch",
          value: { ref: "steps.choice.output.value" },
          cases: [{ when: "a", goto: "last" }],
          exhaustive: false,
        },
        { ...reply, id: "fallthrough" },
        { ...reply, id: "last" },
      ],
    };
    validateWorkflow(definition, { schemas });
    const order: string[] = [];
    const result = await interpretWorkflow({
      definition,
      schemas,
      parameters: { request: "Hi" },
      run: async (step) => {
        order.push(step.id);
        if (step.type === "decide")
          return { status: "succeeded", output: { value: "b" } };
        return {
          status: "awaiting_input",
          question: {
            text: "Which?",
            required: true,
            expected: { type: "enum", values: ["a", "b"] },
            binding: "choice",
          },
        };
      },
      settle: () => undefined,
    });
    expect(order).toEqual(["choice", "fallthrough"]);
    expect(result.status).toBe("awaiting_input");
  });
});
