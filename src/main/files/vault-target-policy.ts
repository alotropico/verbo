import { win32 } from "node:path";
import { lstatSync } from "node:fs";
import type { FileScopeRecord } from "../../shared/files";
import { displayFinalPath } from "../../shared/files";
import { describeExistingPath } from "./windows-containment";

function normalized(path: string): string {
  return win32
    .normalize(displayFinalPath(path))
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}
function inside(root: string, path: string): boolean {
  const base = normalized(root),
    target = normalized(path);
  return target === base || target.startsWith(`${base}\\`);
}

/** Resolve missing leaves through their nearest real ancestor, matching the native path engine. */
export function canonicalTarget(path: string): string {
  const remaining: string[] = [];
  let ancestor = win32.resolve(path);
  for (let depth = 0; depth < 128; depth += 1) {
    let present = false;
    try {
      lstatSync(ancestor);
      present = true;
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ))
        throw new Error("The canonical target could not be revalidated.");
    }
    if (present) {
      const described = describeExistingPath(ancestor);
      if (!described.ok)
        throw new Error("The canonical target could not be revalidated.");
      return win32.join(
        displayFinalPath(described.finalPath),
        ...remaining.reverse(),
      );
    }
    const parent = win32.dirname(ancestor);
    if (parent === ancestor) break;
    remaining.push(win32.basename(ancestor));
    ancestor = parent;
  }
  throw new Error("The target has no verifiable existing ancestor.");
}

export type VaultIntersection = {
  scope: FileScopeRecord;
  relation: "inside" | "ancestor";
  path: string;
  relativePath?: string;
};
export function classifyVaultTarget(input: {
  path: string;
  scopes: readonly FileScopeRecord[];
  tree?: boolean;
}): VaultIntersection[] {
  if (!input.scopes.some((scope) => scope.kind === "obsidian")) return [];
  const path = canonicalTarget(input.path);
  const hits: VaultIntersection[] = [];
  for (const scope of input.scopes) {
    if (scope.kind !== "obsidian") continue;
    let root: string;
    try {
      root = canonicalTarget(scope.path);
    } catch {
      if (inside(scope.path, path) || (input.tree && inside(path, scope.path)))
        throw new Error(
          `Configured vault '${scope.alias}' cannot be revalidated.`,
        );
      continue;
    }
    if (inside(root, path))
      hits.push({
        scope,
        relation: "inside",
        path,
        relativePath: win32.relative(root, path).replace(/\\/gu, "/"),
      });
    else if (input.tree && inside(path, root))
      hits.push({ scope, relation: "ancestor", path });
  }
  return hits;
}

export function guardNativeVaultTargets(input: {
  scopes: readonly FileScopeRecord[];
  targets: { path: string; purpose: "read" | "write"; tree?: boolean }[];
}): { ok: true } | { ok: false; code: string; summary: string } {
  try {
    for (const target of input.targets) {
      const hits = classifyVaultTarget({ ...target, scopes: input.scopes });
      const denied = hits.find(
        (hit) =>
          !hit.scope.read || (target.purpose === "write" && !hit.scope.write),
      );
      if (denied)
        return {
          ok: false,
          code: "vault_permission_denied",
          summary: `The canonical target intersects vault '${denied.scope.alias}', whose ${target.purpose} permission is disabled.`,
        };
      if (target.purpose === "write" && hits.length)
        return {
          ok: false,
          code: "vault_backend_required",
          summary: `This target affects an Obsidian vault (${hits.map((hit) => hit.scope.alias).join(", ")}). Use a qualified Obsidian operation; native mutation is disabled for vault targets.`,
        };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: "vault_target_unverifiable",
      summary:
        error instanceof Error
          ? error.message
          : "The vault target could not be verified.",
    };
  }
}
