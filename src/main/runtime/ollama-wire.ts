import { PERMANENT_MODEL_TOOLS } from "../../shared/model-tools";
import type { ContextMessage } from "./context-builder";

export type OllamaWireMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  images?: string[];
  tool_calls?: Array<{
    id: string;
    function: {
      index: number;
      name: string;
      arguments: unknown;
    };
  }>;
};

const toolParameters: Record<
  (typeof PERMANENT_MODEL_TOOLS)[number],
  { description: string; parameters: Record<string, unknown> }
> = {
  "capabilities.list": {
    description:
      "List capability categories, or the children of one category path.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Category id. Omit it to list the root.",
        },
      },
    },
  },
  "capabilities.describe": {
    description: "Describe registered capability ids.",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["ids"],
    },
  },
  "actions.invoke": {
    description: "Invoke one registered action by id.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        args: { type: "object" },
      },
      required: ["name"],
    },
  },
};

export const PERMANENT_OLLAMA_TOOLS = PERMANENT_MODEL_TOOLS.map((name) => ({
  type: "function" as const,
  function: {
    name,
    description: toolParameters[name].description,
    parameters: toolParameters[name].parameters,
  },
}));

export function toOllamaMessages(
  messages: readonly ContextMessage[],
): OllamaWireMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_name: message.toolName,
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call, index) => ({
          id: call.id,
          function: {
            index,
            name: call.name,
            arguments: call.arguments,
          },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}
