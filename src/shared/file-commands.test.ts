import { describe, expect, it } from "vitest";
import { parseLocalCommand } from "./local-commands";
import { parseActionCommand, parseFilesCommand } from "./file-commands";

describe("file commands", () => {
  it("parses quoted Windows paths and file aliases", () => {
    expect(
      parseFilesCommand('list "D:\\cosmos\\projects\\notes" --depth 0 --type directories --sort name --page-size 50'),
    ).toEqual({
      ok: true,
      call: {
        actionId: "files.list",
        args: {
          root: "D:\\cosmos\\projects\\notes",
          depth: 0,
          entryType: "directories",
          sort: { by: "name", direction: "asc" },
          pageSize: 50,
        },
      },
    });
    const read = parseFilesCommand("read notes:/Inbox/idea.md --lines 1:100");
    expect(read.ok && read.call).toEqual({
      actionId: "files.read",
      args: { path: "notes:/Inbox/idea.md", startLine: 1, lineCount: 100 },
    });
    const grep = parseFilesCommand('grep notes:/ --text "individuation" --ext md,.txt');
    expect(grep.ok && grep.call).toMatchObject({
      actionId: "files.search",
      args: {
        root: "notes:/",
        mode: "content",
        query: "individuation",
        extensions: ["md", "txt"],
      },
    });
  });

  it("rejects approval, bad JSON, and unknown flags", () => {
    const approve = parseActionCommand("approve {}");
    const forged = parseActionCommand('files.read {"approved":true}');
    const broken = parseActionCommand("files.read {");
    const flagged = parseFilesCommand("list notes:/ --shell dir");
    expect(approve.ok).toBe(false);
    expect(forged.ok).toBe(false);
    expect(broken.ok).toBe(false);
    expect(flagged.ok).toBe(false);
    if (!approve.ok) expect(approve.summary).toBe("Approval is not a command.");
    if (!forged.ok) expect(forged.summary).toBe("Approval is not a command.");
    if (!broken.ok) expect(broken.summary).toBe("Those arguments are not valid JSON.");
    if (!flagged.ok) expect(flagged.summary).toContain("Unknown flag");
    expect(parseFilesCommand('read "notes:/My Notes.md')).toMatchObject({
      ok: false,
    });
    expect(parseLocalCommand("/action approve {}")).toMatchObject({
      name: "malformed",
    });
    expect(parseLocalCommand("please /files list notes:/")).toEqual({
      handled: false,
    });
  });
});
