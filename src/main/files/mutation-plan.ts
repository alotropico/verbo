import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  actionResultSchema,
  type ActionResult,
  type ActionSubject,
  type ActorKind,
} from "../../shared/action-contract";
import {
  FILE_MUTATION_LIMITS,
  type FileFormat,
  type FilesBatchArgs,
  type FilesCreateArgs,
  type FilesEditArgs,
  type FilesTrashArgs,
  type FilesTransferArgs,
  type OperationReview,
  type OperationReviewFailure,
} from "../../shared/file-mutation";
import { displayFinalPath, type FileScopeRecord } from "../../shared/files";
import {
  createOperationStore,
  type StoredOperationItem,
} from "../db/operations";
import { createQuerySnapshotStore } from "../db/query-snapshots";
import { persistCommandReceipt } from "../db/command-receipts";
import type { ScopeStore } from "../db/scopes";
import { mutationPorts, operationSession } from "./mutation-ports";
import {
  dispatchPreparedFileChild,
  consumePreparedFileChild,
} from "./prepared-file-child";
import { recordFileResource } from "./resource-events";
import {
  classifyVaultTarget,
  guardNativeVaultTargets,
} from "./vault-target-policy";
import { obsidianTranslationAvailable } from "../obsidian/config";
import { permitsCommand } from "../agents/policy";
import {
  isProtectedLocation,
  parseFileReference,
  qualifyFileReference,
  resolveFileReference,
} from "./path-policy";
import {
  resolveContainedPath,
  windowsFileFlags,
  type ContainmentCode,
} from "./windows-containment";

type Fingerprint = {
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
  sha256: string | null;
  directory: boolean;
  reparse: boolean;
};

type Located = {
  absolute: string;
  display: string;
  exists: boolean;
  directory: boolean;
  write: boolean;
};

type StepFailure = {
  ok: false;
  code: string;
  summary: string;
  subjects?: ActionSubject[];
};

type RawItem =
  | {
      kind: "create_file";
      to: string;
      content: string;
      format?: FileFormat;
    }
  | { kind: "create_directory"; to: string }
  | {
      kind: "edit";
      from: string;
      mode: "full" | "replace" | "lines";
      content?: string;
      find?: string;
      replace?: string;
      expectedMatches?: number;
      startLine?: number;
      endLine?: number;
      format?: FileFormat;
    }
  | {
      kind: "copy" | "move" | "rename";
      from: string;
      to: string;
      disambiguate?: boolean;
    }
  | { kind: "trash"; from: string };

type SubmitBase = {
  receiptId?: string;
  database: DatabaseSync;
  scopes: ScopeStore;
  actor: ActorKind;
  threadId: string;
  turnId?: string;
  signal?: AbortSignal;
};

export type MutationSubmit = SubmitBase &
  (
    | { action: "files.create"; args: FilesCreateArgs }
    | { action: "files.edit"; args: FilesEditArgs }
    | {
        action: "files.copy" | "files.move" | "files.rename";
        args: FilesTransferArgs;
      }
    | { action: "files.trash"; args: FilesTrashArgs }
    | { action: "files.batch"; args: FilesBatchArgs }
    | { action: "files.undo"; args: { operationId: string } }
  );

const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu;
const BINARY = new Set([
  "exe",
  "dll",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "zip",
  "7z",
  "pdf",
  "mp3",
  "mp4",
  "bin",
]);

function pathSubjects(
  source?: { absolute: string } | null,
  destination?: { absolute: string } | null,
): ActionSubject[] {
  const subjects: ActionSubject[] = [];
  if (source?.absolute)
    subjects.push({ role: "source", path: source.absolute });
  if (destination?.absolute)
    subjects.push({ role: "destination", path: destination.absolute });
  return subjects;
}

function subjectsFromPlanned(
  items: Array<{ sourcePath: string | null; destinationPath: string | null }>,
): ActionSubject[] {
  const subjects: ActionSubject[] = [];
  for (const item of items) {
    if (item.sourcePath)
      subjects.push({ role: "source", path: item.sourcePath });
    if (item.destinationPath)
      subjects.push({ role: "destination", path: item.destinationPath });
    if (subjects.length >= 40) break;
  }
  return subjects.slice(0, 40);
}

function failure(
  action: string,
  code: string,
  summary: string,
  subjects?: ActionSubject[],
): ActionResult {
  return actionResultSchema.parse({
    action,
    status: code === "vault_backend_required" ? "not_supported" : "error",
    code,
    summary,
    ...(subjects?.length ? { subjects: subjects.slice(0, 40) } : {}),
  });
}

async function routeVaultBackend(
  input: MutationSubmit,
  items: RawItem[],
): Promise<ActionResult | undefined> {
  if (
    items.length !== 1 ||
    input.action === "files.batch" ||
    input.action === "files.undo"
  )
    return;
  const item = items[0]!;
  if (
    item.kind === "create_directory" ||
    item.kind === "copy" ||
    (item.kind === "edit" && item.mode !== "full")
  )
    return;
  const operation =
    item.kind === "create_file"
      ? "create"
      : item.kind === "trash"
        ? "delete"
        : item.kind;
  if (!obsidianTranslationAvailable(operation)) return;
  const scopes = input.scopes.list();
  const reference = "from" in item ? item.from : item.to;
  const source = locate({
    reference,
    purpose: "write",
    actor: input.actor,
    scopes,
    grants: input.scopes.activeGrants(),
    allowMissing: true,
  });
  if (!source.ok || source.path.directory) return;
  const hits = classifyVaultTarget({ path: source.path.absolute, scopes });
  if (
    hits.length !== 1 ||
    hits[0]!.relation !== "inside" ||
    !hits[0]!.relativePath
  )
    return;
  const selected = hits[0]!;
  const action = `obsidian.${operation}`;
  if (!permitsCommand(action))
    return {
      action: input.action,
      status: "denied",
      code: "invocation_forbidden",
      summary:
        "This vault target requires authorization for both the semantic file operation and its Obsidian backend.",
    };
  const args: Record<string, unknown> = {
    vault: selected.scope.id,
    path: selected.relativePath,
  };
  if (item.kind === "create_file" || item.kind === "edit")
    args.content = item.content ?? "";
  if (item.kind === "edit")
    args.revision = capture(source.path.absolute).sha256;
  if (item.kind === "move" || item.kind === "rename") {
    const destination = locate({
      reference: item.to,
      purpose: "write",
      actor: input.actor,
      scopes,
      grants: input.scopes.activeGrants(),
      allowMissing: true,
    });
    if (!destination.ok || destination.path.directory) return;
    const destinations = classifyVaultTarget({
      path: destination.path.absolute,
      scopes,
    });
    if (
      destinations.length !== 1 ||
      destinations[0]!.scope.id !== selected.scope.id ||
      !destinations[0]!.relativePath
    )
      return;
    args.to = destinations[0]!.relativePath;
  }
  const { registryForDatabase } = await import("../capabilities/catalog");
  return registryForDatabase(input.database).invoke(action, args, {
    actor: input.actor,
    threadId: input.threadId,
    turnId: input.turnId,
    signal: input.signal,
    receiptId: input.receiptId,
    derivedDispatch: true,
  });
}

function comparable(candidate: string): string {
  return displayFinalPath(candidate)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

function summaryFor(code: ContainmentCode | string): string {
  if (code === "unc") return "Network paths are not a file scope.";
  if (code === "device") return "Device paths are blocked.";
  if (code === "root") return "The scope root itself cannot be replaced.";
  if (code === "protected") return "That location is protected.";
  if (code === "missing") return "That path does not exist.";
  if (code === "unopenable") return "That path could not be opened.";
  if (code === "invalid" || code === "invalid_reference") {
    return "That path is not valid. A filename is saved in the default folder.";
  }
  if (code === "outside" || code === "outside_scope") {
    return "Writes stay inside a writable folder alias.";
  }
  if (code === "write_denied") return "That folder is not writable.";
  if (code === "read_denied") return "That folder is not readable.";
  if (code === "unknown_alias") return "That folder alias is not registered.";
  return "That path is outside the authorized folder.";
}

function legalSegment(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.endsWith(" ") || name.endsWith(".")) return false;
  if (DEVICE.test(name) || name.length > 255) return false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 32) return false;
    const char = name[index];
    if (
      char === "<" ||
      char === ">" ||
      char === ":" ||
      char === '"' ||
      char === "|" ||
      char === "?" ||
      char === "*"
    ) {
      return false;
    }
  }
  return true;
}

function aliasDisplay(alias: string, root: string, absolute: string): string {
  const base = displayFinalPath(root).replace(/[\\/]+$/u, "");
  const candidate = displayFinalPath(absolute).replace(/[\\/]+$/u, "");
  if (candidate.toLowerCase() === base.toLowerCase()) return `${alias}:/`;
  const prefix = `${base}\\`;
  const rest = candidate.toLowerCase().startsWith(prefix.toLowerCase())
    ? candidate.slice(prefix.length)
    : candidate;
  return `${alias}:/${rest.split("\\").join("/")}`;
}

function emptyState(): Fingerprint {
  return {
    exists: false,
    size: null,
    mtimeMs: null,
    sha256: null,
    directory: false,
    reparse: false,
  };
}

function capture(absolute: string): Fingerprint {
  try {
    const stats = lstatSync(absolute);
    const flags = windowsFileFlags(absolute);
    const directory = stats.isDirectory();
    let sha256: string | null = null;
    if (stats.isFile() && stats.size <= FILE_MUTATION_LIMITS.maxContentChars) {
      sha256 = createHash("sha256")
        .update(readFileSync(absolute))
        .digest("hex");
    }
    return {
      exists: true,
      size: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
      sha256,
      directory,
      reparse: flags?.reparse === true || stats.isSymbolicLink(),
    };
  } catch {
    return emptyState();
  }
}

function sameState(absolute: string, before: Fingerprint): boolean {
  const current = capture(absolute);
  return (
    current.exists === before.exists &&
    current.size === before.size &&
    current.mtimeMs === before.mtimeMs &&
    current.sha256 === before.sha256 &&
    current.directory === before.directory &&
    current.reparse === before.reparse
  );
}

function namedReparse(candidate: string): boolean {
  return windowsFileFlags(candidate)?.reparse === true;
}

