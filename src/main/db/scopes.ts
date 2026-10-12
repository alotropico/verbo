import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActorKind } from "../../shared/action-contract";
import {
  displayFinalPath,
  scopeAliasListSchema,
  splitScopeAliases,
  type FileGrantKind,
  type FileGrantRecord,
  type FileScopeProposal,
  type FileScopeRecord,
} from "../../shared/files";
import {
  DEFAULT_SCOPE_ALIAS,
  proposedDefaultDirectory,
} from "../files/default-scope";
import { isProtectedLocation } from "../files/path-policy";
import { describeExistingPath } from "../files/windows-containment";

type ScopeRow = {
  id: string;
  alias: string;
  extra_aliases: string;
  canonical_path: string;
  can_read: number;
  can_write: number;
  is_default: number;
  created_at: number;
  updated_at: number;
};

type GrantRow = {
  id: string;
  kind: FileGrantKind;
  canonical_path: string;
  thread_id: string | null;
  created_at: number;
  expires_at: number;
};

export type ScopeAddition = {
  alias: string;
  path: string;
  read: boolean;
  write: boolean;
  defaultSave: boolean;
};

export type ScopeUpdate = {
  id: string;
  alias: string;
  read: boolean;
  write: boolean;
  defaultSave: boolean;
};

export type ScopeFailure = {
  ok: false;
  code: string;
  summary: string;
};

export type ScopeSuccess = {
  ok: true;
  summary: string;
  scopes: FileScopeRecord[];
};

export type ScopeStore = {
  list: () => FileScopeRecord[];
  proposal: (projectRoot?: string) => FileScopeProposal;
  generation: () => number;
  apply: (input: {
    removeIds: readonly string[];
    updates: readonly ScopeUpdate[];
    additions: readonly ScopeAddition[];
  }) => ScopeFailure | ScopeSuccess;
  issueReadGrant: (input: {
    actor: ActorKind;
    kind: FileGrantKind;
    path: string;
    threadId?: string;
  }) => ScopeFailure | { ok: true; summary: string; grant: FileGrantRecord };
  activeGrants: () => FileGrantRecord[];
};

const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

function failure(code: string, summary: string): ScopeFailure {
  return { ok: false, code, summary };
}

