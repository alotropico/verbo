import { readdirSync, readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { resolveContainedPath } from "../files/windows-containment";

export type AgsMetadata = {
  format: string;
  host: string;
  agsVersion: string;
  configured: boolean;
};

const FIELD = /^(format|host|agsVersion):\s*"?([^"#\r\n]{1,64})"?\s*$/u;

export function readAgsMetadata(root: string): AgsMetadata | null {
  const candidate = win32.join(root, ".agents", "ags.yaml");
  const resolved = resolveContainedPath(root, candidate, "read");
  if (!resolved.ok || !resolved.exists) return null;
  let size = 0;
  try {
    const stats = statSync(resolved.finalPath);
    if (!stats.isFile()) return null;
    size = stats.size;
  } catch {
    return null;
  }
  if (size > 65_536) return null;
  const text = readFileSync(resolved.finalPath, "utf8");
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u).slice(0, 40)) {
    const match = FIELD.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    found[match[1]] = match[2].trim();
  }
  if (!found.format && !found.host && !found.agsVersion) return null;
  return {
    format: found.format ?? "",
    host: found.host ?? "",
    agsVersion: found.agsVersion ?? "",
    configured: true,
  };
}

export type AgsArtifact = {
  path: string;
  bytes: number;
};

export function agsArtifactsSince(
  root: string,
  startedAt: number,
): AgsArtifact[] {
  const directory = win32.join(root, ".tmp", "ags");
  const resolved = resolveContainedPath(root, directory, "read");
  if (!resolved.ok || !resolved.exists) return [];
  const artifacts: AgsArtifact[] = [];
  const visit = (absolute: string, relative: string, depth: number): void => {
    if (artifacts.length >= 20 || depth > 2) return;
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (artifacts.length >= 20) return;
      const child = win32.join(absolute, entry.name);
      const contained = resolveContainedPath(root, child, "read");
      if (!contained.ok || !contained.exists) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(contained.finalPath, rel, depth + 1);
        continue;
      }
      try {
        const stats = statSync(contained.finalPath);
        if (!stats.isFile() || stats.mtimeMs < startedAt) continue;
        artifacts.push({ path: rel, bytes: stats.size });
      } catch {
        // Skip an artifact that disappeared during the check.
      }
    }
  };
  visit(resolved.finalPath, "", 0);
  return artifacts;
}
