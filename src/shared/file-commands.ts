const SORTS = new Set([
  "name",
  "extension",
  "type",
  "size",
  "modified",
  "created",
]);

export type FileCommandCall = {
  actionId: string;
  args: Record<string, unknown>;
};

export type CommandFailure = { ok: false; summary: string };

export type ParsedFileCommand =
  { ok: true; call: FileCommandCall } | CommandFailure;

type FlagSuccess = {
  ok: true;
  positionals: string[];
  flags: Map<string, string[]>;
  hidden: boolean;
};

type QueryArgs = { ok: true; args: Record<string, unknown> };

function tokenize(input: string): string[] | { error: string } {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/u.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;
    const quote = input[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let value = "";
      let closed = false;
      while (index < input.length) {
        const char = input[index] ?? "";
        if (char === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (char === "\\" && quote === '"') {
          const next = input[index + 1];
          if (next === '"' || next === "\\") {
            value += next;
            index += 2;
            continue;
          }
        }
        value += char;
        index += 1;
      }
      if (!closed) return { error: "A quoted string was not closed." };
      tokens.push(value);
      continue;
    }
    let value = "";
    while (index < input.length && !/\s/u.test(input[index] ?? "")) {
      value += input[index];
      index += 1;
    }
    tokens.push(value);
  }
  return tokens;
}

function fail(summary: string): CommandFailure {
  return { ok: false, summary };
}

function unknownFlag(
  flags: Map<string, string[]>,
  allowed: readonly string[],
): CommandFailure | null {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) return fail(`Unknown flag --${name}.`);
  }
  return null;
}

function flagsOf(tokens: readonly string[]): FlagSuccess | CommandFailure {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let hidden = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!name) return fail("That flag is empty.");
    if (name === "hidden") {
      hidden = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return fail(`--${name} needs a value.`);
    }
    index += 1;
    const list = flags.get(name) ?? [];
    list.push(value);
    flags.set(name, list);
  }
  return { ok: true, positionals, flags, hidden };
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  if (!values || values.length === 0) return undefined;
  return values[values.length - 1];
}

function integer(
  value: string | undefined,
  name: string,
): number | CommandFailure {
  if (value === undefined) return fail(`--${name} needs a value.`);
  if (!/^\d+$/u.test(value)) return fail(`--${name} needs a whole number.`);
  return Number(value);
}

function extensions(flags: Map<string, string[]>): string[] {
  const values = flags.get("ext") ?? [];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().replace(/^\.+/u, ""))
    .filter((value) => value.length > 0);
}

function sortOf(
  value: string | undefined,
): { by: string; direction: string } | CommandFailure | undefined {
  if (value === undefined) return undefined;
  const [by, direction = "asc"] = value.split(":");
  if (!by || !SORTS.has(by) || (direction !== "asc" && direction !== "desc")) {
    return fail(
      "--sort uses name, extension, type, size, modified, or created, with :asc or :desc.",
    );
  }
  return { by, direction };
}

function sharedQuery(
  flags: Map<string, string[]>,
  hidden: boolean,
): QueryArgs | CommandFailure {
  const args: Record<string, unknown> = {};
  const path = one(flags, "path");
  if (path) args.path = path;
  const entryType = one(flags, "type");
  if (entryType !== undefined) {
    if (
      entryType !== "all" &&
      entryType !== "files" &&
      entryType !== "directories"
    ) {
      return fail("--type is all, files, or directories.");
    }
    args.entryType = entryType;
  }
  const name = one(flags, "name");
  if (name) args.name = name;
  const glob = one(flags, "glob");
  if (glob) args.glob = glob;
  const extensionList = extensions(flags);
  if (extensionList.length > 0) args.extensions = extensionList;
  const pageSize = one(flags, "page-size");
  if (pageSize !== undefined) {
    const parsed = integer(pageSize, "page-size");
    if (typeof parsed !== "number") return parsed;
    args.pageSize = parsed;
  }
  const sort = sortOf(one(flags, "sort"));
  if (sort && "ok" in sort) return sort;
  if (sort) args.sort = sort;
  if (hidden) args.includeHidden = true;
  return { ok: true, args };
}

