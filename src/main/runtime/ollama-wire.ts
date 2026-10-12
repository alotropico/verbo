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
  "capabilities.search": {
    description:
      "Search every command and alias for one string. Returns matching action ids, syntax, and aliases. Use this instead of listing each category to find a name.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Text to find in command ids, descriptions, syntax, and aliases.",
        },
      },
      required: ["query"],
    },
  },
  "capabilities.list": {
    description:
      "List capability categories, or the actions in one category. Each action includes syntax with required fields and allowed values.",
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
    description:
      "Describe registered capability ids. Each entry includes syntax and an example. Match syntax when invoking.",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["ids"],
    },
  },
  "actions.invoke": {
    description:
      "Invoke one registered action by id. args must match the syntax from list or describe.",
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

/** Attach capped image bytes to the latest user message. Ollama wants raw base64. */
export function withUserImages(
  messages: readonly OllamaWireMessage[],
  images: readonly string[],
): OllamaWireMessage[] {
  if (images.length === 0) return [...messages];
  let index = -1;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.role === "user") {
      index = cursor;
      break;
    }
  }
  if (index < 0) return [...messages];
  const target = messages[index];
  if (!target) return [...messages];
  const next = [...messages];
  next[index] = { ...target, images: [...images] };
  return next;
}
