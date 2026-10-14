import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_WEB_SETTINGS,
  webSettingsSchema,
  type WebSettings,
} from "../../shared/web-contracts";
import { browserExecutable } from "../../shared/browser-executable";

export function readWebSettings(database: DatabaseSync): WebSettings {
  const row = database
    .prepare(
      "SELECT value_json FROM command_module_settings WHERE module_id = 'web'",
    )
    .get() as { value_json: string } | undefined;
  if (!row)
    return {
      ...DEFAULT_WEB_SETTINGS,
      engines: [...DEFAULT_WEB_SETTINGS.engines],
    };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(row.value_json);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return DEFAULT_WEB_SETTINGS;
  } catch {
    return DEFAULT_WEB_SETTINGS;
  }
  // A corrupt field does not erase other valid user preferences.
  return Object.fromEntries(
    Object.entries(webSettingsSchema.shape).map(([key, schema]) => {
      const parsed = schema.safeParse(raw[key]);
      return [
        key,
        parsed.success
          ? parsed.data
          : DEFAULT_WEB_SETTINGS[key as keyof WebSettings],
      ];
    }),
  ) as WebSettings;
}
export function saveWebSettings(
  database: DatabaseSync,
  raw: unknown,
): { ok: true } | { ok: false; summary: string } {
  const parsed = webSettingsSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      summary: parsed.error.issues[0]?.message ?? "Invalid Web settings.",
    };
  if (parsed.data.executable) {
    try {
      browserExecutable(parsed.data.executable);
    } catch {
      return {
        ok: false,
        summary: "Choose an installed Chrome or Edge executable.",
      };
    }
  }
  database
    .prepare(
      "INSERT INTO command_module_settings(module_id, version, value_json, updated_at) VALUES ('web', 1, ?, ?) ON CONFLICT(module_id) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
    )
    .run(JSON.stringify(parsed.data), Date.now());
  return { ok: true };
}
