import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  applicationRegistrationSchema,
  projectPreferencesSchema,
  type EntitySaveResult,
  type EntitySettings,
  type RegisteredApplication,
  type RegisteredProject,
} from "../../shared/application-registration";
import { createRootStore } from "./registered-roots";
import { executableIdentity } from "../software/executable-identity";
import {
  readProjectImportSettings,
  saveProjectImportSettings,
} from "./project-import-settings";

export function readEntitySettings(database: DatabaseSync): EntitySettings {
  const projects = createRootStore(database, "registered_projects", "project")
    .list()
    .map((root): RegisteredProject => {
      const row = database
        .prepare(
          "SELECT value_json FROM project_preferences WHERE project_id=?",
        )
        .get(root.id);
      let parsed: ReturnType<typeof projectPreferencesSchema.safeParse> | null =
        null;
      try {
        parsed = row
          ? projectPreferencesSchema.safeParse(
              JSON.parse(String(row.value_json)),
            )
          : null;
      } catch {
        /* Invalid preferences retain safe defaults. */
      }
      return {
        ...root,
        ...(parsed?.success
          ? parsed.data
          : {
              name: root.alias,
              aliases: [],
              enabled: !row,
              defaultApplicationId: null,
              favoriteApplicationIds: [],
            }),
      };
    });
  const applications = database
    .prepare(
      "SELECT id, value_json, executable_identity, updated_at FROM registered_applications ORDER BY rowid",
    )
    .all()
    .flatMap((row): RegisteredApplication[] => {
      try {
        const parsed = applicationRegistrationSchema.safeParse(
          JSON.parse(String(row.value_json)),
        );
        return parsed.success
          ? [
              {
                ...parsed.data,
                id: String(row.id),
                executableIdentity: String(row.executable_identity),
                updatedAt: Number(row.updated_at),
                trust: "user-registered",
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
  return {
    projects,
    applications,
    projectImport: readProjectImportSettings(database),
  };
}

export function saveApplicationRegistration(
  database: DatabaseSync,
  input: unknown,
): EntitySaveResult {
  const parsed = applicationRegistrationSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      code: "invalid_registration",
      summary: parsed.error.issues[0]?.message ?? "Invalid application.",
    };
  const value = parsed.data;
  try {
    const checked = executableIdentity(value.executable);
    const current = readEntitySettings(database).applications;
    if (value.id && !current.some((app) => app.id === value.id))
      throw new Error("That application no longer exists.");
    if (
      current.some(
        (app) =>
          app.id !== value.id &&
          app.aliases.some((alias) => value.aliases.includes(alias)),
      )
    )
      throw new Error("An application alias is already registered.");
    const id = value.id ?? randomUUID();
    database
      .prepare(
        `INSERT INTO registered_applications(id,value_json,executable_identity,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,executable_identity=excluded.executable_identity,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        JSON.stringify({ ...value, id, executable: checked.path }),
        checked.identity,
        Date.now(),
      );
    return {
      ok: true,
      summary:
        "Application registered. Model launches still require confirmation.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "invalid_registration",
      summary:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Application could not be registered.",
    };
  }
}
export function saveProjectPreferences(
  database: DatabaseSync,
  input: unknown,
): EntitySaveResult {
  const parsed = projectPreferencesSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      code: "invalid_preferences",
      summary: parsed.error.issues[0]?.message ?? "Invalid project settings.",
    };
  const settings = readEntitySettings(database);
  const value = parsed.data;
  const project = settings.projects.find((item) => item.id === value.id);
  if (!project)
    return {
      ok: false,
      code: "missing",
      summary: "That project no longer exists.",
    };
  if (
    value.aliases.includes(project.alias) ||
    settings.projects.some(
      (item) =>
        item.id !== project.id &&
        [item.alias, ...item.aliases].some((alias) =>
          value.aliases.includes(alias),
        ),
    )
  )
    return {
      ok: false,
      code: "duplicate_alias",
      summary: "A project alias is already registered.",
    };
  const appIds = [
    ...value.favoriteApplicationIds,
    ...(value.defaultApplicationId ? [value.defaultApplicationId] : []),
  ];
  if (
    appIds.some(
      (id) =>
        !settings.applications.some(
          (app) =>
            app.id === id &&
            app.enabled &&
            app.supportedTargets.includes("folder"),
        ),
    )
  )
    return {
      ok: false,
      code: "invalid_application",
      summary: "Choose enabled applications that support folders.",
    };
  database
    .prepare(
      `INSERT INTO project_preferences(project_id,value_json) VALUES (?,?)
    ON CONFLICT(project_id) DO UPDATE SET value_json=excluded.value_json`,
    )
    .run(value.id, JSON.stringify(value));
  return {
    ok: true,
    summary: "Project settings saved. File permissions are unchanged.",
  };
}
export function removeApplicationRegistration(
  database: DatabaseSync,
  id: string,
): EntitySaveResult {
  const settings = readEntitySettings(database);
  if (
    settings.projects.some(
      (project) =>
        project.defaultApplicationId === id ||
        project.favoriteApplicationIds.includes(id),
    )
  )
    return {
      ok: false,
      code: "application_in_use",
      summary:
        "Remove the application from project defaults and favorites first.",
    };
  const result = database
    .prepare("DELETE FROM registered_applications WHERE id=?")
    .run(id);
  if (result.changes) {
    const preferences = readProjectImportSettings(database);
    saveProjectImportSettings(database, {
      ...preferences,
      applicationIds: preferences.applicationIds.filter(
        (applicationId) => applicationId !== id,
      ),
    });
  }
  return result.changes
    ? { ok: true, summary: "Application removed." }
    : {
        ok: false,
        code: "missing",
        summary: "That application no longer exists.",
      };
}
