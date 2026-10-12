import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionResult } from "../../shared/action-contract";
import { FILE_QUERY_LIMITS } from "../../shared/file-query";
import { displayFinalPath } from "../../shared/files";
import { registryForDatabase } from "../capabilities/catalog";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { createScopeStore } from "../db/scopes";
import { listFiles } from "./query-engine";

const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "verbo-query-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "verbo.sqlite"));
  databases.push(db);
  migrateDatabase(db, VERBO_MIGRATIONS);
  return db;
}

function folder(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), name));
  directories.push(directory);
  return directory;
}

function register(root: string): DatabaseSync {
  const db = database();
  const saved = createScopeStore(db).apply({
    removeIds: [],
    updates: [],
    additions: [
      {
        alias: "notes",
        path: root,
        read: true,
        write: true,
        defaultSave: false,
      },
    ],
  });
  expect(saved.ok).toBe(true);
  return db;
}

function invoke(
  db: DatabaseSync,
  name: string,
  args: Record<string, unknown>,
  threadId = "thread-1",
  actor: "model" | "user_command" = "model",
): ActionResult {
  return registryForDatabase(db).invoke(name, args, { actor, threadId });
}

function body(result: ActionResult): {
  items: Array<{
    path: string;
    type: string;
    size: number | null;
    snippet?: string;
    line?: number;
    link?: boolean;
  }>;
  page: {
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
    totalKnown: number | null;
  };
  scan: { complete: boolean; examined: number; warnings: string[] };
} {
  return JSON.parse(result.detail ?? "{}") as ReturnType<typeof body>;
}

