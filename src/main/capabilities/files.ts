import { win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../shared/action-contract";
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
import type { Capability } from "./registry";
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

export function filesCapabilities(
  resolveScopes: () => ScopeStore,
  resolveDatabase: () => DatabaseSync,
): Capability[] {
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

  return [
    {
      id: "files.scopes",
      description:
        "List registered folder aliases and whether each allows read or write. Reads of other existing paths are allowed. Writes stay inside a writable alias. Does not list files inside those folders.",
      kind: "read",
      approval: "none",
      args: filesScopesArgsSchema,
      example: {},
      execute(): ActionResult {
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
    },
    {
      id: "files.list",
      description:
        "List one folder. depth 0 is immediate children. Folder size is null. pageSize defaults to 20. Pass cursor for the next page. Hidden entries, .git, and node_modules are skipped unless includeHidden is set; .git and node_modules are still not entered.",
      kind: "read",
      approval: "none",
      args: filesListArgsSchema,
      example: { root: "tmp:", depth: 0, pageSize: 20 },
      execute(args, context): ActionResult {
        const opened = request("files.list", context);
        if (isFailure(opened)) return opened;
        return listFiles(opened, args);
      },
    },
    {
      id: "files.search",
      description:
        "Search one folder by file name or UTF-8 text. mode filename does not read contents. mode content returns one bounded snippet per file unless groupBy is match. Pass the same arguments plus cursor for the next page.",
      kind: "read",
      approval: "none",
      args: filesSearchArgsSchema,
      example: {
        root: "tmp:",
        mode: "filename",
        extensions: ["md"],
        depth: 2,
        pageSize: 20,
      },
      execute(args, context): ActionResult {
        const opened = request("files.search", context);
        if (isFailure(opened)) return opened;
        return searchFiles(opened, args);
      },
    },
    {
      id: "files.stat",
      description:
        "Metadata for explicit files or folders. No file contents. Links are not followed.",
      kind: "read",
      approval: "none",
      args: filesStatArgsSchema,
      example: { paths: ["tmp:/notes.md"] },
      execute(args, context): ActionResult {
        const opened = request("files.stat", context);
        if (isFailure(opened)) return opened;
        return statFiles(opened, args);
      },
    },
    {
      id: "files.summary",
      description:
        "Counts, extensions, and largest or newest files under one folder. totalBytes is present only when the scan finishes. Folder sizes stay unknown.",
      kind: "read",
      approval: "none",
      args: filesSummaryArgsSchema,
      example: { root: "tmp:", depth: 1 },
      execute(args, context): ActionResult {
        const opened = request("files.summary", context);
        if (isFailure(opened)) return opened;
        return summarizeFiles(opened, args);
      },
    },
    {
      id: "files.next",
      description:
        "Continue a saved file list or search. The cursor stays bound to the original query, conversation, and snapshot.",
      kind: "read",
      approval: "none",
      args: filesNextArgsSchema,
      example: { cursor: "00000000-0000-4000-8000-000000000000" },
      execute(args, context): ActionResult {
        const opened = request("files.next", context);
        if (isFailure(opened)) return opened;
        return continueFilePage(opened, args);
      },
    },
    {
      id: "files.read",
      description:
        "Read a bounded line range, JSON pointer, or PDF page range. Binary files and unknown encodings are reported, not guessed.",
      kind: "read",
      approval: "none",
      args: filesReadArgsSchema,
      example: { path: "tmp:/notes.md", startLine: 1, lineCount: 80 },
      execute(args, context): ActionResult {
        const opened = request("files.read", context);
        if (isFailure(opened)) return opened;
        return readFileContent(opened, args);
      },
    },
    {
      id: "files.compare",
      description:
        "Capped read-only text diff of two files, or one file against proposed text. Nothing is written.",
      kind: "read",
      approval: "none",
      args: filesCompareArgsSchema,
      syntax: "{left, right} or {left, proposed}",
      example: { left: "tmp:/a.md", right: "tmp:/b.md" },
      execute(args, context): ActionResult {
        const opened = request("files.compare", context);
        if (isFailure(opened)) return opened;
        return compareFiles(opened, args);
      },
    },
    {
      id: "files.hash",
      description:
        "SHA-256 for explicit files, size capped. Filename similarity is not equality.",
      kind: "read",
      approval: "none",
      args: filesHashArgsSchema,
      example: { paths: ["tmp:/notes.md"] },
      execute(args, context): ActionResult {
        const opened = request("files.hash", context);
        if (isFailure(opened)) return opened;
        return hashFiles(opened, args);
      },
    },
    {
      id: "files.inspect_image",
      description:
        "Image width, height, and format. Image bytes are included only when the selected model supports vision and the payload fits the result cap.",
      kind: "read",
      approval: "none",
      args: filesInspectImageArgsSchema,
      example: { paths: ["tmp:/diagram.png"] },
      execute(args, context): ActionResult {
        const opened = request("files.inspect_image", context);
        if (isFailure(opened)) return opened;
        return inspectImages(opened, args, {
          visionSupported: modelSupportsVision(loadSettings().model),
        });
      },
    },
  ];
}
