import { fileMutationCommands } from "./file-mutations";
import type {
  CommandDefinition,
  CommandModule,
  TrustedCommandBindings,
} from "./modules";
import { win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  actionResultSchema,
  type ActionResult,
} from "../../shared/action-contract";
import {
  filesListArgsSchema,
  filesNextArgsSchema,
  filesSearchArgsSchema,
  filesStatArgsSchema,
  filesSummaryArgsSchema,
} from "../../shared/file-query";
import {
  filesCompareArgsSchema,
  filesHashArgsSchema,
  filesInspectImageArgsSchema,
  filesReadArgsSchema,
} from "../../shared/file-readers";
import { displayFinalPath } from "../../shared/files";
import type { ScopeStore } from "../db/scopes";
import {
  continueFilePage,
  listFiles,
  searchFiles,
  statFiles,
  summarizeFiles,
  type FileQueryRequest,
} from "../files/query-engine";
import {
  compareFiles,
  hashFiles,
  inspectImages,
  readFileContent,
} from "../files/readers";
import { modelSupportsVision } from "../runtime/model-vision";
import { loadSettings } from "../services/settings-store";

import { z } from "zod";

const filesScopesArgsSchema = z.object({}).strict();

function failure(action: string, code: string, summary: string): ActionResult {
  return { action, status: "error", code, summary };
}

function isFailure(
  value: FileQueryRequest | ActionResult,
): value is ActionResult {
  return "status" in value;
}

export function fileQueryBindings(
  resolveScopes: () => ScopeStore,
  resolveDatabase: () => DatabaseSync,
): TrustedCommandBindings["handlers"] {
  function request(
    action: string,
    context: { actor: FileQueryRequest["actor"]; threadId: string },
  ): FileQueryRequest | ActionResult {
    try {
      return {
        database: resolveDatabase(),
        store: resolveScopes(),
        actor: context.actor,
        threadId: context.threadId,
      };
    } catch {
      return failure(action, "unavailable", "File queries are not configured.");
    }
  }

  return {
    "files.scopes": (): ActionResult => {
      let store: ScopeStore;
      try {
        store = resolveScopes();
      } catch {
        return failure(
          "files.scopes",
          "unavailable",
          "File scopes are not configured.",
        );
      }
      const all = store.list();
      const scopes = all.slice(0, 50);
      const entries = scopes.flatMap((scope) =>
        scope.aliases.map((alias) => ({
          alias: `${alias}:`,
          label: win32.basename(displayFinalPath(scope.path)) || alias,
          read: scope.read,
          write: scope.write,
          defaultSave: scope.defaultSave,
        })),
      );
      return {
        action: "files.scopes",
        status: "success",
        summary:
          entries.length === 0
            ? "No folders are registered."
            : `Listed ${entries.length} folder aliases.`,
        detail: JSON.stringify({ scopes: entries }),
        totalItems: all.length,
        ...(all.length > entries.length ? { detailsAvailable: true } : {}),
      };
    },
    "files.list": (args, context): ActionResult => {
      const opened = request("files.list", context);
      if (isFailure(opened)) return opened;
      return listFiles(opened, args);
    },
    "files.search": (args, context): ActionResult => {
      const opened = request("files.search", context);
      if (isFailure(opened)) return opened;
      return searchFiles(opened, args);
    },
    "files.stat": (args, context): ActionResult => {
      const opened = request("files.stat", context);
      if (isFailure(opened)) return opened;
      return statFiles(opened, args);
    },
    "files.summary": (args, context): ActionResult => {
      const opened = request("files.summary", context);
      if (isFailure(opened)) return opened;
      return summarizeFiles(opened, args);
    },
    "files.next": (args, context): ActionResult => {
      const opened = request("files.next", context);
      if (isFailure(opened)) return opened;
      return continueFilePage(opened, args);
    },
    "files.read": (args, context): ActionResult => {
      const opened = request("files.read", context);
      if (isFailure(opened)) return opened;
      return readFileContent(opened, args);
    },
    "files.compare": (args, context): ActionResult => {
      const opened = request("files.compare", context);
      if (isFailure(opened)) return opened;
      return compareFiles(opened, args);
    },
    "files.hash": (args, context): ActionResult => {
      const opened = request("files.hash", context);
      if (isFailure(opened)) return opened;
      return hashFiles(opened, args);
    },
    "files.inspect_image": (args, context): ActionResult => {
      const opened = request("files.inspect_image", context);
      if (isFailure(opened)) return opened;
      return inspectImages(opened, args, {
        visionSupported: modelSupportsVision(loadSettings().model),
      });
    },
  };
}

