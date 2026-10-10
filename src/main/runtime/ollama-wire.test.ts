import { describe, expect, it } from "vitest";
import { PERMANENT_MODEL_TOOLS } from "../../shared/model-tools";
import { PERMANENT_OLLAMA_TOOLS, toOllamaMessages } from "./ollama-wire";

describe("Ollama wire messages", () => {
  it("keeps assistant tool calls ahead of their tool results", () => {
    const wire = toOllamaMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "capabilities.list",
            arguments: { path: "environment" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "capabilities.list",
        content: '{"action":"capabilities.list"}',
      },
    ]);
    expect(wire[0]?.tool_calls?.[0]?.function).toMatchObject({
      index: 0,
      name: "capabilities.list",
      arguments: { path: "environment" },
    });
    expect(wire[1]).toEqual({
      role: "tool",
      tool_name: "capabilities.list",
      content: '{"action":"capabilities.list"}',
    });
    expect(PERMANENT_OLLAMA_TOOLS.map((tool) => tool.function.name)).toEqual([
      ...PERMANENT_MODEL_TOOLS,
    ]);
  });
});
