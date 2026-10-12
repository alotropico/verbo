import { describe, expect, it } from "vitest";
import { touchedFilesFromItems, touchedFilesFromParts } from "./touched-files";

function result(input: {
  action: string;
  status: string;
  items: unknown[];
  detailsAvailable?: boolean;
}): string {
  return JSON.stringify({
    action: input.action,
    status: input.status,
    summary: "done",
    operationId: "op-1",
    detail: JSON.stringify({
      operationId: "op-1",
      threadId: "thread-1",
      items: input.items,
    }),
    ...(input.detailsAvailable ? { detailsAvailable: true } : {}),
  });
}

describe("touched files", () => {
  it("keeps succeeded creates, edits, moves, and renames", () => {
    const files = touchedFilesFromItems([
      { kind: "create_file", to: "notes:/a.md", status: "succeeded" },
      { kind: "create_directory", to: "notes:/dir", status: "succeeded" },
      { kind: "edit", from: "notes:/b.md", status: "succeeded" },
      {
        kind: "move",
        from: "notes:/c.md",
        to: "notes:/moved/c.md",
        status: "succeeded",
      },
      {
        kind: "rename",
        from: "notes:/d.md",
        to: "notes:/e.md",
        status: "succeeded",
      },
      { kind: "copy", to: "notes:/copy.md", status: "succeeded" },
      { kind: "trash", from: "notes:/gone.md", status: "succeeded" },
      { kind: "create_file", to: "notes:/failed.md", status: "failed" },
      { kind: "create_file", to: "notes:/a.md", status: "succeeded" },
    ]);
    expect(files).toEqual([
      { path: "notes:/a.md", name: "a.md" },
      { path: "notes:/b.md", name: "b.md" },
      { path: "notes:/moved/c.md", name: "c.md" },
      { path: "notes:/e.md", name: "e.md" },
    ]);
  });

  it("reads file chips from successful tool results", () => {
    const scan = touchedFilesFromParts([
      { type: "text", text: "Done" },
      {
        type: "tool-call",
        result: result({
          action: "files.create",
          status: "success",
          items: [
            { kind: "create_file", to: "notes:/a.md", status: "succeeded" },
          ],
        }),
      },
      {
        type: "tool-call",
        result: result({
          action: "files.edit",
          status: "requires_confirmation",
          items: [{ kind: "edit", from: "notes:/a.md", status: "succeeded" }],
        }),
      },
      {
        type: "tool-call",
        result: result({
          action: "files.move",
          status: "partial",
          items: [
            {
              kind: "move",
              to: "notes:/box/a.md",
              status: "succeeded",
            },
          ],
          detailsAvailable: true,
        }),
      },
    ]);
    expect(scan.files.map((file) => file.path)).toEqual([
      "notes:/a.md",
      "notes:/box/a.md",
    ]);
    expect(scan.reviews).toEqual([
      { operationId: "op-1", threadId: "thread-1" },
    ]);
  });
});
