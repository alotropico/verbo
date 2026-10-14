import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { registryForDatabase } from "../capabilities/catalog";
import {
  createMemoryStore,
  type MemoryFailure,
  type MemorySuccess,
} from "../db/memory";
import type { MemoryUsage } from "../../shared/memory";

/** Preserve the Settings response shape while sharing the authoritative dispatcher. */
export async function executeMemorySettingsAction(
  database: DatabaseSync,
  action: "memory.add" | "memory.update" | "memory.remove",
  args: Record<string, unknown>,
): Promise<(MemorySuccess | MemoryFailure) & { usage: MemoryUsage }> {
  const result = await registryForDatabase(database).invoke(action, args, {
    actor: "ui",
    threadId: typeof args.threadId === "string" ? args.threadId : "settings",
  });
  const store = createMemoryStore(database);
  if (result.status !== "success")
    return {
      ok: false,
      code: result.code ?? result.status,
      summary: result.summary,
      usage: store.usage(),
    };
  const identified = z.object({ id: z.string() }).safeParse(result.data);
  const entry = identified.success
    ? store.get([identified.data.id])[0]
    : undefined;
  return {
    ok: true,
    summary: result.summary,
    ...(entry ? { entry } : {}),
    usage: store.usage(),
  };
}
