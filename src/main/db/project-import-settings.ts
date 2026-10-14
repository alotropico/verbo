import type { DatabaseSync } from "node:sqlite";
import {
  projectImportSettingsSchema,
  type ProjectImportSettings,
  type EntitySaveResult,
} from "../../shared/application-registration";

export function readProjectImportSettings(
  database: DatabaseSync,
): ProjectImportSettings {
  try {
    const row = database
      .prepare("SELECT value_json FROM project_import_settings WHERE id=1")
      .get();
    const parsed = projectImportSettingsSchema.safeParse(
      row ? JSON.parse(String(row.value_json)) : null,
    );
    if (parsed.success) return parsed.data;
  } catch {
    /* Invalid saved preferences retain safe defaults. */
  }
  return { enabled: false, applicationIds: [] };
}

export function saveProjectImportSettings(
  database: DatabaseSync,
  input: unknown,
): EntitySaveResult {
  const parsed = projectImportSettingsSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      code: "invalid_preferences",
      summary: "Select up to 16 applications for imported projects.",
    };
  const available = new Set(
    database
      .prepare("SELECT id FROM registered_applications")
      .all()
      .map((row) => String(row.id)),
  );
  if (parsed.data.applicationIds.some((id) => !available.has(id)))
    return {
      ok: false,
      code: "invalid_application",
      summary: "Choose registered applications.",
    };
  database
    .prepare(
      "INSERT INTO project_import_settings(id,value_json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json",
    )
    .run(JSON.stringify(parsed.data));
  return { ok: true, summary: "Project import preferences saved." };
}
