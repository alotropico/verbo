import type {
  CommandDefinition,
  CommandModule,
  TrustedCommandBindings,
} from "./modules";
import { arch, platform, release } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  actionResultSchema,
  type ActionResult,
} from "../../shared/action-contract";
import { boundedDetail } from "../../shared/bounded-detail";
import { createRootStore } from "../db/registered-roots";
import type { ScopeStore } from "../db/scopes";
import { knownFolders } from "../platform/known-folders";
import type { Capability } from "./registry";

const emptyArgs = z.object({}).strict();

function pathsBindings(
  resolveScopes?: () => ScopeStore,
  resolveDatabase?: () => DatabaseSync,
): TrustedCommandBindings["handlers"] {
  return {
    "environment.paths": (): ActionResult => {
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

export function platformBindings(): TrustedCommandBindings["handlers"] {
  return {
    "environment.platform": (): ActionResult => {
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

export function environmentBindings(
  resolveScopes?: () => ScopeStore,
  resolveDatabase?: () => DatabaseSync,
): TrustedCommandBindings["handlers"] {
  return {
    ...platformBindings(),
    ...pathsBindings(resolveScopes, resolveDatabase),
  };
}

export const environmentCommands: CommandDefinition[] = [
  {
    id: "environment.paths",
    aliases: ["folders", "locations"],
    description:
      "Well-known folders and registered aliases. Does not list environment variables or secrets.",
    kind: "read",
    approval: "none",
    args: emptyArgs,
    example: {},
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "environment.paths" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none",
    configurable: ["aliases"],
    requirements: ["Verbo backend storage and local platform services."],
    effect: "read",
  },
  {
    id: "environment.platform",
    aliases: ["os", "system-info"],
    description: "Operating system name, version, and architecture.",
    kind: "read",
    approval: "none",
    args: emptyArgs,
    example: {},
    tags: [],
    parameterHelp: {},
    execution: { type: "handler", handler: "environment.platform" },
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none",
    configurable: ["aliases"],
    requirements: ["Verbo backend storage and local platform services."],
    effect: "read",
  },
];

export const environmentModule: CommandModule = {
  id: "environment",
  aliases: ["env", "system", "host"],
  description: "Platform facts and well-known paths",
  version: 1,
  scopes: [],
  commands: environmentCommands,
};

/** Narrow fixture convenience derived from the authoritative descriptor. */
export function platformCapability(): Capability {
  const command = environmentCommands.find(
    (entry) => entry.id === "environment.platform",
  )!;
  return { ...command, execute: platformBindings()[command.id] };
}
