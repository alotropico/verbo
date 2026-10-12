import { arch, platform, release } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ActionResult } from "../../shared/action-contract";
import { boundedDetail } from "../../shared/bounded-detail";
import { createRootStore } from "../db/registered-roots";
import type { ScopeStore } from "../db/scopes";
import { knownFolders } from "../platform/known-folders";
import type { Capability } from "./registry";

const emptyArgs = z.object({}).strict();

function pathsCapability(
  resolveScopes?: () => ScopeStore,
  resolveDatabase?: () => DatabaseSync,
): Capability {
  return {
    id: "environment.paths",
    description:
      "Well-known folders and registered aliases. Does not list environment variables or secrets.",
    kind: "read",
    approval: "none",
    args: emptyArgs,
    example: {},
    execute(): ActionResult {
      const folders = knownFolders().map((folder) => ({
        kind: "well-known" as const,
        name: folder.name,
        path: folder.path,
        write: false,
      }));
      const aliases: Array<{
        kind: "scope" | "project";
        name: string;
        path: string;
        write: boolean;
      }> = [];
      try {
        if (resolveScopes) {
          for (const scope of resolveScopes().list().slice(0, 20)) {
            for (const name of scope.aliases) {
              aliases.push({
                kind: "scope",
                name,
                path: scope.path,
                write: scope.write,
              });
            }
          }
        }
      } catch {
        // Registered aliases stay empty when scopes are not configured.
      }
      try {
        if (resolveDatabase) {
          for (const project of createRootStore(
            resolveDatabase(),
            "registered_projects",
            "project",
          )
            .list()
            .slice(0, 20)) {
            aliases.push({
              kind: "project",
              name: project.alias,
              path: project.path,
              write: false,
            });
          }
        }
      } catch {
        // Project aliases stay empty when the database is not configured.
      }
      const packed = boundedDetail({ folders, aliases });
      return {
        action: "environment.paths",
        status: "success",
        summary: `${folders.length} well-known folders, ${aliases.length} registered aliases.`,
        detail: packed.detail,
        ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
      };
    },
  };
}

export function platformCapability(): Capability {
  return {
    id: "environment.platform",
    description: "Operating system name, version, and architecture.",
    kind: "read",
    approval: "none",
    args: emptyArgs,
    example: {},
    execute(): ActionResult {
      const facts = {
        platform: platform(),
        release: release(),
        arch: arch(),
      };
      return {
        action: "environment.platform",
        status: "success",
        summary: `${facts.platform} ${facts.arch}`,
        detail: JSON.stringify(facts),
      };
    },
  };
}

export function environmentCapabilities(
  resolveScopes?: () => ScopeStore,
  resolveDatabase?: () => DatabaseSync,
): Capability[] {
  return [
    platformCapability(),
    pathsCapability(resolveScopes, resolveDatabase),
  ];
}
