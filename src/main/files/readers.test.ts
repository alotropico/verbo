import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionResult } from "../../shared/action-contract";
import { registryForDatabase } from "../capabilities/catalog";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { createMemoryStore } from "../db/memory";
import { createScopeStore } from "../db/scopes";
import { executeLocalCommand } from "../runtime/local-command";
import { readImageMeta } from "./image-meta";
import { extractPdfText } from "./pdf-text";
import { inspectImages } from "./readers";

const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "verbo-read-"));
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
  actor: "model" | "user_command" = "model",
): ActionResult {
  return registryForDatabase(db).invoke(name, args, {
    actor,
    threadId: "thread-1",
  });
}

function detail<T>(result: ActionResult): T {
  return JSON.parse(result.detail ?? "{}") as T;
}

function literalPdf(text: string): Buffer {
  const stream = `BT (${text}) Tj ET`;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >> endobj\n4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
    "latin1",
  );
}

function flatePdf(text: string): Buffer {
  const raw = Buffer.from(`BT (${text}) Tj ET`, "latin1");
  const compressed = deflateSync(raw);
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n4 0 obj << /Filter /FlateDecode /Length ${compressed.length} >> stream\n`,
      "latin1",
    ),
    compressed,
    Buffer.from("\nendstream endobj\n", "latin1"),
  ]);
}

describe("file readers", () => {
  it("reads text ranges, JSON pointers, and rejects binaries and escapes", () => {
    const root = folder("verbo-reader-");
    writeFileSync(join(root, "note.md"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(root, "data.json"), JSON.stringify({ a: { b: [1, 2] } }));
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const db = register(root);

    const lines = invoke(db, "files.read", {
      path: "notes:/note.md",
      startLine: 2,
      lineCount: 1,
    });
    expect(lines.status).toBe("success");
    expect(detail<{ text: string; next: { startLine: number } }>(lines).text).toBe(
      "beta",
    );
    expect(detail<{ next: { startLine: number } }>(lines).next.startLine).toBe(3);

    const pointed = invoke(db, "files.read", {
      path: "notes:/data.json",
      pointer: "/a/b/1",
    });
    expect(detail<{ text: string }>(pointed).text).toBe("2");
    expect(
      invoke(db, "files.read", { path: "notes:/data.json", pointer: "/missing" }).code,
    ).toBe("pointer_missing");
    expect(invoke(db, "files.read", { path: "notes:/blob.bin" }).status).toBe(
      "not_supported",
    );
    expect(invoke(db, "files.read", { path: "notes:/../secret.md" }).code).toBe(
      "invalid_reference",
    );
    expect(invoke(db, "files.read", { path: "C:\\Windows\\System32\\hosts" }).code).toBe(
      "protected",
    );
  });

  it("lets the model read an explicit outside file and keeps commands on a selection", () => {
    const root = folder("verbo-scope-");
    const outside = folder("verbo-outside-");
    writeFileSync(join(outside, "secret.txt"), "outside");
    const db = register(root);
    const path = join(outside, "secret.txt");
    expect(invoke(db, "files.read", { path, lineCount: 5 }).status).toBe("success");
    expect(invoke(db, "files.read", { path, lineCount: 5 }, "user_command").code).toBe(
      "needs_selection",
    );
  });

  it("extracts PDF text, reports image-only pages, and hashes explicit files", () => {
    const root = folder("verbo-pdf-");
    writeFileSync(join(root, "plain.pdf"), literalPdf("Hello PDF"));
    writeFileSync(join(root, "flate.pdf"), flatePdf("Hello Flate"));
    writeFileSync(
      join(root, "image.pdf"),
      Buffer.from(
        "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Resources << /XObject << /Im 4 0 R >> >> >> endobj\n4 0 obj << /Subtype /Image /Width 1 /Height 1 >> endobj\n",
        "latin1",
      ),
    );
    writeFileSync(join(root, "same.txt"), "hello\n");
    const db = register(root);

    const plain = extractPdfText(literalPdf("Hello PDF"), { page: 1, pageCount: 1 });
    expect(plain.ok && plain.pages[0]?.text).toBe("Hello PDF");
    const flate = invoke(db, "files.read", { path: "notes:/flate.pdf" });
    expect(flate.status).toBe("success");
    expect(JSON.stringify(detail(flate))).toContain("Hello Flate");
    const image = invoke(db, "files.read", { path: "notes:/image.pdf" });
    expect(image.code).toBe("image_only");

    const hashed = invoke(db, "files.hash", { paths: ["notes:/same.txt"] });
    expect(detail<{ items: Array<{ sha256: string }> }>(hashed).items[0]?.sha256).toBe(
      createHash("sha256").update("hello\n").digest("hex"),
    );
  });

  it("diffs text, caps image payloads without vision, and continues a page from a cursor", () => {
    const root = folder("verbo-diff-");
    writeFileSync(join(root, "a.md"), "one\ntwo\n");
    writeFileSync(join(root, "b.md"), "one\nthree\n");
    writeFileSync(join(root, "c.md"), "c");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(root, "dot.png"), png);
    expect(readImageMeta(png)).toEqual({ format: "png", width: 1, height: 1 });
    const db = register(root);

    const compared = invoke(db, "files.compare", {
      left: "notes:/a.md",
      right: "notes:/b.md",
    });
    expect(compared.detail).toContain("-two");
    expect(compared.detail).toContain("+three");
    expect(
      invoke(db, "files.compare", {
        left: "notes:/a.md",
        proposed: "one\ntwo\n",
      }).summary,
    ).toBe("Those texts match.");

    const metadata = invoke(db, "files.inspect_image", {
      paths: ["notes:/dot.png"],
      includePayload: true,
    });
    expect(metadata.code).toBe("vision_unavailable");
    expect(metadata.detail).not.toContain("dataUrl");
    const opened = registryForDatabase(db);
    const direct = inspectImages(
      {
        database: db,
        store: createScopeStore(db),
        actor: "model",
        threadId: "thread-1",
      },
      { paths: ["notes:/dot.png"], includePayload: true },
      { visionSupported: true },
    );
    expect(direct.detail).toContain("dataUrl");
    expect(opened.list("files").children.some((child) => child.id === "files.read")).toBe(
      true,
    );

    const listed = invoke(db, "files.list", {
      root: "notes:",
      depth: 0,
      entryType: "files",
      pageSize: 1,
      sort: { by: "name", direction: "asc" },
    });
    const cursor = detail<{ page: { nextCursor?: string } }>(listed).page.nextCursor ?? "";
    const next = invoke(db, "files.next", { cursor });
    expect(next.status).toBe("success");
    expect(detail<{ items: Array<{ path: string }> }>(next).items[0]?.path).not.toBe(
      detail<{ items: Array<{ path: string }> }>(listed).items[0]?.path,
    );

    const command = executeLocalCommand({
      text: "/files read notes:/a.md --lines 1:1",
      threadId: "thread-1",
      store: createMemoryStore(db),
      registry: opened,
    });
    expect(command.status).toBe("success");
    expect(command.summary).toContain("one");
    expect(
      executeLocalCommand({
        text: '/action files.hash {"paths":["notes:/a.md"],"approved":true}',
        threadId: "thread-1",
        store: createMemoryStore(db),
        registry: opened,
      }).status,
    ).toBe("error");
  });

  it("does not follow a junction", () => {
    const root = folder("verbo-link-");
    const outside = folder("verbo-link-out-");
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(outside, join(root, "jump"), "junction");
    const db = register(root);
    expect(invoke(db, "files.read", { path: "notes:/jump" }).code).toBe(
      "outside",
    );
    expect(
      invoke(db, "files.read", { path: "notes:/jump/secret.txt" }).detail ?? "",
    ).not.toContain("nope");
  });
});
