import type { DatabaseSync } from "node:sqlite";
import type { ActionHistoryEntry } from "../../shared/actions-overview";
import { aloData } from "../alo/data-client";
export function recentActionAudits(
  _database: DatabaseSync,
  limit = 40,
): ActionHistoryEntry[] {
  return aloData("history.read", { limit });
}
export function recordActionAudit(
  _database: DatabaseSync,
  input: {
    actor: string;
    actionId: string;
    request: string;
    summary: string;
    status: string;
    code?: string;
    now?: number;
  },
): void {
  aloData("history.record", input);
}
