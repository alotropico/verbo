import type { WorkflowDefinition } from "../definition";

export const commanderWorkflow = {
  id: "commander",
  version: 1,
  description: "Execute registered commands with permissions and receipts.",
  routing:
    "Generic file, project, software, web and system requests requiring registered actions; explicit Obsidian note operations use obsidian.",
  inputSchemaId: "request.v1",
  outputSchemaId: "commander.output.v1",
  steps: [
    {
      id: "operate",
      type: "agent",
      agentId: "commander",
      modelProfileId: "commander",
      input: {
        request: { ref: "input.request" },
        target: { ref: "input.target" },
      },
      inputSchemaId: "commander.input.v1",
      outputSchemaId: "commander.output.v1",
      end: true,
    },
  ],
} satisfies WorkflowDefinition;
