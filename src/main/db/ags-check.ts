import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

export type AgsCheckConfig = {
  configured: boolean;
  path: string | null;
  identity: string | null;
};

export function readAgsCheck(_database: DatabaseSync): AgsCheckConfig {
  void _database; // Retain the existing app-facing signature; storage belongs to Alo.

  return aloData("settings.ags-check.read");
}

export function clearAgsCheck(_database: DatabaseSync): void {
  void _database; // Retain the existing app-facing signature; storage belongs to Alo.

  aloData("settings.ags-check.clear");
  return;
}

export function saveAgsCheck(
  _database: DatabaseSync,
  candidate: string,
): { ok: true; path: string } | { ok: false; code: string; summary: string } {
  return aloData("settings.ags-check.save", { path: candidate });
}
