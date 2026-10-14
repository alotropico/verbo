import { lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ActionResult, ActorKind } from "../../shared/action-contract";
import {
  FILE_QUERY_LIMITS,
  IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  filesListArgsSchema,
  filesSearchArgsSchema,
  filesStatArgsSchema,
  filesNextArgsSchema,
  filesSummaryArgsSchema,
  type FileQuerySort,
  type FilesListArgs,
  type FilesSearchArgs,
} from "../../shared/file-query";
import { displayFinalPath } from "../../shared/files";
import {
  createQuerySnapshotStore,
  type StoredDir,
  type StoredItem,
  type StoredSnapshot,
} from "../db/query-snapshots";
import type { ScopeStore } from "../db/scopes";
import { resolveFileReference } from "./path-policy";
import { windowsFileFlags } from "./windows-containment";
import { recordFileResource } from "./resource-events";

const SKIP_DESCENT = new Set([".git", "node_modules", "__pycache__", ".cache"]);
const HIDDEN_NAMES = new Set(["desktop.ini", "thumbs.db", "$recycle.bin"]);
const TEXT = new Set<string>(TEXT_EXTENSIONS);
const IMAGE = new Set<string>(IMAGE_EXTENSIONS);

type Limits = {
  maxVisited: number;
  maxTimeMs: number;
  maxContentBytes: number;
};

type ScanOmissions = { hidden: number; skippedDescent: number };

type ScanResult = {
  items: StoredItem[];
  dirs: StoredDir[];
  examined: number;
  complete: boolean;
  warnings: string[];
  omitted: ScanOmissions;
};

export type FileQueryRequest = {
  database: DatabaseSync;
  store: ScopeStore;
  actor: ActorKind;
  threadId: string;
  now?: number;
  limits?: Partial<Limits>;
};

function failure(action: string, code: string, summary: string): ActionResult {
  return { action, status: "error", code, summary };
}

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\.+/u, "").toLowerCase();
}

function extensionOf(name: string): string {
  const base = win32.basename(name);
  if (base.startsWith(".") && !base.slice(1).includes(".")) return "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function fileReference(root: string, path?: string): string {
  if (!path) return root;
  const rest = path.replace(/^[\\/]+/u, "").replace(/[\\/]+$/u, "");
  if (!rest) return root;
  if (win32.isAbsolute(root)) {
    return win32.join(root, ...rest.split(/[\\/]+/u));
  }
  const alias = root.replace(/[\\/]+$/u, "");
  return `${alias}/${rest.split(/[\\/]+/u).join("/")}`;
}

function childDisplay(parent: string, name: string): string {
  if (win32.isAbsolute(parent))
    return displayFinalPath(win32.join(parent, name));
  const base = parent.endsWith("/") ? parent.slice(0, -1) : parent;
  return `${base}/${name}`;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString();
}

function epoch(iso?: string): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
}