function locate(input: {
  reference: string;
  purpose: "read" | "write";
  actor: ActorKind;
  scopes: readonly FileScopeRecord[];
  grants: ReturnType<ScopeStore["activeGrants"]>;
  allowMissing: boolean;
}): { ok: true; path: Located } | StepFailure {
  const parsed = qualifyFileReference(
    parseFileReference(input.reference),
    input.scopes,
  );
  if (parsed.kind === "invalid") {
    return {
      ok: false,
      code: "invalid_reference",
      summary: summaryFor("invalid_reference"),
    };
  }
  if (parsed.kind === "no_default") {
    return {
      ok: false,
      code: "no_default_scope",
      summary:
        "No default save folder is registered. Use an alias such as tmp:/note.md.",
    };
  }
  if (parsed.kind === "alias") {
    const scope = input.scopes.find((item) =>
      item.aliases.includes(parsed.alias),
    );
    if (!scope) {
      return {
        ok: false,
        code: "unknown_alias",
        summary: `No folder is registered as ${parsed.alias}:.`,
      };
    }
    if (input.purpose === "write" && !scope.write) {
      return {
        ok: false,
        code: "write_denied",
        summary: `${parsed.alias}: is not writable.`,
      };
    }
    if (input.purpose === "read" && !scope.read) {
      return {
        ok: false,
        code: "read_denied",
        summary: `${parsed.alias}: is not readable.`,
      };
    }
    const candidate =
      parsed.parts.length === 0
        ? scope.path
        : win32.join(scope.path, ...parsed.parts);
    return finishLocate(scope, candidate, input, parsed.alias);
  }
  if (isProtectedLocation(parsed.path)) {
    return { ok: false, code: "protected", summary: summaryFor("protected") };
  }
  let best: { scope: FileScopeRecord; candidate: string } | null = null;
  for (const scope of input.scopes) {
    const contained = resolveContainedPath(
      scope.path,
      parsed.path,
      input.purpose,
    );
    if (!contained.ok) continue;
    if (input.purpose === "read" && !scope.read) continue;
    if (
      !best ||
      comparable(scope.path).length > comparable(best.scope.path).length
    ) {
      best = { scope, candidate: parsed.path };
    }
  }
  if (best && input.purpose === "write" && !best.scope.write) {
    return {
      ok: false,
      code: "write_denied",
      summary: `${best.scope.alias}: is not writable.`,
    };
  }
  if (best) return finishLocate(best.scope, best.candidate, input);
  if (input.purpose === "write") {
    return {
      ok: false,
      code: "outside_scope",
      summary: summaryFor("outside_scope"),
    };
  }
  const resolved = resolveFileReference({
    reference: input.reference,
    purpose: "read",
    actor: input.actor,
    scopes: input.scopes,
    grants: input.grants,
  });
  if (!resolved.ok)
    return { ok: false, code: resolved.code, summary: resolved.summary };
  const state = capture(resolved.path.absolute);
  if (state.reparse) {
    return {
      ok: false,
      code: "link",
      summary: "Links and junctions are not mutated.",
    };
  }
  return {
    ok: true,
    path: {
      absolute: displayFinalPath(resolved.path.absolute),
      display: resolved.path.display,
      exists: state.exists,
      directory: state.directory,
      write: false,
    },
  };
}

function finishLocate(
  scope: FileScopeRecord,
  candidate: string,
  input: { purpose: "read" | "write"; allowMissing: boolean },
  displayAlias = scope.alias,
): { ok: true; path: Located } | StepFailure {
  if (namedReparse(candidate)) {
    return {
      ok: false,
      code: "link",
      summary: "Links and junctions are not mutated.",
    };
  }
  if (isProtectedLocation(candidate)) {
    return { ok: false, code: "protected", summary: summaryFor("protected") };
  }
  const contained = resolveContainedPath(scope.path, candidate, input.purpose);
  if (!contained.ok) {
    return {
      ok: false,
      code: contained.code,
      summary: summaryFor(contained.code),
    };
  }
  if (contained.exists) {
    const absolute = displayFinalPath(contained.finalPath);
    const state = capture(absolute);
    if (state.reparse) {
      return {
        ok: false,
        code: "link",
        summary: "Links and junctions are not mutated.",
      };
    }
    return {
      ok: true,
      path: {
        absolute,
        display: aliasDisplay(displayAlias, scope.path, absolute),
        exists: true,
        directory: state.directory,
        write: scope.write,
      },
    };
  }
  if (!input.allowMissing) {
    return { ok: false, code: "missing", summary: summaryFor("missing") };
  }
  const leafParts = contained.leaf
    .split("\\")
    .filter((part) => part.length > 0);
  if (leafParts.some((part) => !legalSegment(part))) {
    return {
      ok: false,
      code: "invalid",
      summary: "That file name is not allowed.",
    };
  }
  const absolute = displayFinalPath(
    win32.join(contained.finalParent, contained.leaf),
  );
  return {
    ok: true,
    path: {
      absolute,
      display: aliasDisplay(displayAlias, scope.path, absolute),
      exists: false,
      directory: false,
      write: scope.write,
    },
  };
}

function formatFor(reference: string, explicit?: FileFormat): FileFormat {
  if (explicit) return explicit;
  const extension = win32.extname(reference).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return "text";
}

function decodeText(buffer: Buffer): { text: string; bom: boolean } | null {
  const bom = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const body = bom ? buffer.subarray(3) : buffer;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (text.includes("\0")) return null;
    return { text, bom };
  } catch {
    return null;
  }
}

function lineDiff(before: string, after: string): string {
  const left = before.split(/\r?\n/u);
  const right = after.split(/\r?\n/u);
  const lines: string[] = [];
  const max = Math.max(left.length, right.length);
  for (
    let index = 0;
    index < max && lines.join("\n").length < 1800;
    index += 1
  ) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) lines.push(`- ${left[index]}`);
    if (right[index] !== undefined) lines.push(`+ ${right[index]}`);
    if (lines.length >= 40) break;
  }
  if (lines.length === 0) return "(no text change)";
  return lines.join("\n").slice(0, 1800);
}

function nextText(
  item: Extract<RawItem, { kind: "edit" }>,
  current: { text: string; bom: boolean },
): { ok: true; text: string } | StepFailure {
  if (item.mode === "full") {
    return { ok: true, text: item.content ?? "" };
  }
  if (item.mode === "replace") {
    const find = item.find ?? "";
    let count = 0;
    let cursor = 0;
    let next = "";
    while (cursor <= current.text.length) {
      const found = current.text.indexOf(find, cursor);
      if (found < 0) {
        next += current.text.slice(cursor);
        break;
      }
      count += 1;
      next += current.text.slice(cursor, found) + (item.replace ?? "");
      cursor = found + find.length;
    }
    if (count !== item.expectedMatches) {
      return {
        ok: false,
        code: "match_count",
        summary: `Expected ${item.expectedMatches} matches and found ${count}.`,
      };
    }
    return { ok: true, text: next };
  }
  const ending = current.text.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.text.split(/\r?\n/u);
  const start = item.startLine ?? 0;
  const end = item.endLine ?? 0;
  if (start < 1 || end < start || start > lines.length) {
    return {
      ok: false,
      code: "invalid_args",
      summary: "That line range is outside the file.",
    };
  }
  const replacement = (item.content ?? "").split(/\r?\n/u);
  return {
    ok: true,
    text: [
      ...lines.slice(0, start - 1),
      ...replacement,
      ...lines.slice(end),
    ].join(ending),
  };
}

function inspectTree(root: string): { ok: true; count: number } | StepFailure {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return {
        ok: false,
        code: "unopenable",
        summary: "A folder could not be read.",
      };
    }
    for (const entry of entries) {
      count += 1;
      if (count > FILE_MUTATION_LIMITS.maxTreeEntries) {
        return {
          ok: false,
          code: "incomplete",
          summary: "That folder is too large to plan.",
        };
      }
      const full = win32.join(current, entry.name);
      if (windowsFileFlags(full)?.reparse || entry.isSymbolicLink()) {
        return {
          ok: false,
          code: "link",
          summary: "A link inside that folder blocks the operation.",
        };
      }
      if (entry.isDirectory()) pending.push(full);
    }
  }
  return { ok: true, count };
}

function suffixedLeaf(absolute: string, index: number): string {
  const extension = win32.extname(absolute);
  const base = win32.basename(absolute, extension);
  return `${base} (${index})${extension}`;
}

function suggestion(absolute: string): string {
  for (let index = 2; index < 100; index += 1) {
    const leaf = suffixedLeaf(absolute, index);
    if (!existsSync(win32.join(win32.dirname(absolute), leaf))) return leaf;
  }
  return suffixedLeaf(absolute, 2);
}

function allocateFreeName(
  destination: Located,
  reserved: Set<string>,
): { ok: true; path: Located } | StepFailure {
  const directory = win32.dirname(destination.absolute);
  for (let index = 2; index < 100_000; index += 1) {
    const leaf = suffixedLeaf(destination.absolute, index);
    if (!legalSegment(leaf)) break;
    const absolute = displayFinalPath(win32.join(directory, leaf));
    const key = comparable(absolute);
    if (reserved.has(key) || existsSync(absolute)) continue;
    const slash = destination.display.lastIndexOf("/");
    const display =
      slash === -1 ? leaf : `${destination.display.slice(0, slash + 1)}${leaf}`;
    return {
      ok: true,
      path: {
        absolute,
        display,
        exists: false,
        directory: false,
        write: destination.write,
      },
    };
  }
  return {
    ok: false,
    code: "collision",
    summary: `${destination.display} already exists. No free name is available in that folder.`,
  };
}