function mapScope(row: ScopeRow): FileScopeRecord {
  const aliases = [row.alias, ...splitScopeAliases(row.extra_aliases ?? "")];
  return {
    id: row.id,
    alias: row.alias,
    aliases,
    path: row.canonical_path,
    read: row.can_read === 1,
    write: row.can_write === 1,
    defaultSave: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGrant(row: GrantRow): FileGrantRecord {
  return {
    id: row.id,
    kind: row.kind,
    path: row.canonical_path,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function flags(
  read: boolean,
  write: boolean,
): ScopeFailure | { read: true; write: boolean } {
  if (write && !read) {
    return failure("write_requires_read", "Write access includes read access.");
  }
  if (!read && !write) {
    return failure("empty_permission", "A folder needs read or write access.");
  }
  return { read: true, write };
}

export function createScopeStore(
  database: DatabaseSync,
  options?: { now?: () => number },
): ScopeStore {
  const now = options?.now ?? Date.now;

  function list(): FileScopeRecord[] {
    const rows = database
      .prepare(
        `SELECT id, alias, extra_aliases, canonical_path, can_read, can_write, is_default, created_at, updated_at
         FROM file_scopes
         ORDER BY alias`,
      )
      .all() as ScopeRow[];
    return rows.map(mapScope);
  }

  function bump(): void {
    database
      .prepare(
        `UPDATE file_scope_generation SET version = version + 1 WHERE id = 1`,
      )
      .run();
  }

  function checkedAlias(
    alias: string,
  ): ScopeFailure | { alias: string; aliases: string[] } {
    const parsed = scopeAliasListSchema.safeParse(alias);
    if (!parsed.success) {
      return failure(
        "alias_invalid",
        parsed.error.issues[0]?.message ?? "Use a short lowercase alias.",
      );
    }
    const aliases = splitScopeAliases(parsed.data);
    if (
      aliases.some((name) =>
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(name),
      )
    ) {
      return failure("alias_invalid", "Use a short lowercase alias.");
    }
    return { alias: aliases[0] ?? parsed.data, aliases };
  }

  function checkedDirectory(path: string): ScopeFailure | { path: string } {
    if (isProtectedLocation(path)) {
      return failure("protected", "That location is protected.");
    }
    const described = describeExistingPath(path);
    if (!described.ok) {
      return failure(
        described.code,
        described.code === "missing"
          ? "That folder does not exist."
          : "That folder could not be opened.",
      );
    }
    if (!described.directory) {
      return failure("not_directory", "Choose a folder, not a file.");
    }
    if (isProtectedLocation(described.finalPath)) {
      return failure("protected", "That location is protected.");
    }
    return { path: displayFinalPath(described.finalPath) };
  }

  return {
    list,
    proposal(projectRoot = process.cwd()): FileScopeProposal {
      const path = proposedDefaultDirectory(projectRoot);
      return {
        alias: DEFAULT_SCOPE_ALIAS,
        path,
        saved: list().some(
          (scope) =>
            scope.aliases.includes(DEFAULT_SCOPE_ALIAS) ||
            scope.path.toLowerCase() === path.toLowerCase(),
        ),
      };
    },
    generation(): number {
      const row = database
        .prepare(`SELECT version FROM file_scope_generation WHERE id = 1`)
        .get() as { version: number };
      return row.version;
    },
    apply(input): ScopeFailure | ScopeSuccess {
      const current = list();
      const removed = new Set(input.removeIds);
      if (
        input.removeIds.some((id) => !current.some((scope) => scope.id === id))
      ) {
        return failure(
          "unknown_scope",
          "That folder registration was not found.",
        );
      }
      const updates = new Map(
        input.updates.map((update) => [update.id, update]),
      );
      for (const update of input.updates) {
        if (
          !current.some((scope) => scope.id === update.id) ||
          removed.has(update.id)
        ) {
          return failure(
            "unknown_scope",
            "That folder registration was not found.",
          );
        }
      }
      const next: Array<FileScopeRecord | ScopeAddition> = [];
      for (const scope of current) {
        if (removed.has(scope.id)) continue;
        const update = updates.get(scope.id);
        if (!update) {
          next.push(scope);
          continue;
        }
        const alias = checkedAlias(update.alias);
        if ("ok" in alias) return alias;
        const access = flags(update.read, update.write);
        if ("ok" in access) return access;
        next.push({
          ...scope,
          alias: alias.alias,
          aliases: alias.aliases,
          read: access.read,
          write: access.write,
          defaultSave: update.defaultSave,
        });
      }
      const additions: Array<ScopeAddition & { path: string }> = [];
      for (const addition of input.additions) {
        const alias = checkedAlias(addition.alias);
        if ("ok" in alias) return alias;
        const access = flags(addition.read, addition.write);
        if ("ok" in access) return access;
        const directory = checkedDirectory(addition.path);
        if ("ok" in directory) return directory;
        additions.push({
          alias: alias.aliases.join(", "),
          path: directory.path,
          read: access.read,
          write: access.write,
          defaultSave: addition.defaultSave,
        });
      }
      const aliases = [
        ...next.flatMap((scope) =>
          "aliases" in scope ? scope.aliases : splitScopeAliases(scope.alias),
        ),
        ...additions.flatMap((scope) => splitScopeAliases(scope.alias)),
      ];
      if (new Set(aliases).size !== aliases.length) {
        return failure("alias_taken", "That alias is already used.");
      }
      const paths = [
        ...next.map((scope) => scope.path),
        ...additions.map((scope) => scope.path),
      ].map((path) => path.toLowerCase());
      if (new Set(paths).size !== paths.length) {
        return failure("duplicate_path", "That folder is already registered.");
      }
      const defaults =
        next.filter((scope) => scope.defaultSave).length +
        additions.filter((scope) => scope.defaultSave).length;
      if (defaults > 1) {
        return failure(
          "default_conflict",
          "Only one folder can be the default save location.",
        );
      }
      const stamp = now();
      database.exec("BEGIN");
      try {
        const remove = database.prepare(`DELETE FROM file_scopes WHERE id = ?`);
        for (const id of removed) remove.run(id);
        const update = database.prepare(
          `UPDATE file_scopes
           SET alias = ?, extra_aliases = ?, can_read = ?, can_write = ?, is_default = ?, updated_at = ?
           WHERE id = ?`,
        );
        for (const scope of next) {
          if (!("id" in scope)) continue;
          if (!updates.has(scope.id)) continue;
          update.run(
            scope.alias,
            scope.aliases.slice(1).join(", "),
            scope.read ? 1 : 0,
            scope.write ? 1 : 0,
            scope.defaultSave ? 1 : 0,
            stamp,
            scope.id,
          );
        }
        const insert = database.prepare(
          `INSERT INTO file_scopes (
             id, alias, extra_aliases, canonical_path, can_read, can_write, is_default, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const addition of additions) {
          const names = splitScopeAliases(addition.alias);
          insert.run(
            randomUUID(),
            names[0],
            names.slice(1).join(", "),
            addition.path,
            addition.read ? 1 : 0,
            addition.write ? 1 : 0,
            addition.defaultSave ? 1 : 0,
            stamp,
            stamp,
          );
        }
        if (removed.size > 0 || updates.size > 0 || additions.length > 0)
          bump();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return {
        ok: true,
        summary: "Saved folder registrations.",
        scopes: list(),
      };
    },
    issueReadGrant(input) {
      if (input.actor === "model") {
        return failure(
          "grant_denied",
          "The model cannot grant itself a path. Select the file or folder.",
        );
      }
      if (isProtectedLocation(input.path)) {
        return failure("protected", "That location is protected.");
      }
      const described = describeExistingPath(input.path);
      if (!described.ok) {
        return failure(
          described.code,
          described.code === "missing"
            ? "That path does not exist."
            : "That path could not be opened.",
        );
      }
      if (input.kind === "file" && described.directory) {
        return failure(
          "not_file",
          "That selection is a folder. Choose the file.",
        );
      }
      if (input.kind === "directory" && !described.directory) {
        return failure(
          "not_directory",
          "That selection is a file. Choose the folder.",
        );
      }
      const stamp = now();
      const grant: FileGrantRecord = {
        id: randomUUID(),
        kind: input.kind,
        path: displayFinalPath(described.finalPath),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        createdAt: stamp,
        expiresAt: stamp + GRANT_TTL_MS,
      };
      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO file_read_grants (
               id, kind, canonical_path, thread_id, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            grant.id,
            grant.kind,
            grant.path,
            grant.threadId ?? null,
            grant.createdAt,
            grant.expiresAt,
          );
        bump();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return {
        ok: true,
        summary: "Saved a bounded read for the selection.",
        grant,
      };
    },
    activeGrants(): FileGrantRecord[] {
      const stamp = now();
      const expired = database
        .prepare(`DELETE FROM file_read_grants WHERE expires_at <= ?`)
        .run(stamp);
      if (expired.changes > 0) bump();
      const rows = database
        .prepare(
          `SELECT id, kind, canonical_path, thread_id, created_at, expires_at
           FROM file_read_grants
           WHERE expires_at > ?`,
        )
        .all(stamp) as GrantRow[];
      return rows.map(mapGrant);
    },
  };
}
