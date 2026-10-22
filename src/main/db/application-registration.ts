import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

import { type EntitySaveResult, type EntitySettings } from "../../shared/application-registration";

export async function readEntitySettings(_database: DatabaseSync): Promise<EntitySettings> {
  void _database; // Retain the existing app-facing signature; storage belongs to Alo.

  return await aloData("settings.entities.read");
}

export async function saveApplicationRegistration(_database: DatabaseSync, input: unknown): Promise<EntitySaveResult> {
  return await aloData("settings.applications.save", input);
}

export async function saveProjectPreferences(_database: DatabaseSync, input: unknown): Promise<EntitySaveResult> {
  return await aloData("settings.project-preferences.save", input);
}

export async function removeApplicationRegistration(_database: DatabaseSync, id: string): Promise<EntitySaveResult> {
  return await aloData("settings.applications.remove", { id });
}
