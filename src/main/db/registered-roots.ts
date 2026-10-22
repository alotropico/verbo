import { createAloRootStore } from "../alo/data-client";
import type { AsyncMethods } from "../alo/async";

import type { DatabaseSync } from "node:sqlite";

import type { RegisteredRoot } from "../../shared/projects";

export type RootFailure = { ok: false; code: string; summary: string };

export type RootSuccess = { ok: true; summary: string; root: RegisteredRoot };

export type RootStore = {
  list: () => RegisteredRoot[];
  add: (alias: string, candidate: string) => RootFailure | RootSuccess;
  remove: (id: string) => RootFailure | { ok: true; summary: string };
};

export function createRootStore(
  _database: DatabaseSync,
  table: "registered_projects" | "ags_hosts",
  _noun: string,
): AsyncMethods<RootStore> {
  void _noun; // Retain the existing app-facing signature; storage belongs to Alo.

  return createAloRootStore(table);
}