describe("file queries", () => {
  it("lists one level, keeps folder size unknown, and pages in order", () => {
    const root = folder("verbo-list-");
    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "a.txt"), "aa");
    writeFileSync(join(root, "sub", "nested.txt"), "n");
    writeFileSync(join(root, "sub", "deep", "bottom.txt"), "c");
    const db = register(root);

    const listed = invoke(db, "files.list", {
      root: "notes:",
      depth: 0,
      pageSize: 2,
      sort: { by: "name", direction: "asc" },
    });
    expect(listed.status).toBe("success");
    const page = body(listed);
    expect(page.items.map((item) => item.path)).toEqual([
      "notes:/a.txt",
      "notes:/b.txt",
    ]);
    expect(page.items[0]?.size).toBe(2);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.totalKnown).toBe(3);
    expect(listed.detail).not.toContain(displayFinalPath(root));
    expect(listed.detail).not.toContain("nested.txt");

    const next = invoke(db, "files.list", {
      root: "notes:",
      depth: 0,
      pageSize: 2,
      sort: { by: "name", direction: "asc" },
      cursor: page.page.nextCursor,
    });
    const second = body(next);
    expect(second.items.map((item) => item.path)).toEqual(["notes:/sub"]);
    expect(second.items[0]?.size).toBeNull();
    expect(second.items[0]?.type).toBe("directory");
    expect(second.page.hasMore).toBe(false);
    expect(second.page.nextCursor).toBeUndefined();
  });

  it("applies depth, extension, hidden, and skip rules", () => {
    const root = folder("verbo-filter-");
    mkdirSync(join(root, "sub"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "note.MD"), "md");
    writeFileSync(join(root, "picture.png"), "img");
    writeFileSync(join(root, ".secret.md"), "hidden");
    writeFileSync(join(root, "sub", "inner.md"), "inner");
    writeFileSync(join(root, "node_modules", "pkg", "leak.txt"), "leak");
    const db = register(root);

    const depth = body(
      invoke(db, "files.list", { root: "notes:", depth: 1, pageSize: 20 }),
    );
    const paths = depth.items.map((item) => item.path);
    expect(paths).toContain("notes:/sub/inner.md");
    expect(paths).not.toContain("notes:/node_modules/pkg/leak.txt");
    expect(depth.scan.complete).toBe(true);
    expect(JSON.stringify(depth)).not.toContain("leak.txt");
    expect(JSON.stringify(depth)).not.toContain(".secret.md");

    const markdown = body(
      invoke(db, "files.list", {
        root: "notes:",
        depth: 1,
        extensions: [".MD"],
        pageSize: 20,
      }),
    );
    expect(markdown.items.map((item) => item.path)).toEqual([
      "notes:/note.MD",
      "notes:/sub/inner.md",
    ]);

    const hidden = body(
      invoke(db, "files.list", {
        root: "notes:",
        includeHidden: true,
        pageSize: 20,
      }),
    );
    expect(hidden.items.map((item) => item.path)).toContain(
      "notes:/.secret.md",
    );
  });

  it("tie-breaks equal timestamps by path and rejects a changed page", () => {
    const root = folder("verbo-sort-");
    const stamp = new Date("2026-10-10T12:00:00Z");
    writeFileSync(join(root, "b.md"), "b");
    writeFileSync(join(root, "a.md"), "a");
    utimesSync(join(root, "a.md"), stamp, stamp);
    utimesSync(join(root, "b.md"), stamp, stamp);
    const db = register(root);
    const args = {
      root: "notes:",
      pageSize: 1,
      sort: { by: "modified" as const, direction: "desc" as const },
    };
    const first = body(invoke(db, "files.list", args));
    expect(first.items[0]?.path).toBe("notes:/a.md");
    writeFileSync(join(root, "c.md"), "c");
    const stale = invoke(db, "files.list", {
      ...args,
      cursor: first.page.nextCursor,
    });
    expect(stale.status).toBe("error");
    expect(stale.code).toBe("stale_cursor");
  });

  it("rejects a cursor from another query or conversation", () => {
    const root = folder("verbo-cursor-");
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    const db = register(root);
    const first = body(
      invoke(db, "files.list", {
        root: "notes:",
        extensions: ["txt"],
        pageSize: 1,
      }),
    );
    const mismatch = invoke(db, "files.list", {
      root: "notes:",
      extensions: ["md"],
      pageSize: 1,
      cursor: first.page.nextCursor,
    });
    expect(mismatch.code).toBe("query_mismatch");
    const otherThread = invoke(
      db,
      "files.list",
      {
        root: "notes:",
        extensions: ["txt"],
        pageSize: 1,
        cursor: first.page.nextCursor,
      },
      "thread-2",
    );
    expect(otherThread.code).toBe("session_mismatch");
  });

  it("expires a cursor and stops when the visit cap is hit", () => {
    const root = folder("verbo-cap-");
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "c.txt"), "c");
    const db = register(root);
    const store = createScopeStore(db);
    const now = 1_000;
    const first = listFiles(
      { database: db, store, actor: "model", threadId: "thread-1", now },
      { root: "notes:", pageSize: 1 },
    );
    const cursor = body(first).page.nextCursor;
    const expired = listFiles(
      {
        database: db,
        store,
        actor: "model",
        threadId: "thread-1",
        now: now + FILE_QUERY_LIMITS.snapshotTtlMs + 1,
      },
      { root: "notes:", pageSize: 1, cursor },
    );
    expect(expired.code).toBe("stale_cursor");

    const capped = listFiles(
      {
        database: db,
        store,
        actor: "model",
        threadId: "thread-1",
        limits: { maxVisited: 1 },
      },
      { root: "notes:", depth: 2, pageSize: 20 },
    );
    expect(capped.status).toBe("partial");
    expect(capped.code).toBe("limit_reached");
    expect(body(capped).scan.complete).toBe(false);
    expect(body(capped).page.totalKnown).toBeNull();
    expect(capped.totalItems).toBeUndefined();
    const cappedDetail = JSON.parse(capped.detail ?? "{}") as {
      counts: { files: { exactTotal: number | null } };
    };
    expect(cappedDetail.counts.files.exactTotal).toBeNull();
  });

  it("searches names and bounded text snippets", () => {
    const root = folder("verbo-search-");
    writeFileSync(join(root, "jaguar.md"), "alpha\nThe jaguar sleeps\nomega\n");
    writeFileSync(join(root, "other.txt"), "zebra");
    writeFileSync(join(root, "twice.md"), "jaguar one\njaguar two\n");
    const db = register(root);

    const named = body(
      invoke(db, "files.search", {
        root: "notes:",
        mode: "filename",
        query: "jaguar",
        depth: 1,
        pageSize: 10,
      }),
    );
    expect(named.items.map((item) => item.path)).toEqual(["notes:/jaguar.md"]);

    const content = body(
      invoke(db, "files.search", {
        root: "notes:",
        mode: "content",
        query: "jaguar",
        depth: 1,
        pageSize: 10,
        snippetChars: 40,
      }),
    );
    const paths = content.items.map((item) => item.path);
    expect(paths).toContain("notes:/jaguar.md");
    expect(paths).toContain("notes:/twice.md");
    expect(paths).not.toContain("notes:/other.txt");
    const jaguar = content.items.find(
      (item) => item.path === "notes:/jaguar.md",
    );
    expect(jaguar?.snippet).toContain("jaguar");
    expect(jaguar?.snippet).not.toContain("omega");
    expect(jaguar?.line).toBe(2);

    const matches = body(
      invoke(db, "files.search", {
        root: "notes:",
        mode: "content",
        query: "jaguar",
        extensions: ["md"],
        groupBy: "match",
        depth: 1,
        pageSize: 10,
      }),
    );
    const twice = matches.items.filter(
      (item) => item.path === "notes:/twice.md",
    );
    expect(twice.map((item) => item.line)).toEqual([1, 2]);
  });

  it("stats explicit paths, summarizes a finished folder, and blocks escapes", () => {
    const root = folder("verbo-stat-");
    const outside = folder("verbo-out-");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "note.md"), "hello");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "jump"), "junction");
    const db = register(root);

    const stat = invoke(db, "files.stat", {
      paths: ["notes:/note.md", "notes:/missing.md", "notes:/jump"],
    });
    expect(stat.status).toBe("partial");
    const stated = JSON.parse(stat.detail ?? "{}") as {
      items: Array<{ path: string; type: string; size: number | null }>;
      errors: Array<{ code: string }>;
    };
    expect(stated.items).toEqual([
      expect.objectContaining({
        path: "notes:/note.md",
        type: "file",
        size: 5,
      }),
    ]);
    expect(stated.errors.map((error) => error.code).sort()).toEqual([
      "missing",
      "outside",
    ]);
    expect(stat.detail).not.toContain("secret.txt");
    const listed = body(
      invoke(db, "files.list", { root: "notes:", depth: 2, pageSize: 20 }),
    );
    expect(
      listed.items.find((item) => item.path === "notes:/jump"),
    ).toMatchObject({
      type: "link",
    });
    expect(JSON.stringify(listed)).not.toContain("secret.txt");

    const summary = JSON.parse(
      invoke(db, "files.summary", { root: "notes:", depth: 1 }).detail ?? "{}",
    ) as {
      complete: boolean;
      files: number;
      directories: number;
      links: number;
      totalBytes: number | null;
    };
    expect(summary.complete).toBe(true);
    expect(summary.files).toBe(1);
    expect(summary.directories).toBe(1);
    expect(summary.links).toBe(1);
    expect(summary.totalBytes).toBe(5);

    const escaped = invoke(db, "files.list", {
      root: "notes:",
      path: "jump/secret.txt",
    });
    expect(escaped.status).toBe("error");
    expect(invoke(db, "files.list", { root: "C:\\Windows" }).code).toBe(
      "protected",
    );
  });

  it("lets the model read an existing unscoped folder and asks a command to select it", () => {
    const outside = folder("verbo-free-");
    writeFileSync(join(outside, "free.txt"), "x");
    const db = database();
    const model = invoke(db, "files.list", { root: outside, pageSize: 10 });
    expect(model.status).toBe("success");
    expect(model.detail).toContain("free.txt");
    const command = invoke(
      db,
      "files.list",
      { root: outside, pageSize: 10 },
      "thread-1",
      "user_command",
    );
    expect(command.code).toBe("needs_selection");
  });

  it("counts every direct child directory even when the page is smaller", () => {
    const root = folder("verbo-dirs-");
    for (let index = 0; index < 9; index += 1) {
      mkdirSync(join(root, `dir-${index}`));
    }
    writeFileSync(join(root, "note.txt"), "x");
    const db = register(root);
    const listed = invoke(db, "files.list", {
      root: "notes:",
      depth: 0,
      entryType: "directories",
      pageSize: 2,
    });
    const detail = JSON.parse(listed.detail ?? "{}") as {
      page: { returned: number; hasMore: boolean; totalKnown: number };
      counts: {
        directories: { observed: number; exactTotal: number | null };
        files: { observed: number; exactTotal: number | null };
      };
    };
    expect(detail.page.returned).toBe(2);
    expect(detail.page.hasMore).toBe(true);
    expect(detail.page.totalKnown).toBe(9);
    expect(detail.counts.directories).toEqual({ observed: 9, exactTotal: 9 });
    expect(detail.counts.files).toEqual({ observed: 0, exactTotal: 0 });
    expect(listed.totalItems).toBe(9);
  });
});
