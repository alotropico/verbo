import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SCOPE_ALIAS = "tmp";

export function proposedDefaultDirectory(projectRoot: string): string {
  return join(projectRoot, ".tmp");
}

export function ensureProposedDefaultDirectory(projectRoot: string): string {
  const directory = proposedDefaultDirectory(projectRoot);
  mkdirSync(directory, { recursive: true });
  return directory;
}
