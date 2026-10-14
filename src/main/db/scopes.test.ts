import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { displayFinalPath } from "../../shared/files";
import { dispatchModelTool } from "../capabilities/registry";
import { registryForDatabase } from "../capabilities/catalog";
import { migrateDatabase, VERBO_MIGRATIONS } from "./migrate";
import { createScopeStore } from "./scopes";
import { resolveFileReference } from "../files/path-policy";

const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "verbo-scopes-"));
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

describe("file scopes and path policy", () => {
  it("registers a picked folder and resolves an alias inside it", () => {
    const root = folder("verbo-notes-");
    writeFileSync(join(root, "idea.md"), "idea");
    const store = createScopeStore(database());
    const saved = store.apply({
      removeIds: [],
      updates: [],
      additions: [
        {
          alias: "Notes",
          path: root,
          read: true,
          write: true,
          defaultSave: true,
        },
      ],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.scopes[0]?.alias).toBe("notes");
    expect(saved.scopes[0]?.aliases).toEqual(["notes"]);
    expect(store.generation()).toBe(2);

    const resolved = resolveFileReference({
      reference: "notes:/idea.md",
      purpose: "read",
      actor: "model",
      scopes: saved.scopes,
      grants: [],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.path.display).toBe("notes:/idea.md");
    expect(resolved.path.write).toBe(true);
    const bare = resolveFileReference({
      reference: "idea.md",
      purpose: "read",
      actor: "model",
      scopes: saved.scopes,
      grants: [],
    });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.path.display).toBe("notes:/idea.md");
    expect(
      resolveFileReference({
        reference: "../secret.txt",
        purpose: "write",
        actor: "model",
        scopes: saved.scopes,
        grants: [],
      }),
    ).toMatchObject({ ok: false, code: "invalid_reference" });
  });

  it("resolves every comma-separated alias for one folder", () => {
    const root = folder("verbo-alias-list-");
    writeFileSync(join(root, "idea.md"), "idea");
    const store = createScopeStore(database());
    const saved = store.apply({
      removeIds: [],
      updates: [],
      additions: [
        {
          alias: "Notes, Docs",
          path: root,
          read: true,
          write: true,
          defaultSave: false,
        },
      ],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.scopes[0]?.aliases).toEqual(["notes", "docs"]);
    const resolved = resolveFileReference({
      reference: "docs:/idea.md",
      purpose: "read",
      actor: "model",
      scopes: saved.scopes,
      grants: [],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.path.display).toBe("docs:/idea.md");
  });

  it("lists a registered folder alias", async () => {
    const root = folder("verbo-notes-list-");
    const detail = await dispatchModelTool(
      registryForDatabase(database()),
      "actions.invoke",
      { name: "files.scopes", args: {} },
      { actor: "model", threadId: "thread-1" },
    );
    expect(detail.summary).toContain("No folders");
    const listed = await dispatchModelTool(
      registryForDatabase(
        (() => {
          const db = database();
          createScopeStore(db).apply({
            removeIds: [],
            updates: [],
            additions: [
              {
                alias: "notes",
                path: root,
                read: true,
                write: false,
                defaultSave: false,
              },
            ],
          });
          return db;
        })(),
      ),
      "actions.invoke",
      { name: "files.scopes", args: {} },
      { actor: "model", threadId: "thread-1" },
    );
    expect(listed.detail).toContain("notes:");
    expect(listed.detail).not.toContain(displayFinalPath(root));
  });

  it("rejects traversal, scope-root writes, protected paths, and link escapes", () => {
    const root = folder("verbo-root-");
    const outside = folder("verbo-out-");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "jump"), "junction");
    const store = createScopeStore(database());
    const saved = store.apply({
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
    if (!saved.ok) return;
    const scopes = saved.scopes;
    expect(
      resolveFileReference({
        reference: "notes:/nested/../../secret.txt",
        purpose: "read",
        actor: "model",
        scopes,
        grants: [],
      }).ok,
    ).toBe(false);
    expect(
      resolveFileReference({
        reference: "notes:/jump/secret.txt",
        purpose: "read",
        actor: "model",
        scopes,
        grants: [],
      }),
    ).toMatchObject({ ok: false, code: "outside" });
    expect(
      resolveFileReference({
        reference: "notes:/",
        purpose: "write",
        actor: "model",
        scopes,
        grants: [],
      }),
    ).toMatchObject({ ok: false, code: "root" });
    expect(
      resolveFileReference({
        reference: "C:\\Windows",
        purpose: "read",
        actor: "model",
        scopes,
        grants: [],
      }),
    ).toMatchObject({ ok: false, code: "protected" });
    expect(
      store.apply({
        removeIds: [],
        updates: [],
        additions: [
          {
            alias: "system",
            path: "C:\\Windows",
            read: true,
            write: false,
            defaultSave: false,
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "protected" });
  });

  it("keeps a file grant on that file and refuses a model-issued grant", () => {
    const root = folder("verbo-grant-");
    const chosen = join(root, "chosen.txt");
    const sibling = join(root, "other.txt");
    writeFileSync(chosen, "chosen");
    writeFileSync(sibling, "other");
    const store = createScopeStore(database());
    expect(
      store.issueReadGrant({ actor: "model", kind: "file", path: chosen }).ok,
    ).toBe(false);
    const grant = store.issueReadGrant({
      actor: "ui",
      kind: "file",
      path: chosen,
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    const allowed = resolveFileReference({
      reference: chosen,
      purpose: "read",
      actor: "model",
      scopes: [],
      grants: store.activeGrants(),
    });
    expect(allowed).toMatchObject({ ok: true });
    expect(
      resolveFileReference({
        reference: sibling,
        purpose: "read",
        actor: "model",
        scopes: [],
        grants: [],
      }),
    ).toMatchObject({ ok: true, path: { read: true, write: false } });
    expect(
      resolveFileReference({
        reference: sibling,
        purpose: "write",
        actor: "model",
        scopes: [],
        grants: [],
      }),
    ).toMatchObject({ ok: false, code: "outside_scope" });
    expect(
      resolveFileReference({
        reference: "C:\\Windows",
        purpose: "read",
        actor: "model",
        scopes: [],
        grants: [],
      }),
    ).toMatchObject({ ok: false, code: "protected" });
    expect(
      resolveFileReference({
        reference: sibling,
        purpose: "read",
        actor: "ui",
        scopes: [],
        grants: [],
      }),
    ).toMatchObject({ ok: false, code: "needs_selection" });
    expect(
      resolveFileReference({
        reference: chosen,
        purpose: "write",
        actor: "ui",
        scopes: [],
        grants: store.activeGrants(),
      }),
    ).toMatchObject({ ok: false, code: "outside_scope" });
  });
});
