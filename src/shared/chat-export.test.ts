import { describe, expect, it } from "vitest";
import {
  activeBranch,
  chatExportAdvanced,
  chatExportFilename,
  chatExportJson,
  chatExportMarkdown,
  messageExportJson,
  readExportMessages,
  type ChatExportMessage,
} from "./chat-export";

const messages: ChatExportMessage[] = [
  {
    id: "user",
    parentId: null,
    role: "user",
    content: [{ type: "text", text: "What is a jaguar?" }],
  },
  {
    id: "old",
    parentId: "user",
    role: "assistant",
    content: [{ type: "text", text: "Discarded." }],
  },
  {
    id: "next",
    parentId: "user",
    role: "assistant",
    content: [
      { type: "text", text: "A big cat." },
      {
        type: "tool-call",
        toolName: "files.read",
        result: { summary: "Read notes." },
      },
    ],
  },
];

describe("chat export", () => {
  it("keeps the active branch and leaves sibling edits out", () => {
    expect(activeBranch(messages, "next").map((message) => message.id)).toEqual(
      ["user", "next"],
    );
  });

  it("writes the same branch as JSON and Markdown", () => {
    const chat = {
      id: "thread-notes",
      title: "Field notes",
      headId: "next",
      messages,
    };
    const json = JSON.parse(chatExportJson(chat)) as {
      messages: { id: string }[];
    };
    expect(json.messages.map((message) => message.id)).toEqual([
      "user",
      "next",
    ]);
    const markdown = chatExportMarkdown(chat);
    expect(markdown).toContain("# Field notes");
    expect(markdown).toContain("What is a jaguar?");
    expect(markdown).toContain("A big cat.");
    expect(markdown).toContain("**files.read:** Read notes.");
    expect(markdown).not.toContain("Discarded.");
  });

  it("builds a safe download name", () => {
    expect(chatExportFilename('notes: "a"?', "md")).toBe("notes a.md");
    expect(chatExportFilename("   ", "json")).toBe("chat.json");
  });

  it("keeps tool args, data parts, and metadata in the advanced export", () => {
    const [stored] = readExportMessages([
      {
        parentId: null,
        message: {
          id: "next",
          role: "assistant",
          metadata: { custom: { source: "turn" } },
          composer: { text: "hidden" },
          content: [
            { type: "text", text: "A big cat." },
            {
              type: "tool-call",
              toolName: "files.read",
              args: { path: "notes.md" },
              result: { summary: "Read notes.", files: ["notes.md"] },
              toolUI: () => null,
            },
            { type: "data", name: "workflow-stage", data: { stage: "read" } },
          ],
        },
      },
    ]);
    expect(stored?.metadata).toEqual({ custom: { source: "turn" } });
    expect(stored).not.toHaveProperty("composer");
    expect(JSON.stringify(stored)).not.toContain("toolUI");

    const chat = {
      id: "thread-notes",
      title: "Field notes",
      headId: "next",
      messages: stored ? [stored] : [],
    };
    const advanced = JSON.parse(
      chatExportAdvanced(chat, {
        assistantMessageId: "next",
        threadId: "thread-notes",
        rounds: [{ context: [], request: { model: "qwen" }, response: [] }],
      }),
    ) as {
      messages: { content: { type: string; args?: { path: string } }[] }[];
      interaction: { rounds: { request: { model: string } }[] };
    };
    expect(advanced.messages[0]?.content.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "data",
    ]);
    expect(advanced.messages[0]?.content[1]?.args?.path).toBe("notes.md");
    expect(advanced.interaction.rounds[0]?.request.model).toBe("qwen");
    expect(chatExportMarkdown(chat)).not.toContain("notes.md");
    expect(chatExportMarkdown(chat)).not.toContain("workflow-stage");
  });

  it("attaches the latest interaction only to the matching message", () => {
    const matched = JSON.parse(
      messageExportJson(
        {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          parts: [{ type: "text", text: "Done." }],
        },
        {
          assistantMessageId: "assistant-1",
          rounds: [{ response: ["chunk"] }],
        },
      ),
    ) as { parts?: unknown; interaction?: { rounds: unknown[] } };
    expect(matched.parts).toBeUndefined();
    expect(matched.interaction?.rounds).toHaveLength(1);

    const other = JSON.parse(
      messageExportJson(
        { id: "user-1", role: "user", content: [] },
        { assistantMessageId: "assistant-1", rounds: [] },
      ),
    ) as { interaction?: unknown };
    expect(other.interaction).toBeUndefined();
  });
});
