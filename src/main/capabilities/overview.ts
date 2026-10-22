import type { ActionCatalogEntry, ActionsOverview } from "../../shared/actions-overview";
import type { AgsCheckConfig } from "../db/ags-check";
import { aloDataAsync } from "../alo/data-client";
import { readCommandSettings } from "../alo/settings";

export async function buildActionsOverview(): Promise<ActionsOverview> {
  const [settings, history, projects, agsHosts, check] = await Promise.all([
    readCommandSettings(),
    aloDataAsync<ActionsOverview["history"]>("history.read"),
    aloDataAsync<ActionsOverview["projects"]>("settings.projects.list"),
    aloDataAsync<ActionsOverview["agsHosts"]>("settings.ags-hosts.list"),
    aloDataAsync<AgsCheckConfig>("settings.ags-check.read"),
  ]);
  const catalog: ActionCatalogEntry[] = settings.nodes.map((node) => {
    const entry = settings.entries.find((item) => item.id === node.id);
    return {
      id: node.id,
      description: node.description,
      kind: entry?.kind ?? "category",
      ...(entry?.approval ? { approval: entry.approval } : {}),
    };
  });
  return {
    catalog,
    history,
    projects,
    agsHosts,
    agsCheckConfigured: check.configured,
    agsCheckPath: check.path,
  };
}
