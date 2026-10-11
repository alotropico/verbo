import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function proposedDefaultDirectory(home = homedir()): string {
  return join(home, "Documents", "Verbo");
}

export function ensureProposedDefaultDirectory(home = homedir()): string {
  const directory = proposedDefaultDirectory(home);
  mkdirSync(directory, { recursive: true });
  return directory;
}
