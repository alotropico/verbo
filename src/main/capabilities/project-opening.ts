import type { DatabaseSync } from "node:sqlite";
import { actionResultSchema } from "../../shared/action-contract";
import {
  projectsOpenArgsSchema,
  projectsResolveArgsSchema,
  softwareLaunchArgsSchema,
  softwareResolveArgsSchema,
} from "../../shared/application-registration";
import {
  launchRegisteredApplication,
  materializeRegisteredLaunch,
  resolveRegisteredApplications,
  resolveRegisteredProject,
} from "../software/registered-launch";
import type { CommandDefinition, TrustedCommandBindings } from "./modules";
import { CommandFailure } from "./command-failure";

const common = {
  tags: ["open", "application", "project"],
  parameterHelp: {},
  output: actionResultSchema,
  messages: { failure: "Operation failed" },
  attachments: "none" as const,
  configurable: ["aliases"] as const,
  requirements: [
    "Uses enabled registrations. Launches require verified Windows executable identities and registered project folders.",
  ],
};
export const projectOpeningCommands: CommandDefinition[] = [
  {
    ...common,
    id: "projects.resolve",
    aliases: ["locate", "resolve-root"],
    description:
      "Resolve an enabled registered project and its configured default application; grants no file writes.",
    kind: "read",
    approval: "none",
    args: projectsResolveArgsSchema,
    example: { project: "watcher" },
    execution: { type: "handler", handler: "projects.resolve.registered" },
  },
  {
    ...common,
    id: "projects.open",
    effect: "launch",
    aliases: ["launch", "edit"],
    description:
      "Open a registered project in its configured default or an ordered, deduplicated selection of registered applications. Model requests receive one grouped review.",
    kind: "mutation",
    approval: "required",
    args: projectsOpenArgsSchema,
    example: { project: "watcher", applications: ["cursor", "vsc", "smerge"] },
    prepareChildren: true,
    execution: {
      type: "composite",
      aggregate: "projects.open.receipts",
      onFailure: "stop",
      steps: [
        {
          id: "project",
          command: "projects.resolve",
          args: {
            project: { from: "input", path: ["project"] },
            applications: { from: "input", path: ["applications"] },
          },
        },
        {
          id: "applications",
          command: "software.resolve",
          args: {
            applications: {
              from: "step",
              step: "project",
              path: ["data", "applications"],
            },
          },
        },
        {
          id: "launches",
          command: "software.launch",
          forEach: {
            from: "step",
            step: "applications",
            path: ["data", "applications"],
          },
          args: {
            application: { from: "item", path: ["id"] },
            project: { from: "step", step: "project", path: ["data", "id"] },
          },
        },
      ],
    },
  },
];
export const applicationCommands: CommandDefinition[] = [
  {
    ...common,
    id: "software.resolve",
    aliases: ["registered", "resolve-apps"],
    description:
      "Resolve enabled registered application names/aliases to verified executable records; preserves input order and removes duplicate IDs.",
    kind: "read",
    approval: "none",
    args: softwareResolveArgsSchema,
    example: { applications: ["cursor", "vsc"] },
    execution: { type: "handler", handler: "software.resolve.registered" },
  },
  {
    ...common,
    id: "software.launch",
    effect: "launch",
    aliases: ["start", "run"],
    description:
      "Launch one explicitly registered application with its trusted argument template and a registered project folder. Reports OS spawn, not GUI readiness. Model launches require approval.",
    kind: "mutation",
    approval: "required",
    args: softwareLaunchArgsSchema,
    example: { application: "vsc", project: "watcher" },
    preparation: "software.launch.prepare",
    execution: { type: "process", process: "software.launch.registered" },
  },
];
export function projectOpeningBindings(
  resolveDatabase: () => DatabaseSync,
): TrustedCommandBindings {
  return {
    handlers: {
      "projects.resolve.registered": (args) => {
        const project = resolveRegisteredProject(
          resolveDatabase(),
          String(args.project),
        );
        const selected = args.applications as string[];
        const applications = selected.length
          ? selected
          : project.defaultApplicationId
            ? [project.defaultApplicationId]
            : [];
        if (!Array.isArray(applications) || applications.length === 0)
          throw new CommandFailure(
            "default_application_missing",
            "Choose applications or configure this project's default application.",
          );
        return {
          action: "projects.resolve",
          status: "success",
          summary: `Resolved ${project.name}.`,
          data: {
            id: project.id,
            path: project.path,
            applications: applications as string[],
          },
        };
      },
      "software.resolve.registered": (args) => {
        const applications = resolveRegisteredApplications(
          resolveDatabase(),
          args.applications as string[],
        );
        return {
          action: "software.resolve",
          status: "success",
          summary: `Resolved ${applications.length} registered applications.`,
          data: {
            applications: applications.map((app) => ({
              id: app.id,
              name: app.name,
            })),
          },
        };
      },
    },
    processes: {
      "software.launch.registered": (args, context) =>
        launchRegisteredApplication(resolveDatabase(), args, context),
    },
    preparers: {
      "software.launch.prepare": (args) =>
        materializeRegisteredLaunch(resolveDatabase(), args).preparation,
    },
    aggregators: {
      "projects.open.receipts": (action, children) => {
        const launches = children.filter(
          (child) => child.action === "software.launch",
        );
        const failed = children.find((child) => child.status !== "success");
        return {
          action,
          status: failed?.status ?? "success",
          ...(failed?.code ? { code: failed.code } : {}),
          summary: failed
            ? `Operation failed: ${failed.summary}`.slice(0, 500)
            : `${launches.length} application${launches.length === 1 ? "" : "s"} started.`,
          data: {
            launches: launches.map((child) => ({
              status: child.status,
              summary: child.summary,
              receiptId: child.receiptId ?? null,
              data: child.data ?? null,
            })),
          },
        };
      },
    },
  };
}
