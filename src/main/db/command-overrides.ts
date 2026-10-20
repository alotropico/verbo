import { aloData } from "../alo/data-client";

import type { DatabaseSync } from "node:sqlite";

import { type CommandNode } from "../../shared/commands";

export function saveCommandOverride(
  _database: DatabaseSync,
  _defaults: CommandNode[],
  raw: unknown,
): { ok: true } | { ok: false; summary: string } {
  return aloData("settings.save", raw);
}

export function resetCommandOverrides(
  _database: DatabaseSync,
  nodeId: string,
): void {
  aloData("settings.reset", { nodeId });
  return;
}
