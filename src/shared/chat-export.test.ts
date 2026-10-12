import { describe, expect, it } from "vitest";
import {
  activeBranch,
  chatExportFilename,
  chatExportJson,
  chatExportMarkdown,
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
});