function snapshotFresh(database: DatabaseSync, snapshotId: string): boolean {
  const store = createQuerySnapshotStore(database);
  for (const dir of store.directories(snapshotId)) {
    try {
      const stats = lstatSync(dir.absolutePath);
      if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        Math.trunc(stats.mtimeMs) !== dir.modifiedAt
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  for (const item of store.validationRows(snapshotId)) {
    try {
      const stats = lstatSync(item.absolutePath);
      if (Math.trunc(stats.mtimeMs) !== (item.modifiedAt ?? -1)) return false;
      if (item.kind === "file" && stats.size !== item.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function resultPaths(input: {
  database: DatabaseSync;
  threadId: string;
  token: string;
  generation: number;
  now: number;
}): { ok: true; paths: string[] } | StepFailure {
  const store = createQuerySnapshotStore(input.database);
  store.purge(input.now);
  const cursor = store.takeCursor(input.token);
  if (cursor && cursor.expiresAt <= input.now) {
    return {
      ok: false,
      code: "stale_cursor",
      summary: "That result set expired.",
    };
  }
  const snapshot = store.snapshot(cursor?.snapshotId ?? input.token);
  if (!snapshot || snapshot.expiresAt <= input.now) {
    return {
      ok: false,
      code: "stale_cursor",
      summary: "That result set expired.",
    };
  }
  if (snapshot.threadId !== input.threadId) {
    return {
      ok: false,
      code: "session_mismatch",
      summary: "That result set belongs to another conversation.",
    };
  }
  if (snapshot.scopeGeneration !== input.generation) {
    return {
      ok: false,
      code: "stale_cursor",
      summary: "The folders changed. Run the query again.",
    };
  }
  if (!snapshot.complete) {
    return {
      ok: false,
      code: "incomplete",
      summary: "That result set is incomplete.",
    };
  }
  if (!snapshotFresh(input.database, snapshot.id)) {
    return {
      ok: false,
      code: "stale_cursor",
      summary: "Those files changed. Run the query again.",
    };
  }
  const count = store.countItems(snapshot.id);
  if (count > FILE_MUTATION_LIMITS.maxItems) {
    return {
      ok: false,
      code: "too_large",
      summary: `A result set can change at most ${FILE_MUTATION_LIMITS.maxItems} items. This one is larger, so nothing changed.`,
    };
  }
  const items = store.page(snapshot.id, 0, count, snapshot.sort);
  if (items.some((item) => item.link || item.kind === "link")) {
    return {
      ok: false,
      code: "link",
      summary: "Links and junctions are not mutated.",
    };
  }
  return { ok: true, paths: items.map((item) => item.absolutePath) };
}

type FolderSelection = {
  in: string;
  formats?: string[];
  pattern?: string;
};

function extensionOf(name: string): string {
  const extension = win32.extname(name);
  return extension.startsWith(".") ? extension.slice(1).toLowerCase() : "";
}

function patternMatches(
  pattern: RegExp,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => {
    pattern.lastIndex = 0;
    return pattern.test(candidate);
  });
}

function folderSelectionTooLarge(): string {
  return `A folder selection can change at most ${FILE_MUTATION_LIMITS.maxItems} files. This one is larger, so nothing changed. Narrow with formats or a pattern that matches fewer files. No command selects a larger set.`;
}

function selectFolder(
  input: MutationSubmit,
  selection: FolderSelection,
): { ok: true; paths: string[]; absolutes: Map<string, string> } | StepFailure {
  const root = locate({
    reference: selection.in,
    purpose: "read",
    actor: input.actor,
    scopes: input.scopes.list(),
    grants: input.scopes.activeGrants(),
    allowMissing: false,
  });
  if (!root.ok) return root;
  if (!root.path.exists || !root.path.directory) {
    return { ok: false, code: "invalid_args", summary: "in must be a folder." };
  }
  const formats = (selection.formats ?? []).map((format) =>
    format.replace(/^\.+/u, "").toLowerCase(),
  );
  let expression: RegExp | undefined;
  if (selection.pattern !== undefined) {
    try {
      expression = new RegExp(selection.pattern, "u");
    } catch {
      return {
        ok: false,
        code: "invalid_args",
        summary: "pattern must be a valid regex.",
      };
    }
  }
  const paths: string[] = [];
  const absolutes = new Map<string, string>();
  const pending = [root.path.absolute];
  let examined = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    let listing: Dirent[];
    try {
      if (namedReparse(directory)) continue;
      const stats = lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      listing = readdirSync(directory, { withFileTypes: true });
    } catch {
      return {
        ok: false,
        code: "unreadable",
        summary: "A folder in that path could not be opened.",
      };
    }
    listing.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "accent",
      }),
    );
    for (const entry of listing) {
      examined += 1;
      if (examined > FILE_MUTATION_LIMITS.maxTreeEntries) {
        return {
          ok: false,
          code: "too_large",
          summary: "That folder is too large to select at once.",
        };
      }
      const absolute = displayFinalPath(win32.join(directory, entry.name));
      if (namedReparse(absolute) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (formats.length > 0 && !formats.includes(extensionOf(entry.name))) {
        continue;
      }
      const relative = win32
        .relative(root.path.absolute, absolute)
        .split("\\")
        .join("/");
      const display = `${root.path.display.replace(/[\\/]+$/u, "")}/${relative}`;
      if (
        expression &&
        !patternMatches(expression, [
          display,
          relative,
          absolute,
          absolute.replace(/\\/gu, "/"),
        ])
      ) {
        continue;
      }
      if (paths.length >= FILE_MUTATION_LIMITS.maxItems) {
        return {
          ok: false,
          code: "too_large",
          summary: folderSelectionTooLarge(),
        };
      }
      paths.push(display);
      absolutes.set(display, absolute);
    }
  }
  if (paths.length === 0) {
    return {
      ok: false,
      code: "missing",
      summary: "No files matched that folder.",
    };
  }
  paths.sort((left, right) => left.localeCompare(right));
  return { ok: true, paths, absolutes };
}

function folderTransfers(
  input: MutationSubmit,
  selection: FolderSelection,
  toDirectory: string,
  kind: "copy" | "move",
):
  | {
      ok: true;
      items: Array<{
        kind: "copy" | "move";
        from: string;
        to: string;
        disambiguate: true;
      }>;
    }
  | StepFailure {
  const selected = selectFolder(input, selection);
  if (!selected.ok) return selected;
  const items: Array<{
    kind: "copy" | "move";
    from: string;
    to: string;
    disambiguate: true;
  }> = [];
  const directory = locate({
    reference: toDirectory,
    purpose: "read",
    actor: input.actor,
    scopes: input.scopes.list(),
    grants: input.scopes.activeGrants(),
    allowMissing: true,
  });
  for (const from of selected.paths) {
    const to = joinDestination(toDirectory, win32.basename(from));
    const absolute = selected.absolutes.get(from);
    const stays =
      directory.ok && absolute
        ? comparable(win32.dirname(absolute)) ===
          comparable(directory.path.absolute)
        : comparable(from) === comparable(to);
    if (stays) continue;
    items.push({ kind, from, to, disambiguate: true });
  }
  if (items.length === 0) {
    return {
      ok: false,
      code: "invalid_args",
      summary: "Those files are already in the destination.",
    };
  }
  if (items.length > FILE_MUTATION_LIMITS.maxItems) {
    return {
      ok: false,
      code: "too_large",
      summary: folderSelectionTooLarge(),
    };
  }
  return { ok: true, items };
}

function expandBatch(
  input: Extract<MutationSubmit, { action: "files.batch" }>,
): { ok: true; items: RawItem[] } | StepFailure {
  const items: RawItem[] = [];
  for (const item of input.args.items) {
    if (item.action === "files.create") {
      items.push(
        item.kind === "directory"
          ? { kind: "create_directory", to: item.path }
          : {
              kind: "create_file",
              to: item.path,
              content: item.content ?? "",
              ...(item.format ? { format: item.format } : {}),
            },
      );
      continue;
    }
    if (item.action === "files.trash") {
      if (item.in) {
        const selected = selectFolder(input, {
          in: item.in,
          formats: item.formats,
          pattern: item.pattern,
        });
        if (!selected.ok) return selected;
        for (const from of selected.paths) items.push({ kind: "trash", from });
        continue;
      }
      items.push({ kind: "trash", from: item.path ?? "" });
      continue;
    }
    if (item.action === "files.edit") {
      const { action, path, ...edit } = item;
      items.push({
        kind: action.slice("files.".length) as "edit",
        from: path,
        ...edit,
      });
      continue;
    }
    if (item.in) {
      if (item.action === "files.rename") {
        return {
          ok: false,
          code: "invalid_args",
          summary: "Rename needs an explicit destination for each file.",
        };
      }
      const transferred = folderTransfers(
        input,
        { in: item.in, formats: item.formats, pattern: item.pattern },
        item.toDirectory ?? "",
        item.action === "files.copy" ? "copy" : "move",
      );
      if (!transferred.ok) return transferred;
      items.push(...transferred.items);
      continue;
    }
    const kind = item.action.slice("files.".length) as
      "copy" | "move" | "rename";
    items.push({ kind, from: item.from ?? "", to: item.to ?? "" });
  }
  if (items.length > FILE_MUTATION_LIMITS.maxItems) {
    return {
      ok: false,
      code: "too_large",
      summary: `One operation can change at most ${FILE_MUTATION_LIMITS.maxItems} items. This plan is larger, so nothing changed.`,
    };
  }
  return { ok: true, items };
}

function normalize(
  input: MutationSubmit,
  generation: number,
  now: number,
): { ok: true; items: RawItem[] } | StepFailure {
  if (input.action === "files.undo") return undoItems(input, now);
  if (input.action === "files.create") {
    const rows =
      input.args.items ??
      (input.args.path && input.args.kind
        ? [
            {
              path: input.args.path,
              kind: input.args.kind,
              content: input.args.content,
              format: input.args.format,
            },
          ]
        : []);
    return {
      ok: true,
      items: rows.map((row) =>
        row.kind === "directory"
          ? { kind: "create_directory" as const, to: row.path }
          : {
              kind: "create_file" as const,
              to: row.path,
              content: row.content ?? "",
              ...(row.format ? { format: row.format } : {}),
            },
      ),
    };
  }
  if (input.action === "files.edit") {
    const {
      path,
      mode,
      content,
      find,
      replace,
      expectedMatches,
      startLine,
      endLine,
      format,
    } = input.args;
    return {
      ok: true,
      items: [
        {
          kind: "edit",
          from: path,
          mode,
          ...(content !== undefined ? { content } : {}),
          ...(find !== undefined ? { find } : {}),
          ...(replace !== undefined ? { replace } : {}),
          ...(expectedMatches !== undefined ? { expectedMatches } : {}),
          ...(startLine !== undefined ? { startLine } : {}),
          ...(endLine !== undefined ? { endLine } : {}),
          ...(format !== undefined ? { format } : {}),
        },
      ],
    };
  }
  if (input.action === "files.trash") {
    if (input.args.resultSet) {
      const paths = resultPaths({
        database: input.database,
        threadId: input.threadId,
        token: input.args.resultSet,
        generation,
        now,
      });
      if (!paths.ok) return paths;
      return {
        ok: true,
        items: paths.paths.map((from) => ({ kind: "trash" as const, from })),
      };
    }
    if (input.args.in) {
      const selected = selectFolder(input, {
        in: input.args.in,
        formats: input.args.formats,
        pattern: input.args.pattern,
      });
      if (!selected.ok) return selected;
      return {
        ok: true,
        items: selected.paths.map((from) => ({ kind: "trash" as const, from })),
      };
    }
    const paths =
      input.args.paths ?? (input.args.path ? [input.args.path] : []);
    return {
      ok: true,
      items: paths.map((from) => ({ kind: "trash" as const, from })),
    };
  }
  if (input.action === "files.batch") return expandBatch(input);
  if (input.args.in) {
    if (input.action === "files.rename") {
      return {
        ok: false,
        code: "invalid_args",
        summary: "Rename needs an explicit destination for each file.",
      };
    }
    return folderTransfers(
      input,
      {
        in: input.args.in,
        formats: input.args.formats,
        pattern: input.args.pattern,
      },
      input.args.toDirectory ?? "",
      input.action === "files.copy" ? "copy" : "move",
    );
  }
  if (input.args.resultSet) {
    if (input.action === "files.rename") {
      return {
        ok: false,
        code: "invalid_args",
        summary: "Rename needs an explicit destination for each file.",
      };
    }
    const paths = resultPaths({
      database: input.database,
      threadId: input.threadId,
      token: input.args.resultSet,
      generation,
      now,
    });
    if (!paths.ok) return paths;
    const directory = input.args.toDirectory ?? "";
    const kind = input.action === "files.copy" ? "copy" : "move";
    return {
      ok: true,
      items: paths.paths.map((from) => ({
        kind,
        from,
        to: joinDestination(directory, win32.basename(from)),
        disambiguate: true,
      })),
    };
  }
  const pairs =
    input.args.items ??
    (input.args.from && input.args.to
      ? [{ from: input.args.from, to: input.args.to }]
      : []);
  const kind =
    input.action === "files.copy"
      ? "copy"
      : input.action === "files.move"
        ? "move"
        : "rename";
  return {
    ok: true,
    items: pairs.map((pair) => ({ kind, from: pair.from, to: pair.to })),
  };
}

function joinDestination(directory: string, name: string): string {
  if (
    directory.endsWith(":") ||
    directory.endsWith(":/") ||
    directory.endsWith(":\\")
  ) {
    return `${directory.replace(/[\\/]+$/u, "")}/${name}`;
  }
  return directory.includes(":") && !win32.isAbsolute(directory)
    ? `${directory.replace(/[\\/]+$/u, "")}/${name}`
    : win32.join(directory, name);
}

function undoItems(
  input: Extract<MutationSubmit, { action: "files.undo" }>,
  now: number,
): { ok: true; items: RawItem[] } | StepFailure {
  const store = createOperationStore(input.database);
  store.purge(now);
  const plan = store.get(input.args.operationId);
  if (!plan || plan.threadId !== input.threadId) {
    return {
      ok: false,
      code: "missing",
      summary: "That operation is not in this conversation.",
    };
  }
  if (plan.status !== "succeeded" && plan.status !== "partial") {
    return {
      ok: false,
      code: "unsupported",
      summary: "Only a finished rename or move can be undone.",
    };
  }
  const reversible = store
    .items(plan.id)
    .filter(
      (item) =>
        item.status === "succeeded" &&
        (item.kind === "move" || item.kind === "rename"),
    )
    .reverse();
  if (reversible.length === 0) {
    return {
      ok: false,
      code: "unsupported",
      summary: "Trash and edits have no guarded undo.",
    };
  }
  const items: RawItem[] = [];
  const restored = new Map<string, Fingerprint>();
  for (const item of reversible) {
    if (!item.sourcePath || !item.destinationPath || !item.afterJson) continue;
    const after = JSON.parse(item.afterJson) as Fingerprint;
    const virtual = restored.get(comparable(item.destinationPath));
    const matches = virtual
      ? JSON.stringify(virtual) === JSON.stringify(after)
      : sameState(item.destinationPath, after);
    if (!matches || existsSync(item.sourcePath)) continue;
    const kind =
      comparable(win32.dirname(item.sourcePath)) ===
      comparable(win32.dirname(item.destinationPath))
        ? "rename"
        : "move";
    items.push({ kind, from: item.destinationPath, to: item.sourcePath });
    restored.delete(comparable(item.destinationPath));
    restored.set(comparable(item.sourcePath), after);
  }
  if (items.length === 0) {
    return {
      ok: false,
      code: "stale_source",
      summary: "Those files changed, so undo stopped.",
    };
  }
  return { ok: true, items };
}

type Planned = {
  kind: RawItem["kind"];
  sourcePath: string | null;
  destinationPath: string | null;
  sourceDisplay: string | null;
  destinationDisplay: string | null;
  content: string | null;
  format: string | null;
  before: Fingerprint;
  expected: Record<string, unknown>;
  descendants: number;
  rejection?: { code: string; summary: string };
};

function preflight(
  input: MutationSubmit,
  raw: RawItem[],
): { ok: true; items: Planned[]; risks: string[] } | StepFailure {
  const scopes = input.scopes.list();
  const grants = input.scopes.activeGrants();
  const resolved: Array<{
    raw: RawItem;
    source?: Located;
    destination?: Located;
  }> = [];
  for (const item of raw) {
    if (item.kind === "create_file" || item.kind === "create_directory") {
      const destination = locate({
        reference: item.to,
        purpose: "write",
        actor: input.actor,
        scopes,
        grants,
        allowMissing: true,
      });
      if (!destination.ok) return destination;
      resolved.push({ raw: item, destination: destination.path });
      continue;
    }
    if (item.kind === "edit" || item.kind === "trash") {
      const source = locate({
        reference: item.from,
        purpose: "write",
        actor: input.actor,
        scopes,
        grants,
        allowMissing: true,
      });
      if (!source.ok) return source;
      resolved.push({ raw: item, source: source.path });
      continue;
    }
    const source = locate({
      reference: item.from,
      purpose: item.kind === "copy" ? "read" : "write",
      actor: input.actor,
      scopes,
      grants,
      allowMissing: true,
    });
    if (!source.ok) return source;
    const destination = locate({
      reference: item.to,
      purpose: "write",
      actor: input.actor,
      scopes,
      grants,
      allowMissing: true,
    });
    if (!destination.ok) return destination;
    resolved.push({
      raw: item,
      source: source.path,
      destination: destination.path,
    });
  }

  const risks: string[] = [];
  const vaultPolicy = guardNativeVaultTargets({
    scopes,
    targets: resolved.flatMap((item) => [
      ...(item.source
        ? [
            {
              path: item.source.absolute,
              purpose:
                item.raw.kind === "copy"
                  ? ("read" as const)
                  : ("write" as const),
              tree: item.source.directory,
            },
          ]
        : []),
      ...(item.destination
        ? [
            {
              path: item.destination.absolute,
              purpose: "write" as const,
              tree: item.destination.directory,
            },
          ]
        : []),
    ]),
  });
  if (!vaultPolicy.ok) return vaultPolicy;
  const items: Planned[] = [];
  const destinations = new Set<string>();
  const consumed = new Set<string>();
  const createdDirectories: string[] = [];
  const produced = new Map<
    string,
    { index: number; state: Fingerprint; bytes?: Buffer; descendants: number }
  >();

  for (const [index, item] of resolved.entries()) {
    const source = item.source;
    let destination = item.destination;
    const dependency = source
      ? produced.get(comparable(source.absolute))
      : undefined;
    if (source && !source.exists && !dependency)
      return {
        ok: false,
        code: "missing",
        summary: "That source does not exist and no earlier step produces it.",
      };
    if (source && consumed.has(comparable(source.absolute)) && !dependency) {
      return {
        ok: false,
        code: "dependency",
        summary: "An earlier item already uses that path.",
      };
    }
    if (item.raw.kind === "rename" && source && destination) {
      if (
        comparable(win32.dirname(source.absolute)) !==
        comparable(win32.dirname(destination.absolute))
      ) {
        return {
          ok: false,
          code: "use_move",
          summary:
            "Rename stays in the same folder. Use files.move to change folders.",
        };
      }
    }
    if (
      (item.raw.kind === "move" || item.raw.kind === "rename") &&
      source &&
      destination
    ) {
      const from = comparable(source.absolute);
      const to = comparable(destination.absolute);
      if (source.directory && (to === from || to.startsWith(`${from}\\`))) {
        return {
          ok: false,
          code: "cycle",
          summary: "That move would put a folder inside itself.",
        };
      }
      if (
        consumed.has(to) ||
        resolved.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.source?.exists &&
            comparable(other.source.absolute) === to,
        )
      ) {
        return {
          ok: false,
          code: "swap",
          summary: "Swaps and cycles are not performed.",
        };
      }
    }
    if (destination) {
      let key = comparable(destination.absolute);
      const sameFile = source ? comparable(source.absolute) === key : false;
      const taken = destinations.has(key) || (destination.exists && !sameFile);
      if (
        taken &&
        (item.raw.kind === "copy" || item.raw.kind === "move") &&
        item.raw.disambiguate
      ) {
        const freed = allocateFreeName(destination, destinations);
        if (!freed.ok) return freed;
        destination = freed.path;
        item.destination = freed.path;
        key = comparable(destination.absolute);
      } else if (taken) {
        return {
          ok: false,
          code: "collision",
          summary: `${destination.display} already exists. A free name is ${suggestion(destination.absolute)}.`,
        };
      }
      destinations.add(key);
      const parent = win32.dirname(destination.absolute);
      const parentReady =
        createdDirectories.includes(comparable(parent)) ||
        (existsSync(parent) && lstatSync(parent).isDirectory());
      if (!parentReady) {
        return {
          ok: false,
          code: "dependency",
          summary: "Create the destination folder earlier in the same plan.",
        };
      }
    }
    if (source) {
      const nested = resolved.some((other, otherIndex) => {
        if (otherIndex === index || !other.source?.directory) return false;
        if (
          other.raw.kind !== "move" &&
          other.raw.kind !== "rename" &&
          other.raw.kind !== "trash"
        ) {
          return false;
        }
        return comparable(source.absolute).startsWith(
          `${comparable(other.source.absolute)}\\`,
        );
      });
      if (nested) {
        return {
          ok: false,
          code: "overlap",
          summary: "A folder and a path inside it are both selected.",
        };
      }
    }
    if (
      source?.directory &&
      (item.raw.kind === "move" ||
        item.raw.kind === "trash" ||
        item.raw.kind === "copy")
    ) {
      const tree = inspectTree(source.absolute);
      if (!tree.ok) return tree;
      if (tree.count >= FILE_MUTATION_LIMITS.largeFolderEntries) {
        risks.push(`${source.display} contains ${tree.count} descendants.`);
      }
    }
    const planned = materialize(
      item.raw,
      source,
      destination,
      risks,
      dependency,
    );
    if (!planned.ok) {
      if (
        planned.code === "too_large" &&
        raw.length > 1 &&
        source &&
        destination
      ) {
        destinations.delete(comparable(destination.absolute));
        items.push({
          kind: item.raw.kind,
          sourcePath: source.absolute,
          destinationPath: destination.absolute,
          sourceDisplay: source.display,
          destinationDisplay: destination.display,
          content: null,
          format: null,
          before: capture(source.absolute),
          expected: { descendants: 0 },
          descendants: 0,
          rejection: { code: planned.code, summary: planned.summary },
        });
        continue;
      }
      return {
        ...planned,
        subjects: pathSubjects(source, destination),
      };
    }
    if (dependency && source) {
      planned.item.expected.dependency = dependency.index;
      planned.item.expected.initialSource = capture(source.absolute);
      planned.item.before = emptyState();
    }
    items.push(planned.item);
    if (source && item.raw.kind !== "copy" && item.raw.kind !== "edit") {
      consumed.add(comparable(source.absolute));
      produced.delete(comparable(source.absolute));
    }
    if (item.raw.kind === "create_directory" && destination) {
      createdDirectories.push(comparable(destination.absolute));
    }
    const output = item.raw.kind === "edit" ? source : destination;
    if (output) {
      let bytes: Buffer | undefined;
      const isText =
        item.raw.kind === "edit" || item.raw.kind === "create_file";
      if (isText)
        bytes = Buffer.from(
          `${planned.item.expected.bom ? "\ufeff" : ""}${planned.item.content ?? ""}`,
          "utf8",
        );
      else if (dependency) bytes = dependency.bytes;
      else if (
        source &&
        !source.directory &&
        (planned.item.before.size ?? Infinity) <=
          FILE_MUTATION_LIMITS.maxContentChars
      )
        bytes = readFileSync(source.absolute);
      produced.set(comparable(output.absolute), {
        index,
        bytes,
        descendants: planned.item.descendants,
        state: {
          ...(dependency?.state ?? planned.item.before),
          exists: true,
          directory:
            item.raw.kind === "create_directory" ||
            (dependency?.state.directory ?? source?.directory ?? false),
          ...(bytes
            ? {
                size: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              }
            : {}),
        },
      });
    }
    noteRisk(risks, planned.item);
  }
  if (items.some((item) => item.kind === "trash")) {
    risks.unshift(
      "Sends items to the Recycle Bin. There is no permanent delete.",
    );
  }
  return { ok: true, items, risks: risks.slice(0, 8) };
}

function materialize(
  raw: RawItem,
  source: Located | undefined,
  destination: Located | undefined,
  risks: string[],
  dependency?: { state: Fingerprint; bytes?: Buffer; descendants: number },
): { ok: true; item: Planned } | StepFailure {
  if (raw.kind === "create_directory" && destination) {
    if (destination.exists) {
      return {
        ok: false,
        code: "collision",
        summary: `${destination.display} already exists. A free name is ${suggestion(destination.absolute)}.`,
      };
    }
    return {
      ok: true,
      item: planned(raw.kind, null, destination, null, null, emptyState(), {
        descendants: 0,
      }),
    };
  }
  if (raw.kind === "create_file" && destination) {
    if (destination.exists) {
      return {
        ok: false,
        code: "collision",
        summary: `${destination.display} already exists. A free name is ${suggestion(destination.absolute)}.`,
      };
    }
    const format = formatFor(destination.absolute, raw.format);
    if (format === "json") {
      try {
        JSON.parse(raw.content);
      } catch {
        return {
          ok: false,
          code: "invalid_json",
          summary: "The new file is not valid JSON.",
        };
      }
    }
    const hash = createHash("sha256").update(raw.content).digest("hex");
    return {
      ok: true,
      item: planned(
        raw.kind,
        null,
        destination,
        raw.content,
        format,
        emptyState(),
        {
          sha256: hash,
          descendants: 0,
        },
      ),
    };
  }
  if (raw.kind === "edit" && source) {
    if (
      (!source.exists && !dependency) ||
      (dependency?.state.directory ?? source.directory)
    ) {
      return {
        ok: false,
        code: "invalid_args",
        summary: "Only an existing file can be edited.",
      };
    }
    const before = dependency?.state ?? capture(source.absolute);
    if (
      before.size !== null &&
      before.size > FILE_MUTATION_LIMITS.maxContentChars
    ) {
      return {
        ok: false,
        code: "too_large",
        summary: "That file is too large to edit.",
      };
    }
    const decoded = decodeText(
      dependency?.bytes ?? readFileSync(source.absolute),
    );
    if (!decoded) {
      return {
        ok: false,
        code: "encoding",
        summary: "That file is not UTF-8 text.",
      };
    }
    const produced = nextText(raw, decoded);
    if (!produced.ok) return produced;
    const format = formatFor(source.absolute, raw.format);
    if (format === "json") {
      try {
        JSON.parse(produced.text);
      } catch {
        return {
          ok: false,
          code: "invalid_json",
          summary: "The edited file is not valid JSON.",
        };
      }
    }
    const hash = createHash("sha256").update(produced.text).digest("hex");
    risks.push(`Edits ${source.display}.`);
    return {
      ok: true,
      item: planned("edit", source, null, produced.text, format, before, {
        sha256: hash,
        bom: decoded.bom,
        diff: lineDiff(decoded.text, produced.text),
        descendants: 0,
      }),
    };
  }
  if (
    (raw.kind === "copy" || raw.kind === "move" || raw.kind === "rename") &&
    source &&
    destination
  ) {
    const before = dependency?.state ?? capture(source.absolute);
    if (
      before.size !== null &&
      !before.directory &&
      before.size > FILE_MUTATION_LIMITS.maxFileBytes
    ) {
      return {
        ok: false,
        code: "too_large",
        summary: `${source.display} is ${before.size} bytes. The transfer limit is ${FILE_MUTATION_LIMITS.maxFileBytes} bytes.`,
      };
    }
    const tree = dependency
      ? { ok: true as const, count: dependency.descendants }
      : before.directory
        ? inspectTree(source.absolute)
        : { ok: true as const, count: 0 };
    if (!tree.ok) return tree;
    return {
      ok: true,
      item: planned(raw.kind, source, destination, null, null, before, {
        descendants: tree.count,
      }),
    };
  }
  if (raw.kind === "trash" && source) {
    const before = dependency?.state ?? capture(source.absolute);
    const tree = dependency
      ? { ok: true as const, count: dependency.descendants }
      : before.directory
        ? inspectTree(source.absolute)
        : { ok: true as const, count: 0 };
    if (!tree.ok) return tree;
    return {
      ok: true,
      item: planned("trash", source, null, null, null, before, {
        descendants: tree.count,
      }),
    };
  }
  return {
    ok: false,
    code: "invalid_args",
    summary: "That file change is incomplete.",
  };
}

function planned(
  kind: RawItem["kind"],
  source: Located | null,
  destination: Located | null,
  content: string | null,
  format: string | null,
  before: Fingerprint,
  expected: Record<string, unknown>,
): Planned {
  return {
    kind,
    sourcePath: source?.absolute ?? null,
    destinationPath: destination?.absolute ?? null,
    sourceDisplay: source?.display ?? null,
    destinationDisplay: destination?.display ?? null,
    content,
    format,
    before,
    expected,
    descendants: Number(expected.descendants ?? 0),
  };
}

function noteRisk(risks: string[], item: Planned): void {
  const name = item.destinationDisplay ?? item.sourceDisplay ?? "";
  const base = name.split("/").pop() ?? name;
  if (/(^\.env$|\.pem$|\.key$|^id_rsa$)/iu.test(base))
    risks.push(`${name} looks sensitive.`);
  const extension = win32.extname(base).replace(/^\./u, "").toLowerCase();
  if (BINARY.has(extension)) risks.push(`${name} is not a text file.`);
  if (item.descendants >= FILE_MUTATION_LIMITS.largeFolderEntries) {
    risks.push(`${name} contains ${item.descendants} descendants.`);
  }
}

function sameVolume(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  const leftRoot = win32.parse(left).root.toLowerCase();
  const rightRoot = win32.parse(right).root.toLowerCase();
  if (!leftRoot || !rightRoot) return true;
  return leftRoot === rightRoot;
}

export function planNeedsApproval(action: string, items: Planned[]): boolean {
  if (action === "files.batch") return true;
  if (items.length !== 1) return items.length > 1;
  const item = items[0];
  if (!item) return true;
  if (item.kind === "trash" || item.kind === "edit") return true;
  if (item.kind === "create_file" || item.kind === "create_directory")
    return false;
  if (!sameVolume(item.sourcePath, item.destinationPath)) return true;
  if (
    (item.kind === "copy" || item.kind === "move" || item.kind === "rename") &&
    item.before.directory &&
    item.descendants > 0
  ) {
    return true;
  }
  return false;
}

function needsApproval(action: string, items: Planned[]): boolean {
  return planNeedsApproval(action, items);
}

function fingerprintOf(
  items: Array<
    Pick<
      Planned,
      | "kind"
      | "sourcePath"
      | "destinationPath"
      | "content"
      | "format"
      | "before"
      | "expected"
    >
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        items.map((item) => ({
          kind: item.kind,
          source: item.sourcePath,
          destination: item.destinationPath,
          content: item.content
            ? createHash("sha256").update(item.content).digest("hex")
            : null,
          format: item.format,
          before: item.before,
          expected: item.expected,
        })),
      ),
    )
    .digest("hex");
}