export const fileQueryCommands: CommandDefinition[] = [
  {
    id: "files.scopes",
    aliases: ["roots", "permissions"],
    description:
      "List registered folder aliases and whether each allows read or write. Reads of other existing paths are allowed. Writes stay inside a writable alias. Does not list files inside those folders.",
    kind: "read",
    approval: "none",
    args: filesScopesArgsSchema,
    example: {},
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.scopes" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.list",
    aliases: ["ls", "directory"],
    description:
      "List accessible descendants of one folder, without a subfolder-depth limit. entryType directories counts only folders. Folder size is null. pageSize defaults to 20. Pass cursor for the next page. Relay counts.directories and counts.files from the result, including exactTotal null when the bounded scan is incomplete. Hidden entries, .git, and node_modules are skipped unless includeHidden is set; .git and node_modules are still not entered. When scan.complete is true, scan.omitted still names hidden and skipped-descent entries left out of an exact total.",
    kind: "read",
    approval: "none",
    args: filesListArgsSchema,
    example: { root: "tmp:", pageSize: 20 },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.list" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.search",
    aliases: ["find", "locate"],
    description:
      "Search accessible descendants of one folder by file name or UTF-8 text, without a subfolder-depth limit. Scans retain entry, time and content limits. mode filename does not read contents. mode content returns one bounded snippet per file unless groupBy is match. Pass the same arguments plus cursor for the next page.",
    kind: "read",
    approval: "none",
    args: filesSearchArgsSchema,
    example: {
      root: "tmp:",
      mode: "filename",
      extensions: ["md"],
      pageSize: 20,
    },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.search" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.stat",
    aliases: ["info", "metadata"],
    description:
      "Metadata for explicit files or folders. No file contents. Links are not followed.",
    kind: "read",
    approval: "none",
    args: filesStatArgsSchema,
    example: { paths: ["tmp:/notes.md"] },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.stat" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.summary",
    aliases: ["inventory", "overview"],
    description:
      "Counts, extensions, and largest or newest files among accessible descendants of one folder, without a subfolder-depth limit. entryType directories or files limits the count. Relay counts.files and counts.directories, and say exactTotal is unknown when it is null. totalBytes is present only when the bounded scan finishes. Folder sizes stay unknown. Disclose scan omissions when a total is exact.",
    kind: "read",
    approval: "none",
    args: filesSummaryArgsSchema,
    example: { root: "tmp:" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.summary" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.next",
    aliases: ["continue", "page"],
    description:
      "Continue a saved file list or search. The cursor stays bound to the original query, conversation, and snapshot.",
    kind: "read",
    approval: "none",
    args: filesNextArgsSchema,
    example: { cursor: "00000000-0000-4000-8000-000000000000" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.next" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.read",
    aliases: ["open", "cat", "show"],
    tags: ["content", "text", "reader"],
    parameterHelp: {
      path: "Existing file path or registered folder alias; reads recheck native containment.",
    },
    description:
      "Read a bounded line range, JSON pointer, or PDF page range. Binary files and unknown encodings are reported, not guessed.",
    kind: "read",
    approval: "none",
    args: filesReadArgsSchema,
    example: { path: "tmp:/notes.md", startLine: 1, lineCount: 80 },
    execution: { type: "handler", handler: "files.read" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.compare",
    aliases: ["diff", "contrast"],
    description:
      "Capped read-only text diff of two files, or one file against proposed text. Nothing is written.",
    kind: "read",
    approval: "none",
    args: filesCompareArgsSchema,
    syntax: "{left, right} or {left, proposed}",
    example: { left: "tmp:/a.md", right: "tmp:/b.md" },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.compare" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.hash",
    aliases: ["checksum", "digest"],
    description:
      "SHA-256 for explicit files, size capped. Filename similarity is not equality.",
    kind: "read",
    approval: "none",
    args: filesHashArgsSchema,
    example: { paths: ["tmp:/notes.md"] },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.hash" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
  {
    id: "files.inspect_image",
    aliases: ["image-info", "dimensions"],
    description:
      "Image width, height, and format. Image bytes are included only when the selected model supports vision and the payload fits the result cap.",
    kind: "read",
    approval: "none",
    args: filesInspectImageArgsSchema,
    example: { paths: ["tmp:/diagram.png"] },
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "files.inspect_image" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "handler_verified",
    configurable: ["aliases"],
    requirements: [
      "Allowed file scope and current access; native containment and confirmation rules apply.",
    ],
    effect: "read",
  },
];

export const filesModule: CommandModule = {
  id: "files",
  aliases: ["file", "fs", "filesystem"],
  description: "Scoped file queries and mutations",
  version: 1,
  scopes: [],
  commands: [...fileQueryCommands, ...fileMutationCommands],
};
