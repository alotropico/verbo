import { win32 } from "node:path";
import type { ActorKind } from "../../shared/action-contract";
import { displayFinalPath, scopeAliasSchema } from "../../shared/files";
import type { FileGrantRecord } from "../../shared/files";
import type { RegisteredRoot } from "../../shared/projects";
import { isProtectedLocation } from "../files/path-policy";
import {
  describeExistingPath,
  isFinalPathInside,
} from "../files/windows-containment";

export type ResolvedRoot = {
  alias: string;
  path: string;
  registered: boolean;
};

function samePath(left: string, right: string): boolean {
  return (
    isFinalPathInside(left, right) && isFinalPathInside(right, left)
  );
}

export function resolveRegisteredRoot(input: {
  reference: string;
  roots: readonly RegisteredRoot[];
  grants: readonly FileGrantRecord[];
  noun: string;
  now?: number;
  actor: ActorKind;
}):
  | { ok: true; root: ResolvedRoot }
  | { ok: false; code: string; summary: string } {
  const reference = input.reference.trim();
  if (!reference || reference.includes("\0")) {
    return {
      ok: false,
      code: "invalid_reference",
      summary: `Name a registered ${input.noun} alias.`,
    };
  }
  if (!win32.isAbsolute(reference)) {
    const parsed = scopeAliasSchema.safeParse(reference);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_reference",
        summary: `Name a registered ${input.noun} alias.`,
      };
    }
    const found = input.roots.find((root) => root.alias === parsed.data);
    if (!found) {
      return {
        ok: false,
        code: "not_registered",
        summary: `No ${input.noun} is registered as ${parsed.data}.`,
      };
    }
    return {
      ok: true,
      root: { alias: found.alias, path: found.path, registered: true },
    };
  }

  const described = describeExistingPath(reference);
  if (!described.ok || !described.directory) {
    return {
      ok: false,
      code: "not_registered",
      summary: `That path is not a registered ${input.noun}.`,
    };
  }
  if (isProtectedLocation(described.finalPath)) {
    return {
      ok: false,
      code: "protected",
      summary: "That location is protected.",
    };
  }
  const path = displayFinalPath(described.finalPath);
  const registered = input.roots.find((root) => samePath(root.path, path));
  if (registered) {
    return {
      ok: true,
      root: { alias: registered.alias, path: registered.path, registered: true },
    };
  }
  const now = input.now ?? Date.now();
  const selected =
    input.actor !== "model" &&
    input.grants.some(
      (grant) =>
        grant.kind === "directory" &&
        grant.expiresAt > now &&
        samePath(grant.path, path),
    );
  if (selected) {
    return {
      ok: true,
      root: { alias: "selected", path, registered: false },
    };
  }
  return {
    ok: false,
    code: "not_registered",
    summary:
      input.actor === "model"
        ? `Register that ${input.noun} before inspecting it.`
        : `Select or register that ${input.noun} before inspecting it.`,
  };
}
