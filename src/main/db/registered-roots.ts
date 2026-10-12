import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { displayFinalPath, scopeAliasSchema } from "../../shared/files";
import type { RegisteredRoot } from "../../shared/projects";
import { isProtectedLocation } from "../files/path-policy";
import { describeExistingPath } from "../files/windows-containment";

type RootRow = {
  id: string;
  alias: string;
  canonical_path: string;
  created_at: number;
};

export type RootFailure = { ok: false; code: string; summary: string };
export type RootSuccess = { ok: true; summary: string; root: RegisteredRoot };

export type RootStore = {
  list: () => RegisteredRoot[];
  add: (alias: string, candidate: string) => RootFailure | RootSuccess;
  remove: (id: string) => RootFailure | { ok: true; summary: string };
};

function mapRoot(row: RootRow): RegisteredRoot {
  return {
    id: row.id,
    alias: row.alias,
    path: row.canonical_path,
    createdAt: row.created_at,
  };
}

function failure(code: string, summary: string): RootFailure {
  return { ok: false, code, summary };
}

function samePath(left: string, right: string): boolean {
  return (
    displayFinalPath(left).replace(/[\\/]+$/u, "").toLowerCase() ===
    displayFinalPath(right).replace(/[\\/]+$/u, "").toLowerCase()
  );
}

export function createRootStore(
  database: DatabaseSync,
  table: "registered_projects" | "ags_hosts",
  noun: string,
): RootStore {
  const listed = database.prepare(
    `SELECT id, alias, canonical_path, created_at FROM ${table} ORDER BY alias`,
  );
  const inserted = database.prepare(
    `INSERT INTO ${table} (id, alias, canonical_path, created_at) VALUES (?, ?, ?, ?)`,
  );
  const removed = database.prepare(`DELETE FROM ${table} WHERE id = ?`);

  return {
    list(): RegisteredRoot[] {
      return (listed.all() as RootRow[]).map(mapRoot);
    },
    add(alias: string, candidate: string): RootFailure | RootSuccess {
      const parsed = scopeAliasSchema.safeParse(alias);
      if (!parsed.success) {
        return failure("invalid_alias", "Use a short lowercase alias.");
      }
      const described = describeExistingPath(candidate);
      if (!described.ok) {
        return failure("invalid_path", "That folder could not be opened.");
      }
      if (!described.directory) {
        return failure("not_directory", "Choose a folder.");
      }
      if (isProtectedLocation(described.finalPath)) {
        return failure("protected", "That location is protected.");
      }
      const path = displayFinalPath(described.finalPath);
      const current = (listed.all() as RootRow[]).map(mapRoot);
      if (current.some((item) => item.alias === parsed.data)) {
        return failure("duplicate_alias", `That ${noun} alias is already used.`);
      }
      if (current.some((item) => samePath(item.path, path))) {
        return failure("duplicate_path", `That ${noun} folder is already registered.`);
      }
      const root: RegisteredRoot = {
        id: randomUUID(),
        alias: parsed.data,
        path,
        createdAt: Date.now(),
      };
      inserted.run(root.id, root.alias, root.path, root.createdAt);
      return {
        ok: true,
        summary: `Registered ${root.alias}. This does not grant write access.`,
        root,
      };
    },
    remove(id: string): RootFailure | { ok: true; summary: string } {
      const existing = (listed.all() as RootRow[]).find((row) => row.id === id);
      if (!existing) return failure("missing", `That ${noun} is not registered.`);
      removed.run(id);
      return { ok: true, summary: `Removed ${existing.alias}.` };
    },
  };
}
