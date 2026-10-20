import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

import {
  type EntitySaveResult,
  type EntitySettings,
} from "../../shared/application-registration";

export function readEntitySettings(_database: DatabaseSync): EntitySettings {
  void _database; // Retain the existing app-facing signature; storage belongs to Alo.

  return aloData("settings.entities.read");
}

export function saveApplicationRegistration(
  _database: DatabaseSync,
  input: unknown,
): EntitySaveResult {
  return aloData("settings.applications.save", input);
}

export function saveProjectPreferences(
  _database: DatabaseSync,
  input: unknown,
): EntitySaveResult {
  return aloData("settings.project-preferences.save", input);
}

export function removeApplicationRegistration(
  _database: DatabaseSync,
  id: string,
): EntitySaveResult {
  return aloData("settings.applications.remove", { id });
}
