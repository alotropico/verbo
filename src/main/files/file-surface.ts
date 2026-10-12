import { lstatSync, readFileSync } from "node:fs";
import type { ActorKind } from "../../shared/action-contract";
import type {
  FileSurfaceIntent,
  FileSurfaceResult,
} from "../../shared/file-surface";
import { FILE_MUTATION_LIMITS } from "../../shared/file-mutation";
import type { FileGrantRecord, FileScopeRecord } from "../../shared/files";
import { resolveFileReference } from "./path-policy";

const actor: ActorKind = "ui";

function failure(code: string, summary: string): FileSurfaceResult {
  return { ok: false, code, summary };
}

export async function performFileSurface(input: {
  reference: string;
  intent: FileSurfaceIntent;
  scopes: readonly FileScopeRecord[];
  grants: readonly FileGrantRecord[];
  openPath: (absolute: string) => Promise<string>;
  showItemInFolder: (absolute: string) => void;
  writeClipboard: (text: string) => void;
}): Promise<FileSurfaceResult> {
  const resolved = resolveFileReference({
    reference: input.reference,
    purpose: "read",
    actor,
    scopes: input.scopes,
    grants: input.grants,
  });
  if (!resolved.ok) return failure(resolved.code, resolved.summary);
  let stats;
  try {
    stats = lstatSync(resolved.path.absolute);
  } catch {
    return failure("missing", "That path does not exist.");
  }
  if (stats.isSymbolicLink()) {
    return failure("link", "Links are not opened from the message.");
  }
  if (input.intent === "copy") {
    if (!stats.isFile()) return failure("folder", "That path is a folder.");
    if (stats.size > FILE_MUTATION_LIMITS.maxContentChars) {
      return failure("too_large", "That file is too large to copy.");
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolved.path.absolute);
    } catch {
      return failure("unreadable", "That file could not be read.");
    }
    if (bytes.includes(0)) {
      return failure("binary", "That file is not text.");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return failure("binary", "That file is not text.");
    }
    input.writeClipboard(text);
    return { ok: true };
  }
  try {
    if (input.intent === "reveal") {
      input.showItemInFolder(resolved.path.absolute);
      return { ok: true };
    }
    const error = await input.openPath(resolved.path.absolute);
    if (error) return failure("open_failed", error.slice(0, 300));
    return { ok: true };
  } catch {
    return failure("open_failed", "The file could not be opened.");
  }
}
