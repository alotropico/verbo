import type { DatabaseSync } from "node:sqlite";
import type { ActionHistoryEntry } from "../../shared/actions-overview";
import { aloData } from "../alo/data-client";
export async function recentActionAudits(_database: DatabaseSync, limit = 40): Promise<ActionHistoryEntry[]> {
  return await aloData("history.read", { limit });
}
export async function recordActionAudit(
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
): Promise<void> {
  await aloData("history.record", input);
}