function exampleOf(item: Planned | StoredOperationItem): string {
  const kind = item.kind;
  const from = "sourceDisplay" in item ? item.sourceDisplay : null;
  const to = "destinationDisplay" in item ? item.destinationDisplay : null;
  const descendants = "descendants" in item ? item.descendants : 0;
  const suffix = descendants > 0 ? ` (${descendants} descendants)` : "";
  if (kind === "create_file" || kind === "create_directory")
    return `Create ${to}${suffix}`;
  if (kind === "trash") return `Trash ${from}${suffix}`;
  if (kind === "edit") return `Edit ${from}`;
  return `${kind} ${from} -> ${to}${suffix}`;
}

function fitDetail(payload: Record<string, unknown>): {
  detail: string;
  trimmed: boolean;
} {
  const items = Array.isArray(payload.items) ? [...payload.items] : [];
  let trimmed = false;
  let body = payload;
  let detail = JSON.stringify(body);
  while (
    detail.length > FILE_MUTATION_LIMITS.detailBudget &&
    items.length > 1
  ) {
    items.pop();
    trimmed = true;
    body = { ...payload, items, trimmed: true };
    detail = JSON.stringify(body);
  }
  if (detail.length > 4000) {
    detail = JSON.stringify({
      operationId: payload.operationId,
      threadId: payload.threadId,
      trimmed: true,
    });
    trimmed = true;
  }
  return { detail, trimmed };
}

