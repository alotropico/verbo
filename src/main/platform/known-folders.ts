import { homedir, tmpdir } from "node:os";
import { displayFinalPath } from "../../shared/files";
import { isProtectedLocation } from "../files/path-policy";
import { describeExistingPath } from "../files/windows-containment";
import { readRegistryString } from "./win-registry";

const SHELL =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders";

const SHELL_VALUES = [
  ["desktop", "Desktop"],
  ["documents", "Personal"],
  ["downloads", "{374DE290-123F-4565-9164-39C4925E467B}"],
  ["music", "My Music"],
  ["pictures", "My Pictures"],
  ["videos", "My Video"],
] as const;

export type KnownFolder = {
  name: string;
  path: string;
};

export function knownFolders(platform = process.platform): KnownFolder[] {
  const found: KnownFolder[] = [];
  const push = (name: string, candidate: string | null): void => {
    if (!candidate) return;
    const described = describeExistingPath(candidate);
    if (!described.ok || !described.directory) return;
    if (isProtectedLocation(described.finalPath)) return;
    const path = displayFinalPath(described.finalPath);
    if (found.some((item) => item.name === name)) return;
    found.push({ name, path });
  };
  push("home", homedir());
  push("temp", tmpdir());
  if (platform !== "win32") return found;
  for (const [name, value] of SHELL_VALUES) {
    push(name, readRegistryString("HKCU", SHELL, value));
  }
  return found;
}
