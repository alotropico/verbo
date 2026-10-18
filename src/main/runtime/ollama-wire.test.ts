import { describe, expect, it } from "vitest";
import { PERMANENT_MODEL_TOOLS } from "../../shared/model-tools";
import {
  PERMANENT_OLLAMA_TOOLS,
  toOllamaMessages,
  withUserImages,
} from "./ollama-wire";

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
    const list = PERMANENT_OLLAMA_TOOLS.find(
      (tool) => tool.function.name === "capabilities.list",
    );
    expect(list?.function.description).toContain("command definitions");
    expect(list?.function.parameters).toMatchObject({
      properties: {
        category: {
          description:
            'Command category id, such as "files". Not a filesystem path.',
        },
      },
    });
    expect(JSON.stringify(list?.function.parameters)).not.toContain('"path"');
  });

  it("attaches images to the latest user message", () => {
    const wire = withUserImages(
      [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "see this" },
      ],
      ["abc"],
    );
    expect(wire[0]?.images).toBeUndefined();
    expect(wire[2]?.images).toEqual(["abc"]);
    expect(
      withUserImages([{ role: "user", content: "see this" }], [])[0]?.images,
    ).toBeUndefined();
  });
});
