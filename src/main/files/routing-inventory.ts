import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { FileScopeRecord } from "../../shared/files";
import type { DatabaseSync } from "node:sqlite";
import { createScopeStore } from "../db/scopes";
let invalidationVersion = 0;
export function invalidateRoutingInventories(): void {
  invalidationVersion += 1;
}

export type FolderCard = {
  id: string;
  aliases: string[];
  kind: "none" | "projects" | "obsidian";
  description: string;
  read: boolean;
  write: boolean;
  defaultSave: boolean;
  available: boolean;
  directories: string[];
  truncated: boolean;
};
export type RoutingInventory = {
  folders: FolderCard[];
  truncated: boolean;
  generation: number;
  refreshedAt: number;
};

function shallowDirectories(
  scope: FileScopeRecord,
  maxEntries: number,
  scopes: FileScopeRecord[],
): Pick<FolderCard, "directories" | "available" | "truncated"> {
  const directories: string[] = [];
  if (!scope.read) return { directories, available: false, truncated: false };
  try {
    if (lstatSync(scope.path).isSymbolicLink())
      return { directories, available: false, truncated: false };
    const root = realpathSync(scope.path);
    const pending = [{ path: root, depth: 0 }];
    const maxDepth = scope.kind === "projects" ? 1 : 2;
    let visited = 0;
    let truncated = false;
    while (pending.length) {
      const current = pending.shift()!;
      const entries = readdirSync(current.path, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        visited += 1;
        if (visited > maxEntries * 4 || directories.length >= maxEntries) {
          truncated = true;
          break;
        }
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          entry.name.startsWith(".")
        )
          continue;
        const path = join(current.path, entry.name);
        if (
          scopes.some(
            (nested) =>
              !nested.read &&
              (() => {
                const rel = relative(nested.path, path);
                return (
                  rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
                );
              })(),
          )
        )
          continue;
        if (lstatSync(path).isSymbolicLink()) continue;
        const rel = relative(root, realpathSync(path));
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
        directories.push(rel.replace(/\\/gu, "/").slice(0, 200));
        if (current.depth + 1 < maxDepth)
          pending.push({ path, depth: current.depth + 1 });
      }
      if (truncated) break;
    }
    return { directories, available: true, truncated };
  } catch {
    return { directories, available: false, truncated: false };
  }
}

/** Metadata-only cache; configuration/mutation notifications or explicit refresh invalidate it. */
export function createRoutingInventory(input: {
  scopes: () => FileScopeRecord[];
  generation: () => number;
  scan?: typeof shallowDirectories;
  maxFolders?: number;
  maxBytes?: number;
}): {
  refresh: () => RoutingInventory;
  invalidate: () => void;
  get: () => RoutingInventory;
} {
  let cached: RoutingInventory | undefined;
  let cacheVersion = invalidationVersion;
  function refresh(): RoutingInventory {
    const folders: FolderCard[] = [];
    const scopes = input.scopes();
    let truncated = false;
    for (const scope of scopes) {
      if (folders.length >= (input.maxFolders ?? 30)) {
        truncated = true;
        break;
      }
      const card: FolderCard = {
        id: scope.id,
        aliases: scope.aliases,
        kind: scope.kind ?? "none",
        description: (scope.routingDescription ?? "").slice(0, 1000),
        read: scope.read,
        write: scope.write,
        defaultSave: scope.defaultSave,
        ...(input.scan ?? shallowDirectories)(scope, 40, scopes),
      };
      if (
        Buffer.byteLength(JSON.stringify([...folders, card])) >
        (input.maxBytes ?? 20_000)
      ) {
        truncated = true;
        break;
      }
      folders.push(card);
    }
    cached = {
      folders,
      truncated,
      generation: input.generation(),
      refreshedAt: Date.now(),
    };
    cacheVersion = invalidationVersion;
    return structuredClone(cached);
  }
  return {
    refresh,
    invalidate: () => {
      cached = undefined;
    },
    get: (): RoutingInventory =>
      cached &&
      cacheVersion === invalidationVersion &&
      cached.generation === input.generation()
        ? structuredClone(cached)
        : refresh(),
  };
}

const inventories = new WeakMap<
  DatabaseSync,
  ReturnType<typeof createRoutingInventory>
>();
export function routingInventoryForDatabase(
  database: DatabaseSync,
): ReturnType<typeof createRoutingInventory> {
  let inventory = inventories.get(database);
  if (!inventory) {
    const scopes = createScopeStore(database);
    inventory = createRoutingInventory({
      scopes: scopes.list,
      generation: scopes.generation,
    });
    inventories.set(database, inventory);
  }
  return inventory;
}

export function resolveVaultTarget(
  scopes: FileScopeRecord[],
  hint?: string,
  purpose: "read" | "write" = "write",
):
  | { status: "selected"; scope: FileScopeRecord }
  | { status: "clarify" | "blocked"; question: string; candidates: string[] } {
  const vaults = scopes.filter((scope) => scope.kind === "obsidian");
  const matched = hint
    ? vaults.filter(
        (scope) =>
          scope.id === hint ||
          scope.aliases.some(
            (alias) =>
              alias.toLowerCase() ===
              hint.trim().toLowerCase().replace(/:$/u, ""),
          ),
      )
    : vaults;
  if (!matched.length)
    return {
      status: "blocked",
      question: hint
        ? `The named vault '${hint}' is unavailable. Choose a configured vault.`
        : "Configure an Obsidian vault before saving notes.",
      candidates: vaults.map((scope) => scope.alias),
    };
  if (matched.length !== 1)
    return {
      status: "clarify",
      question: `Which vault should I use: ${matched.map((scope) => scope.alias).join(", ")}?`,
      candidates: matched.map((scope) => scope.alias),
    };
  const scope = matched[0]!;
  if (!scope.read || (purpose === "write" && !scope.write))
    return {
      status: "blocked",
      question: `The selected vault '${scope.alias}' does not allow ${purpose} access. Update its permissions or choose explicitly.`,
      candidates: [scope.alias],
    };
  return { status: "selected", scope };
}