function publish(
  action: string,
  planSummary: string,
  status: ActionResult["status"],
  code: string | undefined,
  operationId: string,
  threadId: string,
  approval: "auto" | "required",
  risks: string[],
  items: StoredOperationItem[],
): ActionResult {
  const examples = items.slice(0, 8).map((item) => exampleOf(item));
  const fitted = fitDetail({
    operationId,
    threadId,
    approval,
    risks,
    examples,
    items: items.map((item) => ({
      index: item.index,
      kind: item.kind,
      from: item.sourceDisplay,
      to: item.destinationDisplay,
      status: item.status,
      error: item.errorSummary,
    })),
  });
  return actionResultSchema.parse({
    action,
    status,
    summary: planSummary,
    ...(code ? { code } : {}),
    operationId,
    detail: fitted.detail,
    preview: examples.slice(0, 20).map((line) => line.slice(0, 500)),
    totalItems: items.length,
    ...(fitted.trimmed ? { detailsAvailable: true } : {}),
    ...(() => {
      const subjects = subjectsFromPlanned(items);
      return subjects.length ? { subjects } : {};
    })(),
  });
}

function requestSummary(action: string, items: Planned[]): string {
  return `${action} ${items.length}: ${items
    .slice(0, 5)
    .map((item) => exampleOf(item))
    .join("; ")}`.slice(0, 500);
}