export function parseActionCommand(rest: string): ParsedFileCommand {
  const trimmed = rest.trim();
  const split = /^(\S+)\s*([\s\S]*)$/u.exec(trimmed);
  const id = split?.[1] ?? "";
  const jsonText = split?.[2]?.trim() ?? "";
  if (!id) return fail("/action needs an action id and a JSON object.");
  if (id === "approve" || id.endsWith(".approve")) {
    return fail("Approval is not a command.");
  }
  if (!jsonText) return fail("/action needs a JSON object.");
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch {
    return fail("Those arguments are not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("/action arguments must be a JSON object.");
  }
  if ("approved" in value) return fail("Approval is not a command.");
  return {
    ok: true,
    call: { actionId: id, args: value as Record<string, unknown> },
  };
}

export function parseFilesCommand(rest: string): ParsedFileCommand {
  const tokens = tokenize(rest.trim());
  if (!Array.isArray(tokens)) return fail(tokens.error);
  const verb = tokens[0]?.toLowerCase() ?? "";
  const parsed = flagsOf(tokens.slice(1));
  if (!parsed.ok) return parsed;
  const { positionals, flags, hidden } = parsed;
  if (verb === "next") {
    const unknown = unknownFlag(flags, ["page-size"]);
    if (unknown) return unknown;
    const cursor = positionals[0];
    if (!cursor || positionals.length !== 1) {
      return fail("/files next needs one page cursor.");
    }
    const args: Record<string, unknown> = { cursor };
    const pageSize = one(flags, "page-size");
    if (pageSize !== undefined) {
      const parsedSize = integer(pageSize, "page-size");
      if (typeof parsedSize !== "number") return parsedSize;
      args.pageSize = parsedSize;
    }
    return { ok: true, call: { actionId: "files.next", args } };
  }
  if (verb === "read") {
    const unknown = unknownFlag(flags, ["lines", "pointer", "page"]);
    if (unknown) return unknown;
    const path = positionals[0];
    if (!path || positionals.length !== 1)
      return fail("/files read needs one path.");
    const args: Record<string, unknown> = { path };
    const lines = one(flags, "lines");
    if (lines !== undefined) {
      const match = /^(\d+):(\d+)$/u.exec(lines);
      if (!match?.[1] || !match[2])
        return fail("--lines uses start:end, such as 1:100.");
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (end < start) return fail("--lines end comes after the start.");
      args.startLine = start;
      args.lineCount = end - start + 1;
    }
    const pointer = one(flags, "pointer");
    if (pointer) args.pointer = pointer;
    const page = one(flags, "page");
    if (page !== undefined) {
      const parsedPage = integer(page, "page");
      if (typeof parsedPage !== "number") return parsedPage;
      args.page = parsedPage;
    }
    return { ok: true, call: { actionId: "files.read", args } };
  }
  if (verb === "stat") {
    const unknown = unknownFlag(flags, []);
    if (unknown) return unknown;
    if (positionals.length === 0)
      return fail("/files stat needs at least one path.");
    return {
      ok: true,
      call: { actionId: "files.stat", args: { paths: positionals } },
    };
  }
  if (
    verb !== "list" &&
    verb !== "find" &&
    verb !== "grep" &&
    verb !== "summary"
  ) {
    return fail("Use /files list, find, grep, stat, summary, read, or next.");
  }
  const root = positionals[0];
  if (!root || positionals.length !== 1) {
    return fail(`/files ${verb} needs one root.`);
  }
  const queryFlags = [
    "path",
    "type",
    "name",
    "glob",
    "ext",
    "page-size",
    "sort",
  ];
  const unknown = unknownFlag(
    flags,
    verb === "summary"
      ? ["path"]
      : verb === "grep"
        ? [...queryFlags, "text", "case"]
        : verb === "find"
          ? [...queryFlags, "text"]
          : queryFlags,
  );
  if (unknown) return unknown;
  const query = sharedQuery(flags, hidden);
  if (!query.ok) return query;
  const args: Record<string, unknown> = { root, ...query.args };
  if (verb === "list")
    return { ok: true, call: { actionId: "files.list", args } };
  if (verb === "summary") {
    return { ok: true, call: { actionId: "files.summary", args } };
  }
  if (verb === "grep") {
    const text = one(flags, "text");
    if (!text) return fail("/files grep needs --text.");
    args.mode = "content";
    args.query = text;
    if (one(flags, "case") === "sensitive") args.caseSensitive = true;
    return { ok: true, call: { actionId: "files.search", args } };
  }
  const text = one(flags, "text") ?? one(flags, "name");
  args.mode = "filename";
  if (text && !args.name) args.query = text;
  return { ok: true, call: { actionId: "files.search", args } };
}
