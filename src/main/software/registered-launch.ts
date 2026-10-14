import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  RegisteredApplication,
  RegisteredProject,
} from "../../shared/application-registration";
import { displayFinalPath } from "../../shared/files";
import { readEntitySettings } from "../db/application-registration";
import { describeExistingPath } from "../files/windows-containment";
import { executableIdentity } from "./executable-identity";
import type { ActionContext } from "../capabilities/registry";
import type { EffectPreparation } from "../capabilities/preparation";
import type { ActionResult } from "../../shared/action-contract";
import { CommandFailure } from "../capabilities/command-failure";

function selectEntity<
  T extends { id: string; name: string; aliases: string[]; enabled: boolean },
>(entities: T[], selector: string): T {
  const exact = entities.find((entity) => entity.id === selector);
  const matches = exact
    ? [exact]
    : entities.filter((entity) =>
        [entity.name, ...entity.aliases].some(
          (value) => value.toLowerCase() === selector.toLowerCase(),
        ),
      );
  if (matches.length !== 1)
    throw new CommandFailure(
      matches.length ? "ambiguous_entity" : "not_registered",
      matches.length
        ? "That name is ambiguous; use its registered ID."
        : "That entity is not registered.",
    );
  if (!matches[0]!.enabled)
    throw new CommandFailure(
      "registration_disabled",
      "That registration is disabled.",
    );
  return matches[0]!;
}
export function resolveRegisteredProject(
  database: DatabaseSync,
  selector: string,
): RegisteredProject & { identity: string } {
  const project = selectEntity(
    readEntitySettings(database).projects.map((project) => ({
      ...project,
      aliases: [project.alias, ...project.aliases],
    })),
    selector,
  );
  const described = describeExistingPath(project.path);
  if (
    !described.ok ||
    !described.directory ||
    displayFinalPath(described.finalPath).toLowerCase() !==
      displayFinalPath(project.path).toLowerCase()
  )
    throw new CommandFailure(
      "project_unavailable",
      "The registered project folder changed or is unavailable.",
    );
  const stat = statSync(project.path);
  return {
    ...project,
    identity: `${project.path.toLowerCase()}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
  };
}
export function resolveRegisteredApplications(
  database: DatabaseSync,
  selectors: string[],
): RegisteredApplication[] {
  const apps = readEntitySettings(database).applications;
  const resolved = selectors.map((selector) => selectEntity(apps, selector));
  const seen = new Set<string>();
  return resolved
    .filter((app) => {
      if (seen.has(app.id)) return false;
      seen.add(app.id);
      return true;
    })
    .map((app) => {
      if (!app.supportedPlatforms.includes(process.platform as "win32"))
        throw new CommandFailure(
          "unsupported_platform",
          "That application is unsupported on this platform.",
        );
      let current: ReturnType<typeof executableIdentity>;
      try {
        current = executableIdentity(app.executable);
      } catch {
        throw new CommandFailure(
          "executable_unavailable",
          "The registered executable is no longer available. Register it again before launching.",
        );
      }
      if (current.identity !== app.executableIdentity)
        throw new CommandFailure(
          "executable_changed",
          "The registered executable changed. Register it again before launching.",
        );
      return app;
    });
}
export function materializeRegisteredLaunch(
  database: DatabaseSync,
  args: Record<string, unknown>,
): {
  project: RegisteredProject;
  application: RegisteredApplication;
  executable: string;
  argv: string[];
  cwd?: string;
  preparation: EffectPreparation;
} {
  const project = resolveRegisteredProject(database, String(args.project));
  const application = resolveRegisteredApplications(database, [
    String(args.application),
  ])[0]!;
  if (!application.supportedTargets.includes("folder"))
    throw new CommandFailure(
      "unsupported_target",
      "That application does not support project folders.",
    );
  const argv = application.launchArguments.map((binding) =>
    "literal" in binding ? binding.literal : project.path,
  );
  if (
    argv.some((value) => value.includes("\0") || value.length > 32768) ||
    argv.reduce((total, value) => total + value.length, 0) > 30000
  )
    throw new CommandFailure(
      "argument_limit",
      "The application arguments exceed their limit.",
    );
  const cwd =
    application.cwdPolicy === "project"
      ? project.path
      : application.cwdPolicy === "application"
        ? dirname(application.executable)
        : undefined;
  return {
    project,
    application,
    executable: application.executable,
    argv,
    ...(cwd ? { cwd } : {}),
    preparation: {
      automatic: true,
      risks: [
        "Starts registered applications with the reviewed project and fixed arguments.",
      ],
      summary: `Open ${project.name} in ${application.name}.`,
      snapshot: {
        application: {
          id: application.id,
          executable: application.executable,
          identity: application.executableIdentity,
          enabled: application.enabled,
          supportedTargets: application.supportedTargets,
          supportedPlatforms: application.supportedPlatforms,
          launchArguments: application.launchArguments,
          cwdPolicy: application.cwdPolicy,
        },
        project: {
          id: project.id,
          path: project.path,
          identity: project.identity,
          enabled: project.enabled,
          defaultApplicationId: project.defaultApplicationId,
          favoriteApplicationIds: project.favoriteApplicationIds,
        },
        argv,
        cwd: cwd ?? null,
      },
      details: JSON.stringify(
        {
          application: application.name,
          executable: application.executable,
          project: project.name,
          target: project.path,
          arguments: argv,
          workingDirectory: cwd ?? "system default",
        },
        null,
        2,
      ),
    },
  };
}

/** Receipt attests to OS spawn only; a GUI's readiness and eventual exit are not claimed. */
export async function launchRegisteredApplication(
  database: DatabaseSync,
  args: Record<string, unknown>,
  context: ActionContext,
): Promise<ActionResult> {
  const launch = materializeRegisteredLaunch(database, args);
  const failure = (code: string, summary: string): ActionResult => ({
    action: "software.launch",
    status: code === "cancelled" ? "cancelled" : "error",
    code,
    summary,
  });
  if (context.signal?.aborted)
    return failure("cancelled", "The launch was cancelled before starting.");
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return new Promise<ActionResult>((resolve) => {
    let settled = false;
    const child = spawn(launch.executable, launch.argv, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      env,
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
    });
    const finish = (result: ActionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = (): void => {
      child.kill();
      finish(
        failure(
          "cancelled",
          "The launch was cancelled before spawn completed.",
        ),
      );
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        failure(
          "spawn_timeout",
          "The application did not report a completed spawn.",
        ),
      );
    }, 5000);
    child.once("error", () =>
      finish(
        failure("spawn_failed", "The registered application could not start."),
      ),
    );
    child.once("spawn", () => {
      child.unref();
      finish({
        action: "software.launch",
        status: "success",
        summary: `Started ${launch.application.name} for ${launch.project.name}.`,
        data: {
          applicationId: launch.application.id,
          projectId: launch.project.id,
          pid: child.pid ?? null,
          evidence: "os_spawn",
        },
      });
    });
    context.signal?.addEventListener("abort", cancel, { once: true });
    if (context.signal?.aborted) cancel();
  });
}
