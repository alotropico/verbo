import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../shared/action-contract";
import {
  filesBatchArgsSchema,
  filesCreateArgsSchema,
  filesEditArgsSchema,
  filesTrashArgsSchema,
  filesTransferArgsSchema,
  filesUndoArgsSchema,
} from "../../shared/file-mutation";
import type { ScopeStore } from "../db/scopes";
import {
  submitFileMutation,
  type MutationSubmit,
} from "../files/mutation-plan";
import type { Capability } from "./registry";

function failure(action: string, summary: string): ActionResult {
  return { action, status: "error", code: "unavailable", summary };
}

export function fileMutationCapabilities(
  resolveScopes: () => ScopeStore,
  resolveDatabase: () => DatabaseSync,
): Capability[] {
  function open(
    action: string,
    context: {
      actor: MutationSubmit["actor"];
      threadId: string;
      turnId?: string;
    },
  ): Omit<MutationSubmit, "action" | "args"> | ActionResult {
    try {
      return {
        database: resolveDatabase(),
        scopes: resolveScopes(),
        actor: context.actor,
        threadId: context.threadId,
        ...(context.turnId ? { turnId: context.turnId } : {}),
      };
    } catch {
      return failure(action, "File changes are not configured.");
    }
  }

  return [
    {
      id: "files.create",
      description:
        "Create a file or folder. A bare filename is saved in the default folder (.tmp). One collision-free item runs immediately and returns a receipt. Two or more items need confirmation. Existing paths are never overwritten.",
      kind: "mutation",
      approval: "none",
      args: filesCreateArgsSchema,
      syntax:
        '{path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} or {items:[{path, kind:"file"|"directory", content?, format?}]}',
      example: { path: "note.md", kind: "file", content: "# Note\n" },
      execute(args, context): ActionResult {
        const opened = open("files.create", context);
        if ("status" in opened) return opened;
        return submitFileMutation({
          ...opened,
          action: "files.create",
          args: filesCreateArgsSchema.parse(args),
        });
      },
    },
    {
      id: "files.edit",
      description:
        "Edit one existing UTF-8 file. Always previews a diff and waits for confirmation. mode is full, replace (find, replace, expectedMatches), or lines (startLine, endLine, content). JSON files must stay valid JSON.",
      kind: "mutation",
      approval: "required",
      args: filesEditArgsSchema,
      syntax:
        '{path, mode:"full", content, format?:"text"|"json"|"markdown"} or {path, mode:"replace", find, replace, expectedMatches, format?:"text"|"json"|"markdown"} or {path, mode:"lines", content, startLine, endLine, format?:"text"|"json"|"markdown"}',
      example: {
        path: "tmp:/note.md",
        mode: "replace",
        find: "draft",
        replace: "final",
        expectedMatches: 1,
      },
      execute(args, context): ActionResult {
        const opened = open("files.edit", context);
        if ("status" in opened) return opened;
        return submitFileMutation({
          ...opened,
          action: "files.edit",
          args: filesEditArgsSchema.parse(args),
        });
      },
    },
    {
      id: "files.copy",
      description:
        "Copy a file or folder into a writable alias. The source may be read-only. One collision-free copy runs immediately. Multiple copies, or a resultSet, wait for confirmation. No silent overwrite.",
      kind: "mutation",
      approval: "none",
      args: filesTransferArgsSchema,
      syntax: "{from, to} or {items:[{from, to}]} or {resultSet, toDirectory}",
      example: { from: "tmp:/note.md", to: "tmp:/copy.md" },
      execute(args, context): ActionResult {
        const opened = open("files.copy", context);
        if ("status" in opened) return opened;
        return submitFileMutation({
          ...opened,
          action: "files.copy",
          args: filesTransferArgsSchema.parse(args),
        });
      },
    },
    {
      id: "files.move",
      description:
        "Move a file or folder between writable aliases. One collision-free move runs immediately. Multiple moves, or a resultSet plus toDirectory, wait for confirmation. Cross-volume moves copy, then send the original to the Recycle Bin.",
      kind: "mutation",
      approval: "none",
      args: filesTransferArgsSchema,
      syntax: "{from, to} or {items:[{from, to}]} or {resultSet, toDirectory}",
      example: { from: "tmp:/Inbox/a.md", to: "tmp:/Sorted/a.md" },
      execute(args, context): ActionResult {
        const opened = open("files.move", context);
        if ("status" in opened) return opened;
        return submitFileMutation({
          ...opened,
          action: "files.move",
          args: filesTransferArgsSchema.parse(args),
        });
      },
    },
    {
      id: "files.rename",
      description:
        "Rename a file or folder inside its current folder. One collision-free rename runs immediately. Several renames wait for confirmation. Changing folders is files.move. Swaps and cycles are rejected.",
      kind: "mutation",
      approval: "none",
      args: filesTransferArgsSchema,
      syntax: "{from, to} or {items:[{from, to}]} or {resultSet, toDirectory}",
      example: { from: "tmp:/draft.md", to: "tmp:/final.md" },
      execute(args, context): ActionResult {
        const opened = open("files.rename", context);
        if ("status" in opened) return opened;
        return submitFileMutation({
          ...opened,
          action: "files.rename",
          args: filesTransferArgsSchema.parse(args),
        });
      },
    },
    {
      id: "files.trash",
      description:
        "Send files or folders to the Recycle Bin. Always waits for confirmation, including a single file. Failure leaves the item in place. There is no permanent delete.",
      kind: "mutation",
      approval: "required",
      args: filesTrashArgsSchema,
      syntax: "{path} or {paths:[path]} or {resultSet}",
      example: { path: "tmp:/old.md" },
      execute(args, context): ActionResult {
        const opened = open("files.trash", context);
        if ("status" in opened) return opened;
        return submitFileMutation({
          ...opened,
          action: "files.trash",
          args: filesTrashArgsSchema.parse(args),
        });
      },
    },
    {
      id: "files.batch",
      description:
        "Plan an ordered list of create, copy, move, rename, and trash items. A directory create can satisfy a later move. Any trash, or two or more items, waits for confirmation. Edits are separate one-file plans. Execution stops on the first failure.",
      kind: "mutation",
      approval: "required",
      args: filesBatchArgsSchema,
      syntax:
        '{items:[{action:"files.create", path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} | {action:"files.copy"|"files.move"|"files.rename", from, to} | {action:"files.trash", path}]}',
      example: {
        items: [
          { action: "files.create", kind: "directory", path: "tmp:/Sorted" },
          { action: "files.move", from: "tmp:/a.md", to: "tmp:/Sorted/a.md" },
        ],
      },
      execute(args, context): ActionResult {
        const opened = open("files.batch", context);
        if ("status" in opened) return opened;
        return submitFileMutation({
          ...opened,
          action: "files.batch",
          args: filesBatchArgsSchema.parse(args),
        });
      },
    },
    {
      id: "files.undo",
      description:
        "Best-effort undo of succeeded rename or move items from one finished operation. Trash and edits are not undone. One reversible item runs immediately when the current bytes still match. Several items wait for confirmation.",
      kind: "mutation",
      approval: "none",
      args: filesUndoArgsSchema,
      example: { operationId: "00000000-0000-4000-8000-000000000000" },
      execute(args, context): ActionResult {
        const opened = open("files.undo", context);
        if ("status" in opened) return opened;
        return submitFileMutation({
          ...opened,
          action: "files.undo",
          args: filesUndoArgsSchema.parse(args),
        });
      },
    },
  ];
}
