import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

export type AgsCheckConfig = {
  configured: boolean;
  path: string | null;
  identity: string | null;
};

export async function readAgsCheck(_database: DatabaseSync): Promise<AgsCheckConfig> {
  void _database; // Retain the existing app-facing signature; storage belongs to Alo.

  return await aloData("settings.ags-check.read");
}

export async function clearAgsCheck(_database: DatabaseSync): Promise<void> {
  void _database; // Retain the existing app-facing signature; storage belongs to Alo.

  await aloData("settings.ags-check.clear");
  return;
}

export async function saveAgsCheck(
  _database: DatabaseSync,
  candidate: string,
): Promise<{ ok: true; path: string } | { ok: false; code: string; summary: string }> {
  return await aloData("settings.ags-check.save", { path: candidate });
}
