import type { DatabaseSync } from "node:sqlite";
import type {
  ActionCatalogEntry,
  ActionsOverview,
} from "../../shared/actions-overview";
import { readAgsCheck } from "../db/ags-check";
import { recentActionAudits } from "../db/action-audit";
import { createRootStore } from "../db/registered-roots";
import { registryForDatabase } from "./catalog";

export function buildActionsOverview(database: DatabaseSync): ActionsOverview {
  const registry = registryForDatabase(database);
  const catalog: ActionCatalogEntry[] = [];
  for (const category of registry.list().children) {
    catalog.push({
      id: category.id,
      description: category.description,
      kind: category.kind,
    });
    for (const child of registry.list(category.id).children) {
      const described = registry.describe([child.id]).entries[0];
      catalog.push({
        id: child.id,
        description: child.description,
        kind: child.kind,
        ...(described?.approval ? { approval: described.approval } : {}),
      });
    }
  }
  const check = readAgsCheck(database);
  return {
    catalog,
    history: recentActionAudits(database),
    projects: createRootStore(
      database,
      "registered_projects",
      "project",
    ).list(),
    agsHosts: createRootStore(database, "ags_hosts", "AGS host").list(),
    agsCheckConfigured: check.configured,
    agsCheckPath: check.path,
  };
}
