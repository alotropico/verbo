import type { WorkflowDefinition } from "../definition";

const request = { ref: "input.request" };
const target = { ref: "input.target" };
export const OBSIDIAN_OPERATION_INSTRUCTIONS = `Classify the requested operation only. Selecting a value executes nothing and needs no note path or permission confirmation.
Create/new/save a note -> {"kind":"selected","value":"write"}
Rewrite/revise/change an existing note body -> {"kind":"selected","value":"edit"}
Move a note to another folder -> {"kind":"selected","value":"move"}
Rename a note -> {"kind":"selected","value":"rename"}
Delete/remove/trash a note -> {"kind":"selected","value":"delete"}
Explain or discuss Obsidian without an operation -> {"kind":"cannot_classify","question":"Which note operation do you want?"}
Missing note identity/content is handled by the selected operational step, not this classification. Return the selected operation even if those parameters are missing.`;
export const obsidianWorkflow: WorkflowDefinition = {
  id: "obsidian",
  version: 1,
  description:
    "Create, edit, move, rename or delete notes in an explicitly resolved Obsidian vault.",
  routing:
    "Operational requests about Obsidian notes or folders configured as vaults. Choose a named vault, the sole vault, or clarify among several. Never use a generic default for a vault request.",
  inputSchemaId: "request.v1",
  outputSchemaId: "commander.output.v1",
  steps: [
    {
      id: "operation",
      type: "decide",
      modelProfileId: "decision",
      choices: ["write", "edit", "move", "rename", "delete"],
      context: { instructions: OBSIDIAN_OPERATION_INSTRUCTIONS },
      input: { request, target },
      inputSchemaId: "request.v1",
      outputSchemaId: "obsidian.operation.v1",
    },
    {
      id: "route",
      type: "branch",
      value: { ref: "steps.operation.output.value" },
      exhaustive: true,
      cases: [
        { when: "write", goto: "write-body" },
        { when: "edit", goto: "read-existing" },
        { when: "move", goto: "move-note" },
        { when: "rename", goto: "rename-note" },
        { when: "delete", goto: "delete-note" },
      ],
    },
    {
      id: "write-body",
      type: "agent",
      agentId: "writer",
      modelProfileId: "writer",
      input: { request, target },
      inputSchemaId: "writer.input.v1",
      outputSchemaId: "writer.output.v1",
    },
    {
      id: "save-new",
      type: "agent",
      agentId: "commander",
      modelProfileId: "commander",
      input: {
        request,
        target,
        contentRef: { ref: "steps.write-body.output.contentRef" },
        operation: "write",
      },
      inputSchemaId: "commander.input.v1",
      outputSchemaId: "commander.output.v1",
      capabilities: {
        mode: "replace",
        actions: ["obsidian.create", "obsidian.read", "obsidian.help"],
      },
      end: true,
    },
    {
      id: "read-existing",
      type: "agent",
      agentId: "commander",
      modelProfileId: "commander",
      context: {
        instructions:
          "This step only reads the exact original note. After a successful read, return receiptIds without a question. Writer receives the retained body through contentRef in the next step; do not ask the user to provide text already retained by a successful read. Do not edit in this step.",
      },
      input: { request, target, operation: "read" },
      inputSchemaId: "commander.input.v1",
      outputSchemaId: "commander.output.v1",
      capabilities: {
        mode: "replace",
        actions: ["obsidian.read", "obsidian.help"],
      },
    },
    {
      id: "edit-body",
      type: "agent",
      agentId: "writer",
      modelProfileId: "writer",
      input: {
        request,
        target,
        sourceRef: { ref: "steps.read-existing.output.contentRef" },
        revision: { ref: "steps.read-existing.output.revision" },
        path: { ref: "steps.read-existing.output.path" },
      },
      inputSchemaId: "writer.input.v1",
      outputSchemaId: "writer.output.v1",
    },
    {
      id: "save-edit",
      type: "agent",
      agentId: "commander",
      modelProfileId: "commander",
      input: {
        request,
        target,
        operation: "edit",
        contentRef: { ref: "steps.edit-body.output.contentRef" },
        revision: { ref: "steps.read-existing.output.revision" },
        path: { ref: "steps.read-existing.output.path" },
      },
      inputSchemaId: "commander.input.v1",
      outputSchemaId: "commander.output.v1",
      capabilities: {
        mode: "replace",
        actions: ["obsidian.edit", "obsidian.read", "obsidian.help"],
      },
      end: true,
    },
    {
      id: "move-note",
      type: "agent",
      agentId: "commander",
      modelProfileId: "commander",
      input: { request, target, operation: "move" },
      inputSchemaId: "commander.input.v1",
      outputSchemaId: "commander.output.v1",
      capabilities: {
        mode: "replace",
        actions: ["obsidian.move", "obsidian.read", "obsidian.help"],
      },
      end: true,
    },
    {
      id: "rename-note",
      type: "agent",
      agentId: "commander",
      modelProfileId: "commander",
      input: { request, target, operation: "rename" },
      inputSchemaId: "commander.input.v1",
      outputSchemaId: "commander.output.v1",
      capabilities: {
        mode: "replace",
        actions: ["obsidian.rename", "obsidian.read", "obsidian.help"],
      },
      end: true,
    },
    {
      id: "delete-note",
      type: "agent",
      agentId: "commander",
      modelProfileId: "commander",
      input: { request, target, operation: "delete" },
      inputSchemaId: "commander.input.v1",
      outputSchemaId: "commander.output.v1",
      capabilities: {
        mode: "replace",
        actions: ["obsidian.delete", "obsidian.read", "obsidian.help"],
      },
      end: true,
    },
  ],
} satisfies WorkflowDefinition;
