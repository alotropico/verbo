import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";
import type { CommandResource } from "../../shared/command-receipts";
import { displayFinalPath } from "../../shared/files";

const recorder = new AsyncLocalStorage<CommandResource[]>();
export async function collectCommandResources<T>(
  execute: () => Promise<T>,
): Promise<{ result: T; resources: CommandResource[] }> {
  const events: CommandResource[] = [];
  const parent = recorder.getStore();
  let result: T;
  try {
    result = await recorder.run(events, execute);
  } finally {
    parent?.push(...events);
  }
  return { result, resources: finalizeCommandResources(events) };
}
export function recordFileResource(
  path: string,
  event: CommandResource["event"] = "read",
  from?: string,
): void {
  recorder.getStore()?.push({
    path,
    event,
    available: event !== "remove",
    ...(from ? { from } : {}),
  });
}
export function finalizeCommandResources(
  events: CommandResource[],
): CommandResource[] {
  const current = new Map<string, CommandResource>();
  for (const event of events) {
    if (event.event === "move" && event.from)
      current.delete(event.from.toLowerCase());
    if (event.event === "remove") {
      current.delete(event.path.toLowerCase());
      continue;
    }
    current.set(event.path.toLowerCase(), event);
  }
  return [...current.values()].flatMap((event) => {
    try {
      const stat = lstatSync(event.path);
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      return [
        {
          ...event,
          path: displayFinalPath(event.path),
          ...(event.from ? { from: displayFinalPath(event.from) } : {}),
          available: true,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
      ];
    } catch {
      return [];
    }
  });
}
