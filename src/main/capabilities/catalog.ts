import type { DatabaseSync } from "node:sqlite";
import { createAloRegistry } from "../alo/registry";
import type { MemoryStore } from "../db/memory";
import type { ScopeStore } from "../db/scopes";
import type { CapabilityRegistry } from "./registry";
export function createProductionRegistry(
  _memory?: () => MemoryStore,
  _scopes?: () => ScopeStore,
  database?: () => DatabaseSync,
  defaultsOnly = false,
): CapabilityRegistry {
  return createAloRegistry(database?.(), defaultsOnly);
}
export function registryForDatabase(
  database: DatabaseSync,
  defaultsOnly = false,
): CapabilityRegistry {
  return createAloRegistry(database, defaultsOnly);
}
