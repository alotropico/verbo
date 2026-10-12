import type { FileScopeRecord, ScopeCommit } from "@shared/files";

export type FileScopeDraft = {
  key: string;
  id?: string;
  pickId?: string;
  proposedDefault?: boolean;
  alias: string;
  path: string;
  read: boolean;
  write: boolean;
  defaultSave: boolean;
  removed: boolean;
};

export function draftsFromScopes(scopes: FileScopeRecord[]): FileScopeDraft[] {
  return scopes.map((scope) => ({
    key: scope.id,
    id: scope.id,
    alias: scope.aliases.join(", "),
    path: scope.path,
    read: scope.read,
    write: scope.write,
    defaultSave: scope.defaultSave,
    removed: false,
  }));
}

export function scopeCommitFromDrafts(rows: FileScopeDraft[]): ScopeCommit {
  return {
    removeIds: rows.flatMap((row) => (row.id && row.removed ? [row.id] : [])),
    updates: rows.flatMap((row) =>
      row.id && !row.removed
        ? [
            {
              id: row.id,
              alias: row.alias,
              read: row.read,
              write: row.write,
              defaultSave: row.defaultSave,
            },
          ]
        : [],
    ),
    picks: rows.flatMap((row) =>
      row.pickId && !row.removed
        ? [
            {
              pickId: row.pickId,
              alias: row.alias,
              read: row.read,
              write: row.write,
              defaultSave: row.defaultSave,
            },
          ]
        : [],
    ),
    acceptDefault: rows.some((row) => row.proposedDefault && !row.removed),
  };
}

export function filesDraftDirty(
  saved: FileScopeRecord[],
  rows: FileScopeDraft[],
): boolean {
  return JSON.stringify(draftsFromScopes(saved)) !== JSON.stringify(rows);
}
