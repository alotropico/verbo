import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

import {
  type EntitySaveResult,
  type ProjectImportSettings,
} from "../../shared/application-registration";

export function readProjectImportSettings(
  _database: DatabaseSync,
): ProjectImportSettings {
  void _database; // Retain the existing app-facing signature; storage belongs to Alo.

  return aloData("settings.project-import.read");
}

export function saveProjectImportSettings(
  _database: DatabaseSync,
  input: unknown,
): EntitySaveResult {
  return aloData("settings.project-import.save", input);
}
