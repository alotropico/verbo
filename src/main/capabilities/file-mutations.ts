import type { CommandDefinition, TrustedCommandBindings } from "./modules";
import type { DatabaseSync } from "node:sqlite";
import {
  actionResultSchema,
  type ActionResult,
} from "../../shared/action-contract";
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

function failure(action: string, summary: string): ActionResult {
  return { action, status: "error", code: "unavailable", summary };
}

export function fileMutationBindings(
  resolveScopes: () => ScopeStore,
  resolveDatabase: () => DatabaseSync,
): TrustedCommandBindings["handlers"] {
  function open(
    action: string,
    context: {
      actor: MutationSubmit["actor"];
      threadId: string;
      turnId?: string;
      signal?: AbortSignal;
    },
  ): Omit<MutationSubmit, "action" | "args"> | ActionResult {
    try {
      return {
        database: resolveDatabase(),
        scopes: resolveScopes(),
        actor: context.actor,
        threadId: context.threadId,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      };
    } catch {
      return failure(action, "File changes are not configured.");
    }
  }

  return {
    "files.create": async (args, context): Promise<ActionResult> => {
      const opened = open("files.create", context);
      if ("status" in opened) return opened;
      return submitFileMutation({
        ...opened,
        action: "files.create",
        args: filesCreateArgsSchema.parse(args),
      });
    },
    "files.edit": async (args, context): Promise<ActionResult> => {
      const opened = open("files.edit", context);
      if ("status" in opened) return opened;
      return submitFileMutation({
        ...opened,
        action: "files.edit",
        args: filesEditArgsSchema.parse(args),
      });
    },
    "files.copy": async (args, context): Promise<ActionResult> => {
      const opened = open("files.copy", context);
      if ("status" in opened) return opened;
      return submitFileMutation({
        ...opened,
        action: "files.copy",
        args: filesTransferArgsSchema.parse(args),
      });
    },
    "files.move": async (args, context): Promise<ActionResult> => {
      const opened = open("files.move", context);
      if ("status" in opened) return opened;
      return submitFileMutation({
        ...opened,
        action: "files.move",
        args: filesTransferArgsSchema.parse(args),
      });
    },
    "files.rename": async (args, context): Promise<ActionResult> => {
      const opened = open("files.rename", context);
      if ("status" in opened) return opened;
      return submitFileMutation({
        ...opened,
        action: "files.rename",
        args: filesTransferArgsSchema.parse(args),
      });
    },
    "files.trash": async (args, context): Promise<ActionResult> => {
      const opened = open("files.trash", context);
      if ("status" in opened) return opened;
      return submitFileMutation({
        ...opened,
        action: "files.trash",
        args: filesTrashArgsSchema.parse(args),
      });
    },
    "files.batch": async (args, context): Promise<ActionResult> => {
      const opened = open("files.batch", context);
      if ("status" in opened) return opened;
      return submitFileMutation({
        ...opened,
        action: "files.batch",
        args: filesBatchArgsSchema.parse(args),
      });
    },
    "files.undo": async (args, context): Promise<ActionResult> => {
      const opened = open("files.undo", context);
      if ("status" in opened) return opened;
      return submitFileMutation({
        ...opened,
        action: "files.undo",
        args: filesUndoArgsSchema.parse(args),
      });
    },
  };
}

export const fileMutationCommands: CommandDefinition[] = [
  {
    id: "files.create",
    aliases: ["new", "make"],
    description:
      "Create a file or folder. A bare filename is saved in the default folder (.tmp). One collision-free item runs immediately and returns a receipt. Two or more items need confirmation. Existing paths are never overwritten.",
    kind: "mutation",
    approval: "none",
    args: filesCreateArgsSchema,
    syntax:
      '{path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} or {items:[{path, kind:"file"|"directory", content?, format?}]}',
    example: { path: "note.md", kind: "file", content: "# Note\n" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.create" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "write",
  },
  {
    id: "files.edit",
    aliases: ["modify", "change"],
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
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.edit" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "write",
  },
  {
    id: "files.copy",
    aliases: ["duplicate", "cp"],
    description:
      "Copy a file or folder into a writable alias. The source may be read-only. One collision-free copy runs immediately. Multiple copies, or a resultSet, wait for confirmation. No silent overwrite.",
    kind: "mutation",
    approval: "none",
    args: filesTransferArgsSchema,
    syntax: "{from, to} or {items:[{from, to}]} or {resultSet, toDirectory}",
    example: { from: "tmp:/note.md", to: "tmp:/copy.md" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.copy" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "write",
  },
  {
    id: "files.move",
    aliases: ["relocate", "mv"],
    description:
      "Move a file or folder between writable aliases. One collision-free move runs immediately. Multiple moves, or a resultSet plus toDirectory, wait for confirmation. Cross-volume moves copy, then send the original to the Recycle Bin.",
    kind: "mutation",
    approval: "none",
    args: filesTransferArgsSchema,
    syntax: "{from, to} or {items:[{from, to}]} or {resultSet, toDirectory}",
    example: { from: "tmp:/Inbox/a.md", to: "tmp:/Sorted/a.md" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.move" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "write",
  },
  {
    id: "files.rename",
    aliases: ["retitle", "name"],
    tags: ["filename", "change"],
    parameterHelp: {
      items:
        "Ordered source and destination pairs; confirmation binds the exact native plan.",
    },
    description:
      "Rename a file or folder inside its current folder. One collision-free rename runs immediately. Several renames wait for confirmation. Changing folders is files.move. Swaps and cycles are rejected.",
    kind: "mutation",
    approval: "none",
    args: filesTransferArgsSchema,
    syntax: "{from, to} or {items:[{from, to}]} or {resultSet, toDirectory}",
    example: { from: "tmp:/draft.md", to: "tmp:/final.md" },
    execution: { type: "handler", handler: "files.rename" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "write",
  },
  {
    id: "files.trash",
    aliases: ["recycle", "discard"],
    description:
      "Send files or folders to the Recycle Bin. Always waits for confirmation, including a single file. Failure leaves the item in place. There is no permanent delete.",
    kind: "mutation",
    approval: "required",
    args: filesTrashArgsSchema,
    syntax: "{path} or {paths:[path]} or {resultSet}",
    example: { path: "tmp:/old.md" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.trash" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "write",
  },
  {
    id: "files.batch",
    aliases: ["bulk", "group"],
    description:
      "Plan an ordered list of create, edit, copy, move, rename, and trash items. Later items can use files and folders produced by earlier items. One confirmation covers the immutable ordered plan. Execution stops on the first failure.",
    kind: "mutation",
    approval: "required",
    args: filesBatchArgsSchema,
    syntax:
      '{items:[{action:"files.create", path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} | {action:"files.edit", path, mode:"full"|"replace"|"lines", content?, find?, replace?, expectedMatches?, startLine?, endLine?, format?} | {action:"files.copy"|"files.move"|"files.rename", from, to} | {action:"files.trash", path}]}',
    example: {
      items: [
        { action: "files.create", kind: "directory", path: "tmp:/Sorted" },
        { action: "files.move", from: "tmp:/a.md", to: "tmp:/Sorted/a.md" },
      ],
    },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.batch" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "write",
  },
  {
    id: "files.undo",
    aliases: ["revert", "reverse"],
    description:
      "Best-effort undo of succeeded rename or move items from one finished operation. Trash and edits are not undone. One reversible item runs immediately when the current bytes still match. Several items wait for confirmation.",
    kind: "mutation",
    approval: "none",
    args: filesUndoArgsSchema,
    example: { operationId: "00000000-0000-4000-8000-000000000000" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.undo" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "write",
  },
];
