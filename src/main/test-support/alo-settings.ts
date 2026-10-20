import { z } from "zod";
import {
  commandNodeSchema,
  type CommandNode,
  type CommandSettings,
} from "../../shared/commands";
import { aloCall, aloCallSync } from "../alo/client";
export function readAloSettings(): Pick<CommandSettings, "nodes" | "defaults"> {
  return z
    .object({
      nodes: z.array(commandNodeSchema),
      defaults: z.array(commandNodeSchema),
    })
    .parse(
      aloCallSync({
        method: "settings.read",
        context: { actor: "ui", threadId: "alo-settings" },
      }),
    );
}
export function applyAloSettingsSnapshot(
  nodes: CommandNode[],
  defaultsOnly = false,
): CommandNode[] {
  const settings = readAloSettings();
  const values = new Map(
    (defaultsOnly ? settings.defaults : settings.nodes).map((n) => [n.id, n]),
  );
  return nodes.map((n) => values.get(n.id) ?? n);
}
export async function saveAloSetting(
  args: unknown,
): Promise<{ ok: true } | { ok: false; summary: string }> {
  return z
    .union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), summary: z.string() }),
    ])
    .parse(
      await aloCall({
        method: "settings.save",
        args,
        context: { actor: "ui", threadId: "alo-settings" },
      }),
    );
}
