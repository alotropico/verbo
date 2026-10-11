import { win32 } from "node:path";
import type { ActionResult } from "../../shared/action-contract";
import { displayFinalPath } from "../../shared/files";
import { z } from "zod";
import type { ScopeStore } from "../db/scopes";
import type { Capability } from "./registry";

const filesScopesArgsSchema = z.object({}).strict();

function failure(action: string, code: string, summary: string): ActionResult {
  return { action, status: "error", code, summary };
}

export function filesCapabilities(resolve: () => ScopeStore): Capability[] {
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
          store = resolve();
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
  ];
}
