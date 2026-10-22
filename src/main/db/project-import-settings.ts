import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

import { type EntitySaveResult, type ProjectImportSettings } from "../../shared/application-registration";

export async function readProjectImportSettings(_database: DatabaseSync): Promise<ProjectImportSettings> {
  void _database; // Retain the existing app-facing signature; storage belongs to Alo.

  return await aloData("settings.project-import.read");
}

export async function saveProjectImportSettings(_database: DatabaseSync, input: unknown): Promise<EntitySaveResult> {
  return await aloData("settings.project-import.save", input);
}