function globMatches(name: string, glob: string): boolean {
  let source = "^";
  for (const char of glob) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`, "iu").test(name);
}

function sortOf(sort?: FileQuerySort): FileQuerySort {
  return {
    by: sort?.by ?? "name",
    direction: sort?.direction ?? "asc",
  };
}

function fingerprint(
  action: string,
  args: FilesListArgs | FilesSearchArgs,
  absolute: string,
  extensions: readonly string[],
): string {
  const search = "mode" in args ? args : undefined;
  const sort = sortOf(args.sort);
  return JSON.stringify({
    action,
    root: displayFinalPath(absolute).toLowerCase(),
    path: args.path ?? "",
    entryType: args.entryType,
    name: args.name ?? "",
    glob: args.glob ?? "",
    extensions,
    minSize: args.minSize ?? null,
    maxSize: args.maxSize ?? null,
    modifiedAfter: args.modifiedAfter ?? "",
    modifiedBefore: args.modifiedBefore ?? "",
    sortBy: sort.by,
    sortDirection: sort.direction,
    pageSize: args.pageSize,
    includeHidden: args.includeHidden,
    mode: search?.mode ?? "",
    query: search?.query ?? "",
    caseSensitive: search?.caseSensitive ?? false,
    groupBy: search?.groupBy ?? "",
    snippetChars: search?.snippetChars ?? 0,
  });
}

function effectiveExtensions(args: FilesListArgs | FilesSearchArgs): string[] {
  const listed = (args.extensions ?? [])
    .map(normalizeExtension)
    .filter(Boolean);
  if ("mode" in args && args.mode === "content" && listed.length === 0) {
    return [...TEXT_EXTENSIONS];
  }
  return [...new Set(listed)].sort();
}

function publicItem(item: StoredItem): Record<string, unknown> {
  return {
    path: item.displayPath,
    type: item.kind,
    size: item.kind === "file" ? item.size : null,
    ...(item.modifiedAt !== null ? { modified: stamp(item.modifiedAt) } : {}),
    ...(item.createdAt !== null ? { created: stamp(item.createdAt) } : {}),
    extension: item.extension,
    readOnly: item.readOnly,
    link: item.link,
    ...(item.snippet ? { snippet: item.snippet, source: "utf-8" } : {}),
    ...(item.lineNumber !== null ? { line: item.lineNumber } : {}),
    ...(item.matchCount !== null ? { matchCount: item.matchCount } : {}),
  };
}

function packDetail(
  payload: Record<string, unknown>,
  items: readonly Record<string, unknown>[],
): { detail: string; detailsAvailable: boolean } {
  let kept = [...items];
  let dropped = false;
  const render = (): string =>
    JSON.stringify({
      ...payload,
      items: kept,
      page: {
        ...(payload.page as Record<string, unknown>),
        returned: kept.length,
      },
    });
  let detail = render();
  while (detail.length > FILE_QUERY_LIMITS.detailBudget && kept.length > 1) {
    kept = kept.slice(0, -1);
    dropped = true;
    detail = render();
  }
  if (detail.length > FILE_QUERY_LIMITS.detailBudget && kept[0]) {
    const first = { ...kept[0] };
    if (typeof first.path === "string") {
      first.path = `${first.path.slice(0, 180)}…`;
    }
    delete first.snippet;
    kept = [first];
    dropped = true;
    detail = render();
  }
  return { detail, detailsAvailable: dropped };
}

function warn(warnings: string[], message: string): void {
  if (warnings.length >= FILE_QUERY_LIMITS.maxWarnings) return;
  if (warnings.includes(message)) return;
  warnings.push(message);
}

function hiddenEntry(name: string, absolute: string): boolean {
  if (name.startsWith(".") || HIDDEN_NAMES.has(name.toLowerCase())) return true;
  const flags = windowsFileFlags(absolute);
  return Boolean(flags?.hidden || flags?.system);
}

function snippetAround(
  line: string,
  query: string,
  caseSensitive: boolean,
  width: number,
): string {
  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at < 0) return line.slice(0, width);
  const pad = Math.max(0, Math.floor((width - needle.length) / 2));
  const start = Math.max(0, at - pad);
  const excerpt = line.slice(start, start + width);
  const prefix = start > 0 ? "…" : "";
  const suffix = start + width < line.length ? "…" : "";
  return `${prefix}${excerpt}${suffix}`;
}

function contentHits(
  text: string,
  query: string,
  caseSensitive: boolean,
  groupBy: "file" | "match",
  width: number,
): Array<{ line: number; snippet: string; matchCount: number }> {
  const needle = caseSensitive ? query : query.toLowerCase();
  const lines = text.split(/\r?\n/u);
  const hits: Array<{ line: number; snippet: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const haystack = caseSensitive ? line : line.toLowerCase();
    if (!haystack.includes(needle)) continue;
    hits.push({
      line: index + 1,
      snippet: snippetAround(line, query, caseSensitive, width),
    });
  }
  if (hits.length === 0) return [];
  if (groupBy === "file") {
    const first = hits[0];
    return first ? [{ ...first, matchCount: hits.length }] : [];
  }
  return hits
    .slice(0, FILE_QUERY_LIMITS.maxSnippetsPerFile)
    .map((hit) => ({ ...hit, matchCount: hits.length }));
}

function readText(
  absolute: string,
  size: number,
  maxBytes: number,
): string | null {
  if (size > maxBytes) return null;
  const buffer = readFileSync(absolute);
  recordFileResource(absolute);
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

type MetadataFilter = {
  entryType: FilesListArgs["entryType"];
  names: readonly string[];
  glob?: string;
  extensions: readonly string[];
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
};

function matchesMetadata(item: StoredItem, filter: MetadataFilter): boolean {
  if (filter.entryType === "files" && item.kind !== "file") return false;
  if (filter.entryType === "directories" && item.kind !== "directory")
    return false;
  const base = item.displayPath.split(/[\\/]/u).at(-1) ?? item.displayPath;
  for (const name of filter.names) {
    if (!base.toLowerCase().includes(name.toLowerCase())) return false;
  }
  if (filter.glob && !globMatches(base, filter.glob)) return false;
  if (
    filter.extensions.length > 0 &&
    (item.kind !== "file" || !filter.extensions.includes(item.extension))
  ) {
    return false;
  }
  if (filter.minSize !== undefined || filter.maxSize !== undefined) {
    if (item.size === null) return false;
    if (filter.minSize !== undefined && item.size < filter.minSize)
      return false;
    if (filter.maxSize !== undefined && item.size > filter.maxSize)
      return false;
  }
  if (
    filter.modifiedAfter !== undefined ||
    filter.modifiedBefore !== undefined
  ) {
    if (item.modifiedAt === null) return false;
    if (
      filter.modifiedAfter !== undefined &&
      item.modifiedAt < filter.modifiedAfter
    ) {
      return false;
    }
    if (
      filter.modifiedBefore !== undefined &&
      item.modifiedAt > filter.modifiedBefore
    ) {
      return false;
    }
  }
  return true;
}

function scanTree(input: {
  absolute: string;
  display: string;
  includeHidden: boolean;
  filter: MetadataFilter;
  content?: {
    query: string;
    caseSensitive: boolean;
    groupBy: "file" | "match";
    snippetChars: number;
  };
  limits: Limits;
}): ScanResult {
  const items: StoredItem[] = [];
  const dirs: StoredDir[] = [];
  const warnings: string[] = [];
  const omitted: ScanOmissions = { hidden: 0, skippedDescent: 0 };
  let examined = 0;
  let complete = true;
  const started = Date.now();

  const pushItem = (item: StoredItem): void => {
    if (!matchesMetadata(item, input.filter)) return;
    if (!input.content) {
      items.push(item);
      return;
    }
    if (item.kind !== "file" || !TEXT.has(item.extension)) {
      if (input.filter.extensions.length > 0 && !TEXT.has(item.extension)) {
        warn(warnings, "Skipped unsupported formats.");
      }
      return;
    }
    if ((item.size ?? 0) > input.limits.maxContentBytes) {
      warn(warnings, "Skipped files larger than the content cap.");
      return;
    }
    let text: string | null = null;
    try {
      text = readText(
        item.absolutePath,
        item.size ?? 0,
        input.limits.maxContentBytes,
      );
    } catch {
      warn(warnings, "Skipped files that could not be read.");
      return;
    }
    if (text === null) {
      warn(warnings, "Skipped files that are not UTF-8 text.");
      return;
    }
    const hits = contentHits(
      text,
      input.content.query,
      input.content.caseSensitive,
      input.content.groupBy,
      input.content.snippetChars,
    );
    for (const hit of hits) {
      items.push({
        ...item,
        snippet: hit.snippet,
        lineNumber: hit.line,
        matchCount: hit.matchCount,
      });
    }
  };

  type DirectoryFrame = {
    directory: string;
    display: string;
    listing: Dirent[];
    index: number;
  };
  const openDirectory = (
    directory: string,
    display: string,
  ): DirectoryFrame | null => {
    let listing: Dirent[];
    try {
      const flags = windowsFileFlags(directory);
      if (flags?.reparse) return null;
      const stats = lstatSync(directory);
      if (stats.isSymbolicLink()) return null;
      dirs.push({
        absolutePath: displayFinalPath(directory),
        modifiedAt: Math.trunc(stats.mtimeMs),
      });
      listing = readdirSync(directory, { withFileTypes: true });
    } catch {
      warn(warnings, "Skipped a folder that could not be opened.");
      return null;
    }
    listing.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "accent" }),
    );
    return { directory, display, listing, index: 0 };
  };
  const initial = openDirectory(input.absolute, input.display);
  const directories = initial ? [initial] : [];
  while (directories.length) {
    const frame = directories[directories.length - 1];
    const entry = frame.listing[frame.index++];
    if (!entry) {
      directories.pop();
      continue;
    }
    const { directory, display } = frame;
    if (
      examined >= input.limits.maxVisited ||
      Date.now() - started >= input.limits.maxTimeMs
    ) {
      complete = false;
      break;
    }
    if (!entry.name || entry.name === "." || entry.name === "..") continue;
    examined += 1;
    const absolute = displayFinalPath(win32.join(directory, entry.name));
    if (!input.includeHidden && hiddenEntry(entry.name, absolute)) {
      omitted.hidden += 1;
      continue;
    }
    if (SKIP_DESCENT.has(entry.name.toLowerCase())) {
      omitted.skippedDescent += 1;
      continue;
    }
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      warn(warnings, "Skipped an entry that could not be opened.");
      continue;
    }
    const flags = windowsFileFlags(absolute);
    const link = entry.isSymbolicLink() || Boolean(flags?.reparse);
    const directoryEntry = stats.isDirectory() && !link;
    const kind: StoredItem["kind"] = link
      ? "link"
      : directoryEntry
        ? "directory"
        : "file";
    pushItem({
      displayPath: childDisplay(display, entry.name),
      absolutePath: absolute,
      kind,
      extension: kind === "file" ? extensionOf(entry.name) : "",
      size: kind === "file" ? stats.size : null,
      modifiedAt: Math.trunc(stats.mtimeMs),
      createdAt: Math.trunc(stats.birthtimeMs),
      readOnly: Boolean(flags?.readOnly),
      link,
      snippet: null,
      lineNumber: null,
      matchCount: null,
    });
    if (directoryEntry) {
      const next = openDirectory(absolute, childDisplay(display, entry.name));
      if (next) directories.push(next);
    }
  }
  return { items, dirs, examined, complete, warnings, omitted };
}

function resolveRoot(
  request: FileQueryRequest,
  root: string,
  path: string | undefined,
):
  | { ok: true; absolute: string; display: string }
  | { ok: false; result: ActionResult } {
  const resolved = resolveFileReference({
    reference: fileReference(root, path),
    purpose: "read",
    actor: request.actor,
    scopes: request.store.list(),
    grants: request.store.activeGrants(),
    now: request.now,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      result: failure("files.list", resolved.code, resolved.summary),
    };
  }
  let stats;
  try {
    stats = lstatSync(resolved.path.absolute);
  } catch {
    return {
      ok: false,
      result: failure("files.list", "missing", "That path does not exist."),
    };
  }
  const flags = windowsFileFlags(resolved.path.absolute);
  if (stats.isSymbolicLink() || flags?.reparse) {
    return {
      ok: false,
      result: failure(
        "files.list",
        "link",
        "That path is a link. Open the target through its own scope.",
      ),
    };
  }
  if (!stats.isDirectory()) {
    return {
      ok: false,
      result: failure(
        "files.list",
        "not_a_directory",
        "That path is a file. List its folder instead.",
      ),
    };
  }
  return {
    ok: true,
    absolute: displayFinalPath(resolved.path.absolute),
    display: resolved.path.display,
  };
}

function withAction(result: ActionResult, action: string): ActionResult {
  return { ...result, action };
}

function limitsOf(override?: Partial<Limits>): Limits {
  return {
    maxVisited: override?.maxVisited ?? FILE_QUERY_LIMITS.maxVisited,
    maxTimeMs: override?.maxTimeMs ?? FILE_QUERY_LIMITS.maxTimeMs,
    maxContentBytes:
      override?.maxContentBytes ?? FILE_QUERY_LIMITS.maxContentBytes,
  };
}

function omissionNote(omitted: ScanOmissions): string {
  if (omitted.hidden === 0 && omitted.skippedDescent === 0) return "";
  return ` Omitted ${omitted.hidden} hidden names and ${omitted.skippedDescent} skipped folders from the exact total.`;
}

function pageResult(input: {
  action: string;
  snapshot: StoredSnapshot;
  items: readonly StoredItem[];
  offset: number;
  total: number;
  store: ReturnType<typeof createQuerySnapshotStore>;
}): ActionResult {
  let rows = [...input.items];
  const kinds = input.store.countKinds(input.snapshot.id);
  const exact = input.snapshot.complete;
  const scan = {
    complete: input.snapshot.complete,
    examined: input.snapshot.examined,
    warnings: input.snapshot.warnings,
    omitted: input.snapshot.omissions,
  };
  const counts = {
    directories: {
      observed: kinds.directories,
      exactTotal: exact ? kinds.directories : null,
    },
    files: {
      observed: kinds.files,
      exactTotal: exact ? kinds.files : null,
    },
  };
  const placeholder = "00000000-0000-4000-8000-000000000000";
  let returned = rows.length;
  let hasMore = input.offset + returned < input.total;
  let detail = "";
  while (rows.length > 0) {
    returned = rows.length;
    hasMore = input.offset + returned < input.total;
    detail = JSON.stringify({
      resultSet: input.snapshot.id,
      items: rows.map(publicItem),
      counts,
      page: {
        returned,
        hasMore,
        totalKnown: input.snapshot.complete ? input.total : null,
        ...(hasMore ? { nextCursor: placeholder } : {}),
      },
      scan,
    });
    if (detail.length <= FILE_QUERY_LIMITS.detailBudget || rows.length === 1) {
      break;
    }
    rows = rows.slice(0, -1);
  }
  const dropped = rows.length < input.items.length;
  if (hasMore) {
    const nextCursor = input.store.putCursor(
      input.snapshot.id,
      input.offset + returned,
      input.snapshot.expiresAt,
    );
    detail = detail.replace(placeholder, nextCursor);
  }
  const limited = !input.snapshot.complete;
  const skipped = input.snapshot.warnings.length > 0;
  return {
    action: input.action,
    status: limited || skipped ? "partial" : "success",
    ...(limited
      ? { code: "limit_reached" }
      : skipped
        ? { code: "skipped" }
        : {}),
    summary: limited
      ? `Listed ${returned} entries. The scan hit a limit.`
      : hasMore
        ? `Listed ${returned} entries. More remain.`
        : `Listed ${returned} entries.${omissionNote(input.snapshot.omissions)}`,
    detail,
    ...(input.snapshot.complete ? { totalItems: input.total } : {}),
    ...(dropped || hasMore ? { detailsAvailable: true } : {}),
  };
}

function snapshotFresh(
  store: ReturnType<typeof createQuerySnapshotStore>,
  snapshotId: string,
): boolean {
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

function continueCursor(input: {
  request: FileQueryRequest;
  action: string;
  args: FilesListArgs | FilesSearchArgs;
  absolute: string;
  extensions: readonly string[];
}): ActionResult | null {
  if (!input.args.cursor) return null;
  const now = input.request.now ?? Date.now();
  const store = createQuerySnapshotStore(input.request.database);
  store.purge(now);
  const cursor = store.takeCursor(input.args.cursor);
  if (!cursor || cursor.expiresAt <= now) {
    return failure(
      input.action,
      "stale_cursor",
      "That page cursor expired. Run the query again.",
    );
  }
  const snapshot = store.snapshot(cursor.snapshotId);
  if (!snapshot || snapshot.expiresAt <= now) {
    return failure(
      input.action,
      "stale_cursor",
      "That result set expired. Run the query again.",
    );
  }
  if (snapshot.threadId !== input.request.threadId) {
    return failure(
      input.action,
      "session_mismatch",
      "That page cursor belongs to another conversation.",
    );
  }
  if (snapshot.scopeGeneration !== input.request.store.generation()) {
    store.remove(snapshot.id);
    return failure(
      input.action,
      "stale_cursor",
      "Folders changed since that page. Run the query again.",
    );
  }
  const expected = fingerprint(
    input.action,
    input.args,
    input.absolute,
    input.extensions,
  );
  if (snapshot.fingerprint !== expected) {
    return failure(
      input.action,
      "query_mismatch",
      "That cursor belongs to a different query.",
    );
  }
  if (!snapshotFresh(store, snapshot.id)) {
    store.remove(snapshot.id);
    return failure(
      input.action,
      "stale_cursor",
      "Files changed since that page. Run the query again.",
    );
  }
  const total = store.countItems(snapshot.id);
  const page = store.page(
    snapshot.id,
    cursor.offset,
    input.args.pageSize,
    snapshot.sort,
  );
  return pageResult({
    action: input.action,
    snapshot,
    items: page,
    offset: cursor.offset,
    total,
    store,
  });
}

function runQuery(
  request: FileQueryRequest,
  action: "files.list" | "files.search",
  args: FilesListArgs | FilesSearchArgs,
): ActionResult {
  if (args.glob && (/[\\/]/u.test(args.glob) || args.glob.includes("**"))) {
    return failure(
      action,
      "invalid_args",
      "Glob matches a file name, not a path.",
    );
  }
  if (args.glob && (args.glob.match(/\*/gu) ?? []).length > 8) {
    return failure(action, "invalid_args", "Use a simpler file-name glob.");
  }
  const search = "mode" in args ? args : undefined;
  if (search?.mode === "content" && !search.query) {
    return failure(action, "invalid_args", "Content search needs a query.");
  }
  const extensions = effectiveExtensions(args);
  if (
    search?.mode === "content" &&
    extensions.length > 0 &&
    extensions.every((extension) => !TEXT.has(extension))
  ) {
    return {
      action,
      status: "not_supported",
      code: "unsupported_format",
      summary: "Content search reads UTF-8 text files only.",
    };
  }
  const root = resolveRoot(request, args.root, args.path);
  if (!root.ok) return withAction(root.result, action);
  const continued = continueCursor({
    request,
    action,
    args,
    absolute: root.absolute,
    extensions,
  });
  if (continued) return continued;

  const names = [
    args.name,
    search?.mode === "filename" ? search.query : undefined,
  ].filter((value): value is string => Boolean(value));
  const filter: MetadataFilter = {
    entryType: args.entryType,
    names,
    ...(args.glob ? { glob: args.glob } : {}),
    extensions,
    ...(args.minSize !== undefined ? { minSize: args.minSize } : {}),
    ...(args.maxSize !== undefined ? { maxSize: args.maxSize } : {}),
    ...(epoch(args.modifiedAfter) !== undefined
      ? { modifiedAfter: epoch(args.modifiedAfter) }
      : {}),
    ...(epoch(args.modifiedBefore) !== undefined
      ? { modifiedBefore: epoch(args.modifiedBefore) }
      : {}),
  };
  const scanned = scanTree({
    absolute: root.absolute,
    display: root.display,
    includeHidden: args.includeHidden,
    filter,
    ...(search?.mode === "content" && search.query
      ? {
          content: {
            query: search.query,
            caseSensitive: search.caseSensitive,
            groupBy: search.groupBy,
            snippetChars: search.snippetChars,
          },
        }
      : {}),
    limits: limitsOf(request.limits),
  });
  const now = request.now ?? Date.now();
  const snapshots = createQuerySnapshotStore(request.database);
  const snapshot = snapshots.save({
    now,
    threadId: request.threadId,
    fingerprint: fingerprint(action, args, root.absolute, extensions),
    scopeGeneration: request.store.generation(),
    rootPath: root.absolute,
    sort: sortOf(args.sort),
    complete: scanned.complete,
    examined: scanned.examined,
    warnings: scanned.warnings,
    omissions: scanned.omitted,
    items: scanned.items,
    dirs: scanned.dirs,
  });
  const total = snapshots.countItems(snapshot.id);
  const page = snapshots.page(snapshot.id, 0, args.pageSize, snapshot.sort);
  return pageResult({
    action,
    snapshot,
    items: page,
    offset: 0,
    total,
    store: snapshots,
  });
}

export function listFiles(
  request: FileQueryRequest,
  args: unknown,
): ActionResult {
  const parsed = filesListArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure(
      "files.list",
      "invalid_args",
      "Those list arguments are not valid.",
    );
  }
  return runQuery(request, "files.list", parsed.data);
}

export function searchFiles(
  request: FileQueryRequest,
  args: unknown,
): ActionResult {
  const parsed = filesSearchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure(
      "files.search",
      "invalid_args",
      "Those search arguments are not valid.",
    );
  }
  return runQuery(request, "files.search", parsed.data);
}

export function statFiles(
  request: FileQueryRequest,
  args: unknown,
): ActionResult {
  const parsed = filesStatArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure(
      "files.stat",
      "invalid_args",
      "Stat needs one or more paths.",
    );
  }
  const items: Record<string, unknown>[] = [];
  const errors: Array<{ path: string; code: string; summary: string }> = [];
  for (const reference of parsed.data.paths) {
    const resolved = resolveFileReference({
      reference,
      purpose: "read",
      actor: request.actor,
      scopes: request.store.list(),
      grants: request.store.activeGrants(),
      now: request.now,
    });
    if (!resolved.ok) {
      errors.push({
        path: reference,
        code: resolved.code,
        summary: resolved.summary,
      });
      continue;
    }
    let stats;
    try {
      stats = lstatSync(resolved.path.absolute);
    } catch {
      errors.push({
        path: reference,
        code: "missing",
        summary: "That path does not exist.",
      });
      continue;
    }
    const flags = windowsFileFlags(resolved.path.absolute);
    const link = stats.isSymbolicLink() || Boolean(flags?.reparse);
    const kind: StoredItem["kind"] = link
      ? "link"
      : stats.isDirectory()
        ? "directory"
        : "file";
    const extension = kind === "file" ? extensionOf(resolved.path.display) : "";
    const format = TEXT.has(extension)
      ? "text"
      : IMAGE.has(extension)
        ? "image"
        : "unknown";
    items.push({
      path: resolved.path.display,
      type: kind,
      size: kind === "file" ? stats.size : null,
      modified: stamp(Math.trunc(stats.mtimeMs)),
      created: stamp(Math.trunc(stats.birthtimeMs)),
      extension,
      readOnly: Boolean(flags?.readOnly),
      link,
      format,
    });
  }
  if (items.length === 0) {
    return failure(
      "files.stat",
      errors[0]?.code ?? "missing",
      errors[0]?.summary ?? "Those paths could not be read.",
    );
  }
  const packed = packDetail(
    {
      errors,
      page: {
        returned: items.length,
        hasMore: false,
        totalKnown: items.length,
      },
    },
    items,
  );
  return {
    action: "files.stat",
    status: errors.length > 0 ? "partial" : "success",
    ...(errors.length > 0 ? { code: "partial_stat" } : {}),
    summary:
      errors.length > 0
        ? `Read metadata for ${items.length} paths. ${errors.length} failed.`
        : `Read metadata for ${items.length} paths.`,
    detail: packed.detail,
    totalItems: items.length,
    ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
  };
}

export function summarizeFiles(
  request: FileQueryRequest,
  args: unknown,
): ActionResult {
  const parsed = filesSummaryArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure(
      "files.summary",
      "invalid_args",
      "Those summary arguments are not valid.",
    );
  }
  const root = resolveRoot(request, parsed.data.root, parsed.data.path);
  if (!root.ok) return withAction(root.result, "files.summary");
  const scanned = scanTree({
    absolute: root.absolute,
    display: root.display,
    includeHidden: parsed.data.includeHidden,
    filter: {
      entryType: parsed.data.entryType,
      names: [],
      extensions: [],
    },
    limits: limitsOf(request.limits),
  });
  const files = scanned.items.filter((item) => item.kind === "file");
  const directories = scanned.items.filter((item) => item.kind === "directory");
  const links = scanned.items.filter((item) => item.kind === "link");
  const byExtension = new Map<string, number>();
  let totalBytes = 0;
  let largest: StoredItem | null = null;
  let newest: StoredItem | null = null;
  let oldest: StoredItem | null = null;
  for (const file of files) {
    const extension = file.extension || "(none)";
    byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
    totalBytes += file.size ?? 0;
    if (!largest || (file.size ?? -1) > (largest.size ?? -1)) largest = file;
    if (
      file.modifiedAt !== null &&
      (!newest || file.modifiedAt > (newest.modifiedAt ?? -1))
    ) {
      newest = file;
    }
    if (
      file.modifiedAt !== null &&
      (!oldest ||
        file.modifiedAt < (oldest.modifiedAt ?? Number.POSITIVE_INFINITY))
    ) {
      oldest = file;
    }
  }
  const brief = (item: StoredItem | null): Record<string, unknown> | null => {
    if (!item) return null;
    return {
      path: item.displayPath,
      size: item.size,
      ...(item.modifiedAt !== null ? { modified: stamp(item.modifiedAt) } : {}),
    };
  };
  const body = {
    complete: scanned.complete,
    examined: scanned.examined,
    files: files.length,
    directories: directories.length,
    links: links.length,
    totalBytes: scanned.complete ? totalBytes : null,
    byExtension: [...byExtension.entries()]
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .slice(0, 20)
      .map(([extension, count]) => ({ extension, count })),
    largest: brief(largest),
    newest: brief(newest),
    oldest: brief(oldest),
    warnings: scanned.warnings,
    omitted: scanned.omitted,
    counts: {
      directories: {
        observed: directories.length,
        exactTotal: scanned.complete ? directories.length : null,
      },
      files: {
        observed: files.length,
        exactTotal: scanned.complete ? files.length : null,
      },
    },
  };
  return {
    action: "files.summary",
    status: scanned.complete ? "success" : "partial",
    ...(!scanned.complete ? { code: "limit_reached" } : {}),
    summary: scanned.complete
      ? `Summarized ${files.length} files and ${directories.length} folders.${omissionNote(scanned.omitted)}`
      : "The summary hit a limit before the folder was fully examined.",
    detail: JSON.stringify(body),
    ...(scanned.complete
      ? { totalItems: files.length + directories.length }
      : {}),
  };
}

export function continueFilePage(
  request: FileQueryRequest,
  args: unknown,
): ActionResult {
  const parsed = filesNextArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure("files.next", "invalid_args", "Next needs a page cursor.");
  }
  const now = request.now ?? Date.now();
  const store = createQuerySnapshotStore(request.database);
  store.purge(now);
  const cursor = store.takeCursor(parsed.data.cursor);
  if (!cursor || cursor.expiresAt <= now) {
    return failure(
      "files.next",
      "stale_cursor",
      "That page cursor expired. Run the query again.",
    );
  }
  const snapshot = store.snapshot(cursor.snapshotId);
  if (!snapshot || snapshot.expiresAt <= now) {
    return failure(
      "files.next",
      "stale_cursor",
      "That result set expired. Run the query again.",
    );
  }
  if (snapshot.threadId !== request.threadId) {
    return failure(
      "files.next",
      "session_mismatch",
      "That page cursor belongs to another conversation.",
    );
  }
  if (snapshot.scopeGeneration !== request.store.generation()) {
    store.remove(snapshot.id);
    return failure(
      "files.next",
      "stale_cursor",
      "Folders changed since that page. Run the query again.",
    );
  }
  if (!snapshotFresh(store, snapshot.id)) {
    store.remove(snapshot.id);
    return failure(
      "files.next",
      "stale_cursor",
      "Files changed since that page. Run the query again.",
    );
  }
  const total = store.countItems(snapshot.id);
  const page = store.page(
    snapshot.id,
    cursor.offset,
    parsed.data.pageSize,
    snapshot.sort,
  );
  return pageResult({
    action: "files.next",
    snapshot,
    items: page,
    offset: cursor.offset,
    total,
    store,
  });
}
