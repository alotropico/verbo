import type { DatabaseSync } from "node:sqlite";
import {
  commandOverrideSchema,
  createCommandResolver,
  type CommandNode,
  type CommandOverride,
} from "../../shared/commands";

export function effectiveCommandNodes(
  database: DatabaseSync,
  defaults: CommandNode[],
): CommandNode[] {
  let effective = defaults.map((node) => ({
    ...node,
    aliases: [...node.aliases],
  }));
  const rows = database
    .prepare(
      `SELECT node_id, value_json FROM command_overrides ORDER BY node_id`,
    )
    .all() as { node_id: string; value_json: string }[];
  for (const row of rows) {
    try {
      const parsed = commandOverrideSchema.safeParse(
        JSON.parse(row.value_json),
      );
      if (
        !parsed.success ||
        parsed.data.nodeId !== row.node_id ||
        !defaults.some((node) => node.id === row.node_id)
      )
        continue;
      const candidate = effective.map((node) =>
        node.id === row.node_id
          ? { ...node, aliases: parsed.data.aliases }
          : node,
      );
      createCommandResolver(candidate);
      effective = candidate;
    } catch {
      /* Recover this field only. Trusted defaults remain effective. */
    }
  }
  return effective;
}

export function saveCommandOverride(
  database: DatabaseSync,
  defaults: CommandNode[],
  raw: unknown,
): { ok: true } | { ok: false; summary: string } {
  const parsed = commandOverrideSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, summary: "Only bounded aliases can be changed." };
  if (!defaults.some((node) => node.id === parsed.data.nodeId))
    return { ok: false, summary: "That command node does not exist." };
  const effective = effectiveCommandNodes(database, defaults).map((node) =>
    node.id === parsed.data.nodeId
      ? { ...node, aliases: parsed.data.aliases }
      : node,
  );
  try {
    createCommandResolver(effective);
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : "Aliases collide.",
    };
  }
  database.exec("BEGIN");
  try {
    const override: CommandOverride = parsed.data;
    database
      .prepare(
        `INSERT INTO command_overrides(node_id, version, value_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET version=excluded.version, value_json=excluded.value_json, updated_at=excluded.updated_at`,
      )
      .run(
        override.nodeId,
        override.version,
        JSON.stringify(override),
        Date.now(),
      );
    createCommandResolver(effectiveCommandNodes(database, defaults));
    database.exec("COMMIT");
    return { ok: true };
  } catch {
    database.exec("ROLLBACK");
    return { ok: false, summary: "Command settings could not be saved." };
  }
}
export function resetCommandOverrides(
  database: DatabaseSync,
  nodeId: string,
): void {
  database
    .prepare(
      `DELETE FROM command_overrides WHERE node_id = ? OR substr(node_id, 1, length(?)) = ?`,
    )
    .run(nodeId, `${nodeId}.`, `${nodeId}.`);
}
