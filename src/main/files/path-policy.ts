import { win32 } from "node:path";
import type { ActorKind } from "../../shared/action-contract";
import { displayFinalPath, scopeAliasSchema } from "../../shared/files";
import type { FileGrantRecord, FileScopeRecord } from "../../shared/files";
import {
  isFinalPathInside,
  resolveContainedPath,
  type ContainmentCode,
} from "./windows-containment";

const DEVICE_ALIAS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

const PROTECTED_PREFIX =
  /^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|$)/iu;

const PROTECTED_MARKERS = [
  "\\.ssh",
  "\\.gnupg",
  "\\appdata\\roaming\\microsoft\\credentials",
  "\\appdata\\local\\microsoft\\credentials",
  "\\appdata\\roaming\\mozilla\\firefox\\profiles",
  "\\appdata\\local\\google\\chrome\\user data",
  "\\appdata\\local\\microsoft\\edge\\user data",
];

export type ResolvedFile = {
  display: string;
  absolute: string;
  scopeId?: string;
  grantId?: string;
  read: boolean;
  write: boolean;
};

export type PathFailure = {
  ok: false;
  code: string;
  summary: string;
};

export type PathSuccess = {
  ok: true;
  path: ResolvedFile;
};

function normalized(candidate: string): string {
  return candidate
    .replace(/^\\\\\?\\/u, "")
    .replace(/\//gu, "\\")
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

export function isProtectedLocation(candidate: string): boolean {
  const value = normalized(candidate);
  if (!value || /^[a-z]:$/u.test(value)) return true;
  if (PROTECTED_PREFIX.test(`${value}\\`)) return true;
  return PROTECTED_MARKERS.some(
    (marker) => value.endsWith(marker) || value.includes(`${marker}\\`),
  );
}

export function aliasFromFolderName(folderPath: string): string {
  const base = win32
    .basename(displayFinalPath(folderPath))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  const named = /^[a-z]/u.test(base) ? base : `folder-${base || "root"}`;
  return named.slice(0, 32);
}

export function parseFileReference(
  reference: string,
):
  | { kind: "alias"; alias: string; parts: string[] }
  | { kind: "absolute"; path: string }
  | { kind: "invalid" } {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.includes("\0")) return { kind: "invalid" };
  if (win32.isAbsolute(trimmed)) return { kind: "absolute", path: trimmed };
  const alias = /^([a-z][a-z0-9-]{1,31}):(?:[/\\]([\s\S]*))?$/iu.exec(trimmed);
  if (alias?.[1] && !DEVICE_ALIAS.test(alias[1])) {
    const rest = alias[2] ?? "";
    if (/^[a-z]:/iu.test(rest)) return { kind: "invalid" };
    const parts = rest.split(/[\\/]+/u).filter((part) => part.length > 0);
    if (
      parts.some((part) => part === "." || part === ".." || part.includes(":"))
    ) {
      return { kind: "invalid" };
    }
    return { kind: "alias", alias: alias[1].toLowerCase(), parts };
  }
  if (win32.isAbsolute(trimmed)) return { kind: "absolute", path: trimmed };
  return { kind: "invalid" };
}

function failure(code: string, summary: string): PathFailure {
  return { ok: false, code, summary };
}

function summaryFor(code: ContainmentCode | "missing" | "protected"): string {
  if (code === "unc") return "Network paths are not a file scope.";
  if (code === "device") return "Device paths are blocked.";
  if (code === "root") return "The scope root itself cannot be replaced.";
  if (code === "protected") return "That location is protected.";
  if (code === "missing") return "That path does not exist.";
  if (code === "unopenable") return "That path could not be opened.";
  if (code === "invalid") return "That path is not valid.";
  return "That path is outside the authorized folder.";
}

function relativeDisplay(
  alias: string,
  rootFinal: string,
  finalPath: string,
): string {
  const root = displayFinalPath(rootFinal).replace(/[\\/]+$/u, "");
  const candidate = displayFinalPath(finalPath).replace(/[\\/]+$/u, "");
  if (candidate.toLowerCase() === root.toLowerCase()) return `${alias}:/`;
  const prefix = `${root}\\`;
  const rest = candidate.toLowerCase().startsWith(prefix.toLowerCase())
    ? candidate.slice(prefix.length)
    : candidate;
  return `${alias}:/${rest.split("\\").join("/")}`;
}

function containedFinal(
  root: string,
  candidate: string,
  purpose: "read" | "write",
): { ok: true; finalPath: string } | PathFailure {
  if (isProtectedLocation(candidate))
    return failure("protected", summaryFor("protected"));
  const resolved = resolveContainedPath(root, candidate, purpose);
  if (!resolved.ok) return failure(resolved.code, summaryFor(resolved.code));
  if (!resolved.exists) return failure("missing", summaryFor("missing"));
  if (isProtectedLocation(resolved.finalPath)) {
    return failure("protected", summaryFor("protected"));
  }
  return { ok: true, finalPath: resolved.finalPath };
}

export function resolveFileReference(input: {
  reference: string;
  purpose: "read" | "write";
  actor: ActorKind;
  scopes: readonly FileScopeRecord[];
  grants: readonly FileGrantRecord[];
  now?: number;
}): PathFailure | PathSuccess {
  const parsed = parseFileReference(input.reference);
  if (parsed.kind === "invalid") {
    return failure(
      "invalid_reference",
      "Use a scope alias such as notes:/Inbox/idea.md.",
    );
  }
  if (parsed.kind === "alias") {
    if (!scopeAliasSchema.safeParse(parsed.alias).success) {
      return failure("invalid_reference", "That scope alias is not valid.");
    }
    const scope = input.scopes.find((item) => item.alias === parsed.alias);
    if (!scope)
      return failure(
        "unknown_alias",
        `No folder is registered as ${parsed.alias}:.`,
      );
    if (input.purpose === "read" && !scope.read) {
      return failure("read_denied", `${scope.alias}: is not readable.`);
    }
    if (input.purpose === "write" && !scope.write) {
      return failure("write_denied", `${scope.alias}: is not writable.`);
    }
    const candidate =
      parsed.parts.length === 0
        ? scope.path
        : win32.join(scope.path, ...parsed.parts);
    const contained = containedFinal(scope.path, candidate, input.purpose);
    if (!contained.ok) return contained;
    return {
      ok: true,
      path: {
        display: relativeDisplay(scope.alias, scope.path, contained.finalPath),
        absolute: contained.finalPath,
        scopeId: scope.id,
        read: scope.read,
        write: scope.write,
      },
    };
  }

  if (isProtectedLocation(parsed.path)) {
    return failure("protected", summaryFor("protected"));
  }
  let best: { scope: FileScopeRecord; finalPath: string } | null = null;
  let protectedHit: PathFailure | null = null;
  for (const scope of input.scopes) {
    const contained = containedFinal(scope.path, parsed.path, input.purpose);
    if (!contained.ok) {
      if (contained.code === "protected") protectedHit = contained;
      continue;
    }
    if (
      !best ||
      normalized(scope.path).length > normalized(best.scope.path).length
    ) {
      best = { scope, finalPath: contained.finalPath };
    }
  }
  if (!best && protectedHit) return protectedHit;
  if (best) {
    if (input.purpose === "read" && !best.scope.read) {
      return failure("read_denied", `${best.scope.alias}: is not readable.`);
    }
    if (input.purpose === "write" && !best.scope.write) {
      return failure("write_denied", `${best.scope.alias}: is not writable.`);
    }
    return {
      ok: true,
      path: {
        display: relativeDisplay(
          best.scope.alias,
          best.scope.path,
          best.finalPath,
        ),
        absolute: best.finalPath,
        scopeId: best.scope.id,
        read: best.scope.read,
        write: best.scope.write,
      },
    };
  }

  if (input.purpose === "write") {
    return failure(
      "outside_scope",
      "Writes stay inside a writable folder alias.",
    );
  }
  const now = input.now ?? Date.now();
  for (const grant of input.grants) {
    if (grant.expiresAt <= now) continue;
    const contained = containedFinal(grant.path, parsed.path, "read");
    if (!contained.ok) continue;
    const sameFile =
      grant.kind === "file" &&
      isFinalPathInside(grant.path, contained.finalPath) &&
      isFinalPathInside(contained.finalPath, grant.path);
    const insideDirectory =
      grant.kind === "directory" &&
      isFinalPathInside(grant.path, contained.finalPath);
    if (!sameFile && !insideDirectory) continue;
    return {
      ok: true,
      path: {
        display: displayFinalPath(contained.finalPath),
        absolute: contained.finalPath,
        grantId: grant.id,
        read: true,
        write: false,
      },
    };
  }
  if (input.actor === "model") {
    return failure(
      "outside_scope",
      "That path is outside registered folders. A path in the message is not permission to open it.",
    );
  }
  return failure(
    "needs_selection",
    "That path is outside registered folders. Select the file or folder to allow a bounded read.",
  );
}
