import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { createScopeStore } from "../db/scopes";
import { performFileSurface } from "./file-surface";

const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scope(root: string): ReturnType<typeof createScopeStore> {
  const directory = mkdtempSync(join(tmpdir(), "verbo-surface-db-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "verbo.sqlite"));
  databases.push(db);
  migrateDatabase(db, VERBO_MIGRATIONS);
  const store = createScopeStore(db);
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
  return store;
}

describe("file surface", () => {
  it("opens, reveals, and copies a file inside a scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "verbo-surface-"));
    directories.push(root);
    writeFileSync(join(root, "note.md"), "hello file");
    const store = scope(root);
    const opened: string[] = [];
    const revealed: string[] = [];
    const copied: string[] = [];
    const ports = {
      scopes: store.list(),
      grants: store.activeGrants(),
      openPath: async (absolute: string) => {
        opened.push(absolute);
        return "";
      },
      showItemInFolder: (absolute: string) => {
        revealed.push(absolute);
      },
      writeClipboard: (text: string) => {
        copied.push(text);
      },
    };
    expect(
      await performFileSurface({
        reference: "notes:/note.md",
        intent: "open",
        ...ports,
      }),
    ).toEqual({ ok: true });
    expect(
      await performFileSurface({
        reference: "notes:/note.md",
        intent: "reveal",
        ...ports,
      }),
    ).toEqual({ ok: true });
    expect(
      await performFileSurface({
        reference: "notes:/note.md",
        intent: "copy",
        ...ports,
      }),
    ).toEqual({ ok: true });
    expect(opened[0]).toBe(revealed[0]);
    expect(copied).toEqual(["hello file"]);
  });

  it("refuses paths outside a scope, folders, and binary files", async () => {
    const root = mkdtempSync(join(tmpdir(), "verbo-surface-"));
    directories.push(root);
    mkdirSync(join(root, "box"));
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01]));
    const store = scope(root);
    const ports = {
      scopes: store.list(),
      grants: store.activeGrants(),
      openPath: async () => "",
      showItemInFolder: () => undefined,
      writeClipboard: () => undefined,
    };
    expect(
      (
        await performFileSurface({
          reference: "other:/secret.txt",
          intent: "open",
          ...ports,
        })
      ).ok,
    ).toBe(false);
    expect(
      await performFileSurface({
        reference: "notes:/box",
        intent: "copy",
        ...ports,
      }),
    ).toMatchObject({ ok: false, code: "folder" });
    expect(
      await performFileSurface({
        reference: "notes:/bin.dat",
        intent: "copy",
        ...ports,
      }),
    ).toMatchObject({ ok: false, code: "binary" });
  });
});
