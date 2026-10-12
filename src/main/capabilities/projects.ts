import { win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../shared/action-contract";
import { boundedDetail } from "../../shared/bounded-detail";
import {
  projectsFilesArgsSchema,
  projectsInspectArgsSchema,
  projectsListArgsSchema,
} from "../../shared/projects";
import { createRootStore } from "../db/registered-roots";
import type { ScopeStore } from "../db/scopes";
import { listFiles } from "../files/query-engine";
import { isFinalPathInside } from "../files/windows-containment";
import { inspectProject } from "../projects/inspect";
import { resolveRegisteredRoot } from "../projects/resolve-root";
import type { ActionContext, Capability } from "./registry";

function failure(action: string, code: string, summary: string): ActionResult {
  return { action, status: "error", code, summary };
}

function withProjectRead(
  store: ScopeStore,
  path: string,
  now: number,
): ScopeStore {
  return {
    ...store,
    activeGrants: () => [
      ...store.activeGrants(),
      {
        id: "registered-project-read",
        kind: "directory" as const,
        path,
        createdAt: now,
        expiresAt: now + 60_000,
      },
    ],
  };
}

export function projectCapabilities(
  resolveScopes?: () => ScopeStore,
  resolveDatabase?: () => DatabaseSync,
): Capability[] {
  function open(action: string):
    | { database: DatabaseSync; scopes: ScopeStore }
    | ActionResult {
    try {
      if (!resolveDatabase || !resolveScopes) {
        return failure(action, "unavailable", "Projects are not configured.");
      }
      return { database: resolveDatabase(), scopes: resolveScopes() };
    } catch {
      return failure(action, "unavailable", "Projects are not configured.");
    }
  }

  return [
    {
      id: "projects.list",
      description:
        "Registered project summaries. Registration does not grant write access.",
      kind: "read",
      approval: "none",
      args: projectsListArgsSchema,
      example: {},
      execute(): ActionResult {
        const opened = open("projects.list");
        if ("status" in opened) return opened;
        const projects = createRootStore(
          opened.database,
          "registered_projects",
          "project",
        )
          .list()
          .slice(0, 20)
          .map((project) => {
            const facts = inspectProject(
              project.path,
              win32.basename(project.path),
            );
            return {
              alias: project.alias,
              path: project.path,
              name: facts.name,
              description: facts.description.slice(0, 80),
              stack: facts.stack,
              vcs: facts.vcs,
              write: false,
            };
          });
        const packed = boundedDetail({ projects });
        return {
          action: "projects.list",
          status: "success",
          summary:
            projects.length === 0
              ? "No projects are registered."
              : `${projects.length} registered projects. None receive write access from registration.`,
          detail: packed.detail,
          ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
        };
      },
    },
    {
      id: "projects.inspect",
      description:
        "Manifest and repository metadata for one registered or explicitly selected project. Does not dump source.",
      kind: "read",
      approval: "none",
      args: projectsInspectArgsSchema,
      example: { project: "verbo" },
      execute(args, context: ActionContext): ActionResult {
        const opened = open("projects.inspect");
        if ("status" in opened) return opened;
        const project = String(args.project);
        const resolved = resolveRegisteredRoot({
          reference: project,
          roots: createRootStore(
            opened.database,
            "registered_projects",
            "project",
          ).list(),
          grants: opened.scopes.activeGrants(),
          noun: "project",
          actor: context.actor,
        });
        if (!resolved.ok) {
          return failure(
            "projects.inspect",
            resolved.code,
            resolved.summary,
          );
        }
        const facts = inspectProject(
          resolved.root.path,
          win32.basename(resolved.root.path),
        );
        const writableScope =
          opened.scopes
            .list()
            .find(
              (scope) =>
                scope.write &&
                isFinalPathInside(scope.path, resolved.root.path),
            )?.alias ?? null;
        const packed = boundedDetail({
          alias: resolved.root.alias,
          path: resolved.root.path,
          ...facts,
          writableScope,
        });
        return {
          action: "projects.inspect",
          status: "success",
          summary: `${facts.name}: ${facts.stack.join(", ") || "no detected stack"}. Registration does not grant writes.`,
          detail: packed.detail,
          ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
        };
      },
    },
    {
      id: "projects.files",
      description:
        "Bounded directory view of a registered or explicitly selected project.",
      kind: "read",
      approval: "none",
      args: projectsFilesArgsSchema,
      example: { project: "verbo", depth: 0 },
      execute(args, context): ActionResult {
        const opened = open("projects.files");
        if ("status" in opened) return opened;
        const resolved = resolveRegisteredRoot({
          reference: String(args.project),
          roots: createRootStore(
            opened.database,
            "registered_projects",
            "project",
          ).list(),
          grants: opened.scopes.activeGrants(),
          noun: "project",
          actor: context.actor,
        });
        if (!resolved.ok) {
          return failure("projects.files", resolved.code, resolved.summary);
        }
        const now = Date.now();
        const listed = listFiles(
          {
            database: opened.database,
            store: withProjectRead(opened.scopes, resolved.root.path, now),
            actor: context.actor,
            threadId: context.threadId,
            now,
          },
          {
            root: resolved.root.path,
            ...(typeof args.path === "string" ? { path: args.path } : {}),
            depth: args.depth,
            pageSize: args.pageSize,
            ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
          },
        );
        return { ...listed, action: "projects.files" };
      },
    },
  ];
}
