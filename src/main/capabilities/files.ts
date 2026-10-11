import { win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../shared/action-contract";
import {
  filesListArgsSchema,
  filesSearchArgsSchema,
  filesStatArgsSchema,
  filesSummaryArgsSchema,
} from "../../shared/file-query";
import { displayFinalPath } from "../../shared/files";
import type { ScopeStore } from "../db/scopes";
import {
  listFiles,
  searchFiles,
  statFiles,
  summarizeFiles,
  type FileQueryRequest,
} from "../files/query-engine";
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
        const entries = scopes.map((scope) => ({
          alias: `${scope.alias}:`,
          label: win32.basename(displayFinalPath(scope.path)) || scope.alias,
          read: scope.read,
          write: scope.write,
          defaultSave: scope.defaultSave,
        }));
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
  ];
}
