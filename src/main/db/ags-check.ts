import type { DatabaseSync } from "node:sqlite";
import { agsExecutableAllowed } from "../../shared/ags";
import { displayFinalPath } from "../../shared/files";
import { isProtectedLocation } from "../files/path-policy";
import { describeExistingPath } from "../files/windows-containment";

export type AgsCheckConfig = {
  configured: boolean;
  path: string | null;
};

export function readAgsCheck(database: DatabaseSync): AgsCheckConfig {
  const row = database
    .prepare(`SELECT executable_path FROM ags_check_command WHERE id = 1`)
    .get() as { executable_path: string } | undefined;
  if (!row) return { configured: false, path: null };
  return { configured: true, path: row.executable_path };
}

export function clearAgsCheck(database: DatabaseSync): void {
  database.prepare(`DELETE FROM ags_check_command WHERE id = 1`).run();
}

export function saveAgsCheck(
  database: DatabaseSync,
  candidate: string,
): { ok: true; path: string } | { ok: false; code: string; summary: string } {
  if (!agsExecutableAllowed(candidate)) {
    return {
      ok: false,
      code: "not_allowlisted",
      summary: "The check command must be an ags, ags.exe, or ags.cmd file.",
    };
  }
  const described = describeExistingPath(candidate);
  if (!described.ok || described.directory) {
    return {
      ok: false,
      code: "not_file",
      summary: "Choose the ags executable file.",
    };
  }
  if (isProtectedLocation(described.finalPath)) {
    return {
      ok: false,
      code: "protected",
      summary: "That location is protected.",
    };
  }
  const path = displayFinalPath(described.finalPath);
  if (!agsExecutableAllowed(path)) {
    return {
      ok: false,
      code: "not_allowlisted",
      summary: "The check command must be an ags, ags.exe, or ags.cmd file.",
    };
  }
  database
    .prepare(
      `INSERT INTO ags_check_command (id, executable_path) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET executable_path = excluded.executable_path`,
    )
    .run(path);
  return { ok: true, path };
}
