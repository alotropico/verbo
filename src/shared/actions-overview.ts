import type { RegisteredRoot } from "./projects";

export type ActionCatalogEntry = {
  id: string;
  description: string;
  kind: "read" | "mutation" | "category";
  approval?: "none" | "required";
};

export type ActionHistoryEntry = {
  actionId: string;
  actor: string;
  status: string;
  summary: string;
  code?: string;
  createdAt: number;
};

export type ActionsOverview = {
  catalog: ActionCatalogEntry[];
  history: ActionHistoryEntry[];
  projects: RegisteredRoot[];
  agsHosts: RegisteredRoot[];
  agsCheckConfigured: boolean;
  agsCheckPath: string | null;
};
