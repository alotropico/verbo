import { createMemoryStore, type MemoryStore } from "../db/memory";
import { createScopeStore, type ScopeStore } from "../db/scopes";
import type { DatabaseSync } from "node:sqlite";
import { filesCapabilities } from "./files";
import { memoryCapabilities } from "./memory";
import { platformCapability } from "./environment";
import { createRegistry, type CapabilityRegistry } from "./registry";

/** Production catalog. Tests add fixture actions on their own registry. */
export function createProductionRegistry(
  resolveStore?: () => MemoryStore,
  resolveScopes?: () => ScopeStore,
  resolveDatabase?: () => DatabaseSync,
): CapabilityRegistry {
  let store: MemoryStore | undefined;
  const resolve =
    resolveStore ??
    (() => {
      throw new Error("Memory store is not configured.");
    });
  return createRegistry([
    platformCapability(),
    ...memoryCapabilities(() => {
      store ??= resolve();
      return store;
    }),
    ...filesCapabilities(
      () => {
        if (!resolveScopes) throw new Error("File scopes are not configured.");
        return resolveScopes();
      },
      () => {
        if (!resolveDatabase)
          throw new Error("File database is not configured.");
        return resolveDatabase();
      },
    ),
  ]);
}

export function registryForDatabase(
  database: DatabaseSync,
): CapabilityRegistry {
  return createProductionRegistry(
    () => createMemoryStore(database),
    () => createScopeStore(database),
    () => database,
  );
}
