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
  filesRenameArgsSchema,
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
      receiptId?: string;
    },
  ): Omit<MutationSubmit, "action" | "args"> | ActionResult {
    try {
      return {
        database: resolveDatabase(),
        scopes: resolveScopes(),
        actor: context.actor,
        receiptId: context.receiptId,
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
        args: filesRenameArgsSchema.parse(args),
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
      "Copy. Widest: {in, toDirectory, formats?, pattern?} copies every nested file under in. Else {resultSet, toDirectory}, {items:[{from, to}]}, or {from, to}. Source may be read-only. formats: extensions, case insensitive. pattern: path regex. {in, toDirectory} and {resultSet, toDirectory} store a taken name as name (2).ext, then (3), until free. One copy runs now. Several, or a resultSet, wait for confirmation. No silent overwrite.",
    kind: "mutation",
    approval: "none",
    args: filesTransferArgsSchema,
    syntax:
      "{in, toDirectory, formats?, pattern?} or {resultSet, toDirectory} or {items:[{from, to}]} or {from, to}",
    example: { in: "tmp:/Inbox", toDirectory: "tmp:/Copies" },
    tags: ["nested", "subfolder", "subfolders"],
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
      "Move. Widest: {in, toDirectory, formats?, pattern?} moves every nested file under in into toDirectory; the same folder flattens. Else {resultSet, toDirectory}, {items:[{from, to}]}, {from, to}, or files.batch. formats: extensions, case insensitive. pattern: path regex. A path already at the destination stays. {in, toDirectory} and {resultSet, toDirectory} store a taken name as name (2).ext, then (3), until free. One move runs now. Several wait for confirmation. Cross-volume: copy, then Recycle Bin the source.",
    kind: "mutation",
    approval: "none",
    args: filesTransferArgsSchema,
    syntax:
      "{in, toDirectory, formats?, pattern?} or {resultSet, toDirectory} or {items:[{from, to}]} or {from, to}",
    example: { in: "tmp:/agent-files", toDirectory: "tmp:/agent-files" },
    tags: ["flatten", "nested", "subfolder", "subfolders"],
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
      "Rename inside the current folder. Not a flatten. Changing folders is files.move {in, toDirectory}. One collision-free rename runs now. Several wait for confirmation. Each file needs its own from and to. Swaps and cycles are rejected.",
    kind: "mutation",
    approval: "none",
    args: filesRenameArgsSchema,
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
      "Trash to Recycle Bin. Widest: {in, formats?, pattern?} every nested file under in. Else {resultSet}, {paths:[path]}, or {path}. formats: extensions, case insensitive. pattern: path regex. Always waits for confirmation. Failure leaves the item. No permanent delete.",
    kind: "mutation",
    approval: "required",
    args: filesTrashArgsSchema,
    syntax:
      "{in, formats?, pattern?} or {resultSet} or {paths:[path]} or {path}",
    example: { in: "tmp:/old", formats: ["md"] },
    tags: ["nested", "subfolder", "subfolders"],
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
      'Ordered plan of create, edit, copy, move, rename, and trash. Prefer one item {action:"files.move"|"files.copy", in, toDirectory, formats?, pattern?} or {action:"files.trash", in, formats?, pattern?} over a path list. Explicit {from, to} and {path} remain. formats: extensions, case insensitive. pattern: path regex. Later items may use paths earlier items create. One confirmation. Stops on first failure.',
    kind: "mutation",
    approval: "required",
    args: filesBatchArgsSchema,
    syntax:
      '{items:[{action:"files.copy"|"files.move", in, toDirectory, formats?, pattern?} | {action:"files.trash", in, formats?, pattern?} | {action:"files.copy"|"files.move"|"files.rename", from, to} | {action:"files.trash", path} | {action:"files.create", path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} | {action:"files.edit", path, mode:"full"|"replace"|"lines", content?, find?, replace?, expectedMatches?, startLine?, endLine?, format?}]}',
    example: {
      items: [
        {
          action: "files.move",
          in: "tmp:/agent-files",
          toDirectory: "tmp:/agent-files",
        },
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
