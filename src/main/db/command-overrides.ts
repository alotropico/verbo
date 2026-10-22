import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

import { type CommandNode } from "../../shared/commands";

export async function saveCommandOverride(
  _database: DatabaseSync,
  _defaults: CommandNode[],
  raw: unknown,
): Promise<{ ok: true } | { ok: false; summary: string }> {
  return await aloData("settings.save", raw);
}

export async function resetCommandOverrides(_database: DatabaseSync, nodeId: string): Promise<void> {
  await aloData("settings.reset", { nodeId });
  return;
}