function writeAtomic(destination: string, data: Buffer): void {
  const temporary = `${destination}.${randomUUID()}.verbo-tmp`;
  writeFileSync(temporary, data);
  try {
    if (existsSync(destination)) {
      const backup = `${destination}.${randomUUID()}.verbo-bak`;
      renameSync(destination, backup);
      try {
        renameSync(temporary, destination);
      } catch (error) {
        renameSync(backup, destination);
        throw error;
      }
      rmSync(backup, { force: true });
      return;
    }
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function applyItem(
  item: StoredOperationItem,
  dependencyState?: Fingerprint,
): { ok: true; after: Fingerprint } | StepFailure {
  const before =
    dependencyState ?? (JSON.parse(item.beforeJson) as Fingerprint);
  const source = item.sourcePath;
  const destination = item.destinationPath;
  if (source && !sameState(source, before)) {
    return {
      ok: false,
      code: "stale_source",
      summary: "That file changed before it was written.",
    };
  }
  if (
    destination &&
    (item.kind === "create_file" ||
      item.kind === "create_directory" ||
      item.kind === "copy")
  ) {
    if (existsSync(destination)) {
      return {
        ok: false,
        code: "collision",
        summary: "The destination appeared before it was written.",
      };
    }
  }
  try {
    if (item.kind === "create_directory" && destination) {
      mkdirSync(destination);
    } else if (
      (item.kind === "create_file" || item.kind === "edit") &&
      (destination || source)
    ) {
      const target = item.kind === "edit" ? source : destination;
      if (!target)
        return {
          ok: false,
          code: "invalid",
          summary: "The destination is missing.",
        };
      const expected = JSON.parse(item.expectedJson) as { bom?: boolean };
      const body = Buffer.from(item.content ?? "", "utf8");
      const data = expected.bom
        ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
        : body;
      writeAtomic(target, data);
    } else if (item.kind === "copy" && source && destination) {
      const state = capture(source);
      if (state.directory)
        cpSync(source, destination, { recursive: true, errorOnExist: true });
      else copyFileSync(source, destination);
    } else if (
      (item.kind === "move" || item.kind === "rename") &&
      source &&
      destination
    ) {
      if (
        win32.parse(source).root.toLowerCase() ===
        win32.parse(destination).root.toLowerCase()
      ) {
        renameSync(source, destination);
      } else {
        const state = capture(source);
        if (state.directory)
          cpSync(source, destination, { recursive: true, errorOnExist: true });
        else copyFileSync(source, destination);
        try {
          mutationPorts().trashItem(source);
        } catch {
          return {
            ok: false,
            code: "trash_failed",
            summary: "The copy exists and the original was not removed.",
          };
        }
      }
    } else if (item.kind === "trash" && source) {
      mutationPorts().trashItem(source);
      if (existsSync(source)) {
        return {
          ok: false,
          code: "trash_failed",
          summary: "The Recycle Bin did not take that item.",
        };
      }
    } else {
      return {
        ok: false,
        code: "invalid",
        summary: "That planned item is incomplete.",
      };
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The file change failed.";
    if (message.includes("Recycle Bin") || message.includes("rejected")) {
      return {
        ok: false,
        code: "trash_failed",
        summary: "The Recycle Bin did not take that item.",
      };
    }
    return { ok: false, code: "failed", summary: "The file change failed." };
  }
  const afterTarget =
    item.kind === "trash"
      ? source
      : item.kind === "edit"
        ? source
        : destination;
  if (!afterTarget)
    return {
      ok: false,
      code: "invalid",
      summary: "The result path is missing.",
    };
  const after = item.kind === "trash" ? emptyState() : capture(afterTarget);
  if (item.kind !== "trash" && !after.exists) {
    return {
      ok: false,
      code: "failed",
      summary: "The file change did not land.",
    };
  }
  if (
    (item.kind === "move" || item.kind === "rename") &&
    source &&
    destination &&
    comparable(source) !== comparable(destination) &&
    existsSync(source)
  ) {
    return {
      ok: false,
      code: "failed",
      summary: "The original path is still present.",
    };
  }
  if ((item.kind === "create_file" || item.kind === "edit") && afterTarget) {
    const expected = JSON.parse(item.expectedJson) as { bom?: boolean };
    const body = Buffer.from(item.content ?? "", "utf8");
    const data = expected.bom
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
      : body;
    const actual = createHash("sha256")
      .update(readFileSync(afterTarget))
      .digest("hex");
    const wanted = createHash("sha256").update(data).digest("hex");
    if (actual !== wanted) {
      return {
        ok: false,
        code: "failed",
        summary: "The written file did not match the plan.",
      };
    }
  }
  return { ok: true, after };
}

async function executeStored(
  database: DatabaseSync,
  operationId: string,
  scopes: ScopeStore,
): Promise<ActionResult> {
  const store = createOperationStore(database);
  const initial = store.get(operationId);
  if (!initial)
    return failure("files.batch", "missing", "That operation plan is gone.");
  const ports = mutationPorts();
  let sideEffect = false;
  const loaded = store.items(operationId);
  // Load the same production dispatcher after module initialization; native
  // planning remains private and every prepared child crosses its public schema.
  const { registryForDatabase } = await import("../capabilities/catalog");
  const registry = registryForDatabase(database);
  let executionFailure: StepFailure | undefined;
  for (const item of loaded) {
    if (item.status !== "planned") continue;
    // Let cancellation and scope-change IPC run between native effects.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (store.cancelRequested(operationId)) {
      store.markRemaining(operationId, item.index);
      break;
    }
    ports.beforeItem?.(operationId, item.index);
    if (store.cancelRequested(operationId)) {
      store.markRemaining(operationId, item.index);
      break;
    }
    store.markItem(item.id, { status: "uncertain" });
    const expected = JSON.parse(item.expectedJson) as { dependency?: number };
    const predecessor =
      expected.dependency === undefined
        ? undefined
        : store.items(operationId)[expected.dependency];
    const dependencyInvalid =
      expected.dependency !== undefined &&
      (!predecessor ||
        predecessor.index >= item.index ||
        predecessor.status !== "succeeded" ||
        !predecessor.afterJson ||
        comparable(
          predecessor.kind === "edit"
            ? (predecessor.sourcePath ?? "")
            : (predecessor.destinationPath ?? ""),
        ) !== comparable(item.sourcePath ?? ""));
    const dependencyState = predecessor?.afterJson
      ? (JSON.parse(predecessor.afterJson) as Fingerprint)
      : undefined;
    const currentScope = scopes.generation() === initial.scopeGeneration;
    const paths = [
      ...(item.sourcePath
        ? [
            {
              reference: item.sourcePath,
              purpose:
                item.kind === "copy" ? ("read" as const) : ("write" as const),
              allowMissing: false,
            },
          ]
        : []),
      ...(item.destinationPath
        ? [
            {
              reference: item.destinationPath,
              purpose: "write" as const,
              allowMissing: true,
            },
          ]
        : []),
    ];
    const unsafe = paths
      .map((path) =>
        locate({
          ...path,
          actor: initial.actor,
          scopes: scopes.list(),
          grants: scopes.activeGrants(),
        }),
      )
      .find((path) => !path.ok);
    const vaultPolicy = guardNativeVaultTargets({
      scopes: scopes.list(),
      targets: paths.map((path) => ({
        path: path.reference,
        purpose: path.purpose,
        tree: true,
      })),
    });
    const guarded = !vaultPolicy.ok
      ? vaultPolicy
      : !currentScope
        ? {
            ok: false as const,
            code: "stale_scope",
            summary: "The folders changed. Remaining steps stopped.",
          }
        : unsafe && !unsafe.ok
          ? unsafe
          : dependencyInvalid
            ? {
                ok: false as const,
                code: "dependency",
                summary: "The required earlier result is unavailable.",
              }
            : undefined;
    const outcome: { value?: ReturnType<typeof applyItem> } = {
      value: guarded,
    };
    if (!guarded) {
      const action =
        item.kind === "create_file" || item.kind === "create_directory"
          ? "files.create"
          : `files.${item.kind}`;
      const args =
        item.kind === "create_file" || item.kind === "create_directory"
          ? {
              path: item.destinationPath!,
              kind: item.kind === "create_file" ? "file" : "directory",
              ...(item.kind === "create_file"
                ? { content: item.content ?? "" }
                : {}),
              ...(item.format ? { format: item.format } : {}),
            }
          : item.kind === "edit"
            ? {
                path: item.sourcePath!,
                mode: "full",
                content: item.content ?? "",
                ...(item.format ? { format: item.format } : {}),
              }
            : item.kind === "trash"
              ? { path: item.sourcePath! }
              : { from: item.sourcePath!, to: item.destinationPath! };
      const childContext = {
        actor: initial.actor,
        threadId: initial.threadId,
        ...(initial.turnId ? { turnId: initial.turnId } : {}),
        parentReceiptId: operationId,
      };
      const child = await dispatchPreparedFileChild(
        {
          database,
          ...childContext,
          action: action as MutationSubmit["action"],
          args,
          execute: () => {
            const current = store.get(operationId);
            const applied: ReturnType<typeof applyItem> =
              current?.status !== "executing" ||
              current.sessionId !== operationSession() ||
              store.cancelRequested(operationId)
                ? {
                    ok: false,
                    code: "cancelled",
                    summary: "The prepared operation is no longer executing.",
                  }
                : scopes.generation() !== initial.scopeGeneration
                  ? {
                      ok: false,
                      code: "stale_scope",
                      summary: "The folders changed. Remaining steps stopped.",
                    }
                  : applyItem(item, dependencyState);
            outcome.value = applied;
            if (applied.ok) {
              if (item.kind === "copy" && item.sourcePath)
                recordFileResource(item.sourcePath, "read");
              if (item.kind === "trash" && item.sourcePath)
                recordFileResource(item.sourcePath, "remove");
              else {
                const path =
                  item.kind === "edit" ? item.sourcePath : item.destinationPath;
                if (path)
                  recordFileResource(
                    path,
                    item.kind === "move" || item.kind === "rename"
                      ? "move"
                      : "write",
                    item.sourcePath ?? undefined,
                  );
              }
            }
            return {
              action,
              status: applied.ok ? "success" : "error",
              summary: applied.ok ? exampleOf(item) : applied.summary,
              ...(!applied.ok ? { code: applied.code } : {}),
              totalItems: 1,
              data: { parentOperationId: operationId, itemIndex: item.index },
            };
          },
        },
        () => registry.invoke(action, args, childContext),
      );
      if (!outcome.value)
        outcome.value = {
          ok: false,
          code: child.code ?? "child_failed",
          summary: child.summary,
        };
      else if (outcome.value.ok && child.status !== "success") {
        store.markItem(item.id, {
          status: "succeeded",
          afterJson: JSON.stringify(outcome.value.after),
          errorCode: null,
          errorSummary: null,
        });
        executionFailure = {
          ok: false,
          code: child.code ?? "child_failed",
          summary: child.summary,
        };
        store.markRemaining(operationId, item.index + 1);
        break;
      }
    }
    const applied = outcome.value;
    if (!applied) throw new Error("Missing prepared child result.");
    if (!applied.ok) {
      if (applied.code === "trash_failed") sideEffect = true;
      store.markItem(item.id, {
        status: "failed",
        errorCode: applied.code,
        errorSummary: applied.summary,
      });
      store.markRemaining(operationId, item.index + 1);
      break;
    }
    store.markItem(item.id, {
      status: "succeeded",
      afterJson: JSON.stringify(applied.after),
      errorCode: null,
      errorSummary: null,
    });
  }
  const items = store.items(operationId);
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const notAttempted = items.filter(
    (item) => item.status === "not_attempted",
  ).length;
  const cancelled = store.cancelRequested(operationId);
  const status = cancelled
    ? "cancelled"
    : (failed > 0 || executionFailure) && (succeeded > 0 || sideEffect)
      ? "partial"
      : failed > 0 || executionFailure
        ? "failed"
        : succeeded === items.length
          ? "succeeded"
          : "failed";
  const failedItem = items.find((item) => item.status === "failed");
  const reported = [
    executionFailure?.summary,
    ...items.flatMap((item) =>
      item.status === "failed" && item.errorSummary ? [item.errorSummary] : [],
    ),
  ]
    .filter((line): line is string => Boolean(line))
    .filter((line, index, all) => all.indexOf(line) === index)
    .join(" ");
  const counts = `${succeeded} succeeded, ${failed} failed, ${notAttempted} not attempted.`;
  const summary = cancelled
    ? `Cancelled: ${counts}`
    : status === "partial"
      ? `Partial: ${counts} ${reported}`.trim().slice(0, 4000)
      : status === "failed" && items.length > 1
        ? `${counts} ${reported || "The file change failed."}`
            .trim()
            .slice(0, 4000)
        : status === "failed"
          ? (failedItem?.errorSummary ?? "The file change failed.")
          : initial.summary.replace(" needs confirmation.", ".");
  const code =
    status === "succeeded"
      ? undefined
      : cancelled
        ? "cancelled"
        : (executionFailure?.code ?? failedItem?.errorCode ?? status);
  store.finish(operationId, status, code ?? null, summary, ports.now());
  const plan = store.get(operationId);
  return publish(
    plan?.actionId ?? initial.actionId,
    summary,
    status === "succeeded"
      ? "success"
      : status === "partial"
        ? "partial"
        : status === "cancelled"
          ? "cancelled"
          : "error",
    code,
    operationId,
    initial.threadId,
    initial.approval,
    plan?.risks ?? initial.risks,
    items,
  );
}

function audit(
  database: DatabaseSync,
  input: MutationSubmit,
  request: string,
  result: ActionResult,
): ActionResult {
  createOperationStore(database).audit({
    actor: input.actor,
    actionId: input.action,
    threadId: input.threadId,
    requestSummary: request,
    resultSummary: result.summary,
    resultStatus: result.status,
    ...(result.code ? { resultCode: result.code } : {}),
    ...(result.operationId ? { operationId: result.operationId } : {}),
    now: mutationPorts().now(),
  });
  return result;
}

export async function submitFileMutation(
  input: MutationSubmit,
): Promise<ActionResult> {
  const prepared = await consumePreparedFileChild(input);
  if (prepared) return prepared;
  const now = mutationPorts().now();
  const operations = createOperationStore(input.database);
  operations.purge(now);
  const generation = input.scopes.generation();
  const normalized = normalize(input, generation, now);
  if (!normalized.ok) {
    return audit(
      input.database,
      input,
      input.action,
      failure(input.action, normalized.code, normalized.summary),
    );
  }
  if (normalized.items.length === 0) {
    return audit(
      input.database,
      input,
      input.action,
      failure(input.action, "invalid_args", "The file change has no items."),
    );
  }
  const plannedItems = preflight(input, normalized.items);
  if (!plannedItems.ok) {
    if (plannedItems.code === "vault_backend_required") {
      const routed = await routeVaultBackend(input, normalized.items);
      if (routed) return routed;
    }
    return audit(
      input.database,
      input,
      requestSummary(input.action, []),
      failure(
        input.action,
        plannedItems.code,
        plannedItems.summary,
        plannedItems.subjects,
      ),
    );
  }
  const executable = plannedItems.items.filter((item) => !item.rejection);
  if (executable.length === 0) {
    const rejected = plannedItems.items.flatMap((item) =>
      item.rejection ? [item.rejection.summary] : [],
    );
    return audit(
      input.database,
      input,
      input.action,
      failure(
        input.action,
        plannedItems.items.every((item) => item.rejection?.code === "too_large")
          ? "too_large"
          : "failed",
        `0 succeeded, ${plannedItems.items.length} failed, 0 not attempted. ${rejected.join(" ")}`.slice(
          0,
          4000,
        ),
        subjectsFromPlanned(plannedItems.items),
      ),
    );
  }
  const approval = needsApproval(input.action, executable)
    ? "required"
    : "auto";
  for (const item of plannedItems.items) {
    item.expected = { ...item.expected, backend: "native", backendVersion: 1 };
  }
  const verb = input.action.replace("files.", "");
  const rejected = plannedItems.items.flatMap((item) =>
    item.rejection ? [item.rejection.summary] : [],
  );
  const failureNote =
    rejected.length > 0
      ? ` ${rejected.length} failed: ${rejected.join(" ")}`
      : "";
  const summary = (
    approval === "required"
      ? `${verb} ${executable.length} item${executable.length === 1 ? "" : "s"} needs confirmation.${failureNote}`
      : `${verb} ${executable.length} item${executable.length === 1 ? "" : "s"}.${failureNote}`
  ).slice(0, 4000);
  const plan = operations.insert({
    id: input.receiptId,
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    sessionId: operationSession(),
    actor: input.actor,
    actionId: input.action,
    fingerprint: fingerprintOf(plannedItems.items),
    scopeGeneration: input.scopes.generation(),
    approval,
    risks: [...new Set(plannedItems.risks)],
    summary,
    now,
    items: plannedItems.items.map((item) => ({
      kind: item.kind,
      sourcePath: item.sourcePath,
      destinationPath: item.destinationPath,
      sourceDisplay: item.sourceDisplay,
      destinationDisplay: item.destinationDisplay,
      content: item.content,
      format: item.format,
      beforeJson: JSON.stringify(item.before),
      expectedJson: JSON.stringify(item.expected),
      ...(item.rejection
        ? {
            status: "failed" as const,
            errorCode: item.rejection.code,
            errorSummary: item.rejection.summary,
          }
        : {}),
    })),
  });
  if (approval === "required") {
    return audit(
      input.database,
      input,
      requestSummary(input.action, executable),
      publish(
        input.action,
        summary,
        "requires_confirmation",
        undefined,
        plan.id,
        input.threadId,
        approval,
        plan.risks,
        operations.items(plan.id),
      ),
    );
  }
  if (!operations.claim(plan.id, now)) {
    return audit(
      input.database,
      input,
      requestSummary(input.action, plannedItems.items),
      failure(input.action, "replayed", "That plan is no longer waiting."),
    );
  }
  const cancel = (): void => {
    operations.requestCancel(plan.id);
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  try {
    return audit(
      input.database,
      input,
      requestSummary(input.action, executable),
      await executeStored(input.database, plan.id, input.scopes),
    );
  } finally {
    input.signal?.removeEventListener("abort", cancel);
  }
}

function guardPlan(input: {
  database: DatabaseSync;
  operationId: string;
  threadId: string;
  sessionId: string;
}):
  | {
      ok: true;
      plan: NonNullable<
        ReturnType<ReturnType<typeof createOperationStore>["get"]>
      >;
    }
  | StepFailure {
  const now = mutationPorts().now();
  const store = createOperationStore(input.database);
  store.purge(now);
  const plan = store.get(input.operationId);
  if (!plan)
    return {
      ok: false,
      code: "missing",
      summary: "That operation plan is gone.",
    };
  if (plan.threadId !== input.threadId) {
    return {
      ok: false,
      code: "wrong_thread",
      summary: "That plan belongs to another conversation.",
    };
  }
  if (plan.sessionId !== input.sessionId) {
    return {
      ok: false,
      code: "wrong_session",
      summary: "That plan belongs to another session.",
    };
  }
  if (plan.expiresAt <= now && plan.status === "pending") {
    store.finish(plan.id, "expired", "expired", "That plan expired.", now);
    store.markRemaining(plan.id, 0);
    return { ok: false, code: "expired", summary: "That plan expired." };
  }
  return { ok: true, plan };
}

export function reviewOperation(input: {
  database: DatabaseSync;
  scopes: ScopeStore;
  operationId: string;
  threadId: string;
  sessionId: string;
}): OperationReview | OperationReviewFailure {
  const guarded = guardPlan(input);
  if (!guarded.ok) return guarded;
  const items = createOperationStore(input.database).items(guarded.plan.id);
  const receipt = {
    succeeded: items.filter((item) => item.status === "succeeded").length,
    failed: items.filter(
      (item) => item.status === "failed" || item.status === "uncertain",
    ).length,
    notAttempted: items.filter(
      (item) => item.status === "not_attempted" || item.status === "planned",
    ).length,
  };
  return {
    ok: true,
    operationId: guarded.plan.id,
    threadId: guarded.plan.threadId,
    action: guarded.plan.actionId,
    status: guarded.plan.status,
    summary: guarded.plan.summary,
    count: items.length,
    risks: guarded.plan.risks,
    items: items.map((item) => {
      const expected = JSON.parse(item.expectedJson) as { diff?: string };
      return {
        index: item.index,
        kind: item.kind,
        from: item.sourceDisplay,
        to: item.destinationDisplay,
        status: item.status,
        ...(expected.diff ? { diff: expected.diff } : {}),
        ...(item.errorSummary ? { error: item.errorSummary } : {}),
      };
    }),
    receipt,
  };
}

export function abandonPendingPlan(
  database: DatabaseSync,
  operationId: string,
): void {
  const store = createOperationStore(database);
  const plan = store.get(operationId);
  if (!plan || plan.status !== "pending") return;
  const now = mutationPorts().now();
  store.finish(
    plan.id,
    "cancelled",
    "cancelled",
    "The turn was cancelled.",
    now,
  );
  store.markRemaining(plan.id, 0);
}

async function decideNativeOperation(input: {
  database: DatabaseSync;
  scopes: ScopeStore;
  operationId: string;
  threadId: string;
  sessionId: string;
  decision: "approve" | "deny";
}): Promise<ActionResult> {
  const guarded = guardPlan(input);
  if (!guarded.ok) return failure("files.batch", guarded.code, guarded.summary);
  const plan = guarded.plan;
  const store = createOperationStore(input.database);
  const now = mutationPorts().now();
  if (plan.status === "needs_review") {
    return failure(
      plan.actionId,
      "needs_review",
      "That interrupted operation needs review and will not be replayed.",
    );
  }
  if (plan.status !== "pending") {
    return failure(
      plan.actionId,
      "replayed",
      "That plan is no longer waiting.",
    );
  }
  if (input.decision === "deny") {
    if (!store.deny(plan.id, now)) {
      return failure(
        plan.actionId,
        "replayed",
        "That plan is no longer waiting.",
      );
    }
    const result = publish(
      plan.actionId,
      "The file change was denied.",
      "denied",
      "denied",
      plan.id,
      plan.threadId,
      plan.approval,
      plan.risks,
      store.items(plan.id),
    );
    store.audit({
      actor: "ui",
      actionId: plan.actionId,
      threadId: plan.threadId,
      requestSummary: `deny ${plan.id}`,
      resultSummary: result.summary,
      resultStatus: result.status,
      resultCode: "denied",
      operationId: plan.id,
      now,
    });
    return result;
  }
  if (plan.scopeGeneration !== input.scopes.generation()) {
    store.finish(
      plan.id,
      "failed",
      "stale_scope",
      "The folders changed. Make a new plan.",
      now,
    );
    store.markRemaining(plan.id, 0);
    return failure(
      plan.actionId,
      "stale_scope",
      "The folders changed. Make a new plan.",
    );
  }
  const items = store.items(plan.id);
  for (const item of items) {
    const expected = JSON.parse(item.expectedJson) as Record<string, unknown>;
    if (
      expected.backend !== undefined &&
      (expected.backend !== "native" || expected.backendVersion !== 1)
    ) {
      store.finish(
        plan.id,
        "failed",
        "unsupported_backend",
        "The stored mutation backend is unknown or incompatible. Prepare a new operation.",
        now,
      );
      store.markRemaining(plan.id, 0);
      return failure(
        plan.actionId,
        "unsupported_backend",
        "The stored mutation backend is unknown or incompatible. Prepare a new operation.",
      );
    }
  }
  const fingerprint = fingerprintOf(
    items.map((item) => ({
      kind: item.kind as Planned["kind"],
      sourcePath: item.sourcePath,
      destinationPath: item.destinationPath,
      content: item.content,
      format: item.format,
      before: JSON.parse(item.beforeJson) as Fingerprint,
      expected: JSON.parse(item.expectedJson) as Record<string, unknown>,
    })),
  );
  if (fingerprint !== plan.fingerprint) {
    store.finish(
      plan.id,
      "failed",
      "stale_plan",
      "The stored plan no longer matches its fingerprint.",
      now,
    );
    return failure(
      plan.actionId,
      "stale_plan",
      "The stored plan no longer matches its fingerprint.",
    );
  }
  for (const item of items) {
    if (item.status === "failed") continue;
    const expected = JSON.parse(item.expectedJson) as {
      dependency?: number;
      initialSource?: Fingerprint;
    };
    const before =
      expected.dependency !== undefined
        ? (expected.initialSource ?? emptyState())
        : (JSON.parse(item.beforeJson) as Fingerprint);
    const target = item.sourcePath ?? item.destinationPath;
    if (!target || !sameState(target, before)) {
      store.finish(
        plan.id,
        "failed",
        "stale_source",
        "A file changed. Make a new plan.",
        now,
      );
      store.markRemaining(plan.id, 0);
      return failure(
        plan.actionId,
        "stale_source",
        "A file changed. Make a new plan.",
      );
    }
    if (
      item.destinationPath &&
      item.kind !== "edit" &&
      existsSync(item.destinationPath) &&
      comparable(item.destinationPath) !== comparable(item.sourcePath ?? "")
    ) {
      store.finish(
        plan.id,
        "failed",
        "collision",
        "The destination appeared. Make a new plan.",
        now,
      );
      store.markRemaining(plan.id, 0);
      return failure(
        plan.actionId,
        "collision",
        "The destination appeared. Make a new plan.",
      );
    }
  }
  if (!store.claim(plan.id, now)) {
    return failure(
      plan.actionId,
      "replayed",
      "That plan is no longer waiting.",
    );
  }
  const executed = await executeStored(input.database, plan.id, input.scopes);
  store.audit({
    actor: "ui",
    actionId: plan.actionId,
    threadId: plan.threadId,
    requestSummary: `approve ${plan.id}`,
    resultSummary: executed.summary,
    resultStatus: executed.status,
    ...(executed.code ? { resultCode: executed.code } : {}),
    operationId: plan.id,
    now,
  });
  return executed;
}

export async function decideOperation(
  input: Parameters<typeof decideNativeOperation>[0],
): Promise<ActionResult> {
  const { withApprovalInvocation } = await import("../agents/policy");
  return withApprovalInvocation(input.operationId, input.threadId, () =>
    decideOperationWithAuthority(input),
  );
}

async function decideOperationWithAuthority(
  input: Parameters<typeof decideNativeOperation>[0],
): Promise<ActionResult> {
  const store = createOperationStore(input.database);
  const plan = store.get(input.operationId);
  const { permitsCommand } = await import("../agents/policy");
  if (plan && !permitsCommand(plan.actionId))
    return {
      action: plan.actionId,
      status: "denied",
      code: "invocation_forbidden",
      summary:
        "This approved operation is outside its originating invocation's authority.",
    };
  const generic =
    plan && store.items(plan.id).some((item) => item.kind === "command");
  const result = generic
    ? await (async (): Promise<ActionResult> => {
        const { registryForDatabase } = await import("../capabilities/catalog");
        const { decidePreparedOperation } =
          await import("../capabilities/preparation");
        return decidePreparedOperation({
          ...input,
          registry: registryForDatabase(input.database),
        });
      })()
    : await decideNativeOperation(input);
  if (
    !plan ||
    result.code === "replayed" ||
    result.code === "wrong_thread" ||
    result.code === "wrong_session"
  )
    return result;
  const current = store.get(plan.id);
  if (!result.operationId && current?.status === "pending") return result;
  try {
    return persistCommandReceipt(input.database, {
      result: { ...result, operationId: plan.id },
      context: {
        actor: plan.actor,
        threadId: plan.threadId,
        ...(plan.turnId ? { turnId: plan.turnId } : {}),
      },
      startedAt: plan.decidedAt ?? plan.createdAt,
      resources: [],
    });
  } catch {
    return {
      ...result,
      status: "error",
      code: "receipt_failed",
      summary:
        "Saving the operation receipt failed. Recorded effects must not be replayed.",
    };
  }
}

export function cancelOperation(input: {
  database: DatabaseSync;
  operationId: string;
  threadId: string;
  sessionId: string;
}): boolean {
  const guarded = guardPlan(input);
  if (!guarded.ok) return false;
  return createOperationStore(input.database).requestCancel(input.operationId);
}

function classify(
  item: StoredOperationItem,
): "succeeded" | "not_attempted" | "uncertain" {
  const before = JSON.parse(item.beforeJson) as Fingerprint;
  const expected = JSON.parse(item.expectedJson) as { sha256?: string };
  const source = item.sourcePath;
  const destination = item.destinationPath;
  if (item.kind === "move" || item.kind === "rename") {
    const sourceGone = source ? !existsSync(source) : true;
    const destinationExists = destination ? existsSync(destination) : false;
    if (sourceGone && destinationExists) return "succeeded";
    if (
      source &&
      sameState(source, before) &&
      destination &&
      !existsSync(destination)
    ) {
      return "not_attempted";
    }
    return "uncertain";
  }
  if (item.kind === "trash") {
    if (source && !existsSync(source)) return "succeeded";
    if (source && sameState(source, before)) return "not_attempted";
    return "uncertain";
  }
  if (item.kind === "copy") {
    if (source && destination && existsSync(source) && existsSync(destination))
      return "succeeded";
    if (
      source &&
      sameState(source, before) &&
      destination &&
      !existsSync(destination)
    ) {
      return "not_attempted";
    }
    return "uncertain";
  }
  if (
    item.kind === "create_file" ||
    item.kind === "create_directory" ||
    item.kind === "edit"
  ) {
    const target = item.kind === "edit" ? source : destination;
    if (!target || !existsSync(target))
      return item.kind === "edit" ? "uncertain" : "not_attempted";
    if (item.kind === "create_directory") return "succeeded";
    const hash = createHash("sha256")
      .update(readFileSync(target))
      .digest("hex");
    if (expected.sha256 && hash === expected.sha256) return "succeeded";
    if (before.sha256 && hash === before.sha256) return "not_attempted";
    return "uncertain";
  }
  return "uncertain";
}

export function reconcileOperations(database: DatabaseSync): number {
  const store = createOperationStore(database);
  const ids = store.interruptedIds();
  for (const id of ids) {
    for (const item of store.items(id)) {
      if (item.status !== "uncertain") continue;
      const next = classify(item);
      store.markItem(item.id, { status: next });
    }
    store.finish(
      id,
      "needs_review",
      "needs_review",
      "An interrupted operation needs review and will not be replayed.",
      mutationPorts().now(),
    );
  }
  return ids.length;
}
