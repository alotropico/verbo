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

  it("exports only visible message text while full data retains other parts", () => {
    const chat = {
      id: "thread",
      title: "Transcript",
      headId: "tool",
      messages: [
        {
          id: "system",
          parentId: null,
          role: "system",
          content: "SYSTEM_ONLY",
        },
        { id: "user", parentId: "system", role: "user", content: "User text" },
        {
          id: "assistant",
          parentId: "user",
          role: "assistant",
          metadata: { custom: "FULL_ONLY" },
          content: [
            { type: "text", text: "Answer text" },
            { type: "reasoning", text: "REASONING_ONLY" },
            {
              type: "tool-call",
              toolName: "files.read",
              result: { summary: "TOOL_ONLY" },
            },
            { type: "image", filename: "IMAGE_ONLY.png" },
            { type: "file", filename: "FILE_ONLY.pdf" },
            { type: "data", name: "DATA_ONLY" },
          ],
        },
        {
          id: "tool",
          parentId: "assistant",
          role: "tool",
          content: "TOOL_MESSAGE_ONLY",
        },
        {
          id: "sibling",
          parentId: "user",
          role: "assistant",
          content: "SIBLING_ONLY",
        },
      ],
    };
    const text = chatExportMarkdown(chat, { textOnly: true });
    expect(text).toBe(
      "# Transcript\n\n## User\n\nUser text\n\n## Assistant\n\nAnswer text\n",
    );
    const full = chatExportAdvanced(chat);
    for (const marker of [
      "SYSTEM_ONLY",
      "FULL_ONLY",
      "REASONING_ONLY",
      "TOOL_ONLY",
      "IMAGE_ONLY",
      "FILE_ONLY",
      "DATA_ONLY",
      "TOOL_MESSAGE_ONLY",
    ]) {
      expect(text).not.toContain(marker);
      expect(full).toContain(marker);
    }
    expect(full).not.toContain("SIBLING_ONLY");
  });

  it("keeps the full user text in an advanced message export", () => {
    const text = [
      "Move the example file into the destination folder.",
      "Fourth line exists only to prove the collapsed text is not the clipboard.",
    ].join("\n");
    const exported = messageExportJson({
      id: "user-1",
      role: "user",
      content: [{ type: "text", text }],
    });
    expect(exported).toContain("Fourth line exists only to prove");
    expect(exported.trim().startsWith("{")).toBe(true);
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
