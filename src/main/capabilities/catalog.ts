import { createMemoryStore, type MemoryStore } from "../db/memory";
import { createScopeStore, type ScopeStore } from "../db/scopes";
import type { DatabaseSync } from "node:sqlite";
import { agsBindings, agsModule } from "./ags";
import { environmentBindings, environmentModule } from "./environment";
import { fileMutationBindings } from "./file-mutations";
import { fileQueryBindings, filesModule } from "./files";
import { memoryBindings, memoryModule } from "./memory";
import { projectBindings, projectsModule } from "./projects";
import { softwareBindings, softwareModule } from "./software";
import type { CapabilityRegistry } from "./registry";
import { createModuleRegistry } from "./modules";
import { persistCommandReceipt } from "../db/command-receipts";
import { effectiveCommandNodes } from "../db/command-overrides";
import { webModule, webBindings } from "./web";
import { createPreparationOwner } from "./preparation";
import { projectOpeningBindings } from "./project-opening";
import { obsidianBindings, obsidianModule } from "./obsidian";

/** Production catalog. Tests add fixture actions on their own registry. */
export function createProductionRegistry(
  resolveStore?: () => MemoryStore,
  resolveScopes?: () => ScopeStore,
  resolveDatabase?: () => DatabaseSync,
  defaultsOnly = false,
): CapabilityRegistry {
  let store: MemoryStore | undefined;
  const resolve =
    resolveStore ??
    (() => {
      throw new Error("Memory store is not configured.");
    });
  const scopes = (): ScopeStore => {
    if (!resolveScopes) throw new Error("File scopes are not configured.");
    return resolveScopes();
  };
  const database = (): DatabaseSync => {
    if (!resolveDatabase) throw new Error("File database is not configured.");
    return resolveDatabase();
  };
  const ags = agsBindings(resolveDatabase, resolveScopes);
  const obsidian = obsidianBindings(resolveDatabase);
  const handlers = {
    ...environmentBindings(resolveScopes, resolveDatabase),
    ...memoryBindings(() => {
      store ??= resolve();
      return store;
    }),
    ...fileQueryBindings(scopes, database),
    ...fileMutationBindings(scopes, database),
    ...projectBindings(resolveScopes, resolveDatabase),
    ...softwareBindings(),
    ...ags.handlers,
  };
  const opening = projectOpeningBindings(
    resolveDatabase ??
      (() => {
        throw new Error("Application database is not configured.");
      }),
  );
  // A database is resolved lazily for discovery-only consumers.
  const preparation = {
    submit: (
      ...args: Parameters<ReturnType<typeof createPreparationOwner>["submit"]>
    ) => {
      if (!resolveDatabase)
        throw new Error("Application database is not configured.");
      return createPreparationOwner(resolveDatabase()).submit(...args);
    },
    consume: (
      ...args: Parameters<ReturnType<typeof createPreparationOwner>["consume"]>
    ) => {
      if (!resolveDatabase)
        throw new Error("Application database is not configured.");
      return createPreparationOwner(resolveDatabase()).consume(...args);
    },
  };
  return createModuleRegistry(
    [
      environmentModule,
      memoryModule,
      filesModule,
      projectsModule,
      softwareModule,
      agsModule,
      webModule,
      obsidianModule,
    ],
    {
      handlers: Object.assign(
        {},
        handlers,
        webBindings(resolveDatabase),
        opening.handlers,
        obsidian.handlers,
      ),
      processes: {
        ...opening.processes,
        ...ags.processes,
        ...obsidian.processes,
      },
      preparers: { ...opening.preparers, ...obsidian.preparers },
      aggregators: opening.aggregators,
    },
    resolveDatabase
      ? {
          finalize: (input) => persistCommandReceipt(resolveDatabase(), input),
          configureNodes: (nodes) =>
            defaultsOnly
              ? nodes
              : effectiveCommandNodes(resolveDatabase(), nodes),
          preparation,
        }
      : { preparation },
  );
}

export function registryForDatabase(
  database: DatabaseSync,
  defaultsOnly = false,
): CapabilityRegistry {
  return createProductionRegistry(
    () => createMemoryStore(database),
    () => createScopeStore(database),
    () => database,
    defaultsOnly,
  );
}
