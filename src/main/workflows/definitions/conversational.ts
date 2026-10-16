import type { WorkflowDefinition } from "../definition";

export const conversationalWorkflow = {
  id: "conversational",
  version: 1,
  description: "Direct conversation and explanations without external actions.",
  routing:
    "Questions, discussion, explanation, brainstorming and standalone prose. A mention of an app alone is not a request to operate it.",
  inputSchemaId: "request.v1",
  outputSchemaId: "conversation.v1",
  steps: [
    {
      id: "reply",
      type: "agent",
      agentId: "conversational",
      modelProfileId: "conversational",
      input: { request: { ref: "input.request" } },
      inputSchemaId: "request.v1",
      outputSchemaId: "conversation.v1",
      end: true,
    },
  ],
} satisfies WorkflowDefinition;
