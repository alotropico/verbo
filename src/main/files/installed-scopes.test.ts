import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { createScopeStore } from "../db/scopes";
import { ensureInstalledFileScopes } from "./installed-scopes";

const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "verbo-install-scopes-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "verbo.sqlite"));
  databases.push(db);
  migrateDatabase(db, VERBO_MIGRATIONS);
  return db;
}

describe("installed file scopes", () => {
  it("registers .tmp as the default and skips a missing local folder", () => {
    const project = mkdtempSync(join(tmpdir(), "verbo-project-"));
    directories.push(project);
    const vault = mkdtempSync(join(tmpdir(), "verbo-vault-"));
    directories.push(vault);
    writeFileSync(
      join(project, "installation-scopes.local.json"),
      JSON.stringify({
        scopes: [
          {
            alias: "vault",
            path: vault,
            read: true,
            write: true,
          },
          {
            alias: "missing",
            path: join(project, "does-not-exist"),
            read: true,
            write: true,
          },
        ],
      }),
    );
    const store = createScopeStore(database());
    ensureInstalledFileScopes(store, project);
    ensureInstalledFileScopes(store, project);
    const scopes = store.list();
    expect(scopes.map((scope) => scope.alias).sort()).toEqual(["tmp", "vault"]);
    expect(scopes.find((scope) => scope.alias === "tmp")).toMatchObject({
      path: join(project, ".tmp"),
      read: true,
      write: true,
      defaultSave: true,
    });
    expect(scopes.find((scope) => scope.alias === "vault")).toMatchObject({
      read: true,
      write: true,
      defaultSave: false,
    });
  });
});
