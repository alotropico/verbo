import { createMemoryStore, type MemoryStore } from "../db/memory";
import type { DatabaseSync } from "node:sqlite";
import { memoryCapabilities } from "./memory";
import { platformCapability } from "./environment";
import { createRegistry, type CapabilityRegistry } from "./registry";

/** Production catalog. Tests add fixture actions on their own registry. */
export function createProductionRegistry(
  resolveStore?: () => MemoryStore,
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
  ]);
}

export function registryForDatabase(
  database: DatabaseSync,
): CapabilityRegistry {
  return createProductionRegistry(() => createMemoryStore(database));
}
