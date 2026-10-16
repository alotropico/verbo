import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FileScopeRecord } from "../../shared/files";
import { resolveFileReference } from "../files/path-policy";
import { recordFileResource } from "../files/resource-events";

type Snapshot = { hashes: Map<string, string>; truncated: boolean };
/** Bounded observation of readable note resources, never a claim of complete CLI effects. */
export function snapshotVaultNotes(
  scope: FileScopeRecord,
  scopes: FileScopeRecord[],
): Snapshot {
  const hashes = new Map<string, string>();
  const pending = [scope.path];
  let visited = 0,
    bytes = 0,
    truncated = false;
  while (pending.length) {
    const directory = pending.shift()!;
    try {
      if (lstatSync(directory).isSymbolicLink()) {
        truncated = true;
        continue;
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++visited > 4096 || hashes.size >= 512 || bytes >= 16_000_000)
          return { hashes, truncated: true };
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        const allowed = resolveFileReference({
          reference: path,
          purpose: "read",
          actor: "model",
          scopes,
          grants: [],
        });
        if (!allowed.ok) {
          truncated = true;
          continue;
        }
        if (entry.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!entry.isFile() || !/\.(?:md|canvas|base)$/iu.test(entry.name))
          continue;
        const stat = lstatSync(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 2_000_000 ||
          bytes + stat.size > 16_000_000
        ) {
          truncated = true;
          continue;
        }
        bytes += stat.size;
        hashes.set(
          path,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        );
      }
    } catch {
      truncated = true;
    }
  }
  return { hashes, truncated };
}

export function recordVaultNoteChanges(
  before: Snapshot,
  after: Snapshot,
  primary?: string,
): { scanned: number; truncated: boolean; changed: number; removed: number } {
  let changed = 0,
    removed = 0;
  for (const [path, hash] of after.hashes) {
    if (
      before.hashes.get(path) === hash ||
      (before.truncated && !before.hashes.has(path))
    )
      continue;
    changed += 1;
    if (path.toLowerCase() !== primary?.toLowerCase())
      recordFileResource(path, "write");
  }
  for (const path of before.hashes.keys())
    if (!after.truncated && !after.hashes.has(path)) removed += 1;
  return {
    scanned: after.hashes.size,
    truncated: before.truncated || after.truncated,
    changed,
    removed,
  };
}
