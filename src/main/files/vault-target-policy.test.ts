import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createScopeStore } from "../db/scopes";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import { registryForDatabase } from "../capabilities/catalog";
import {
  classifyVaultTarget,
  guardNativeVaultTargets,
} from "./vault-target-policy";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(): {
  root: string;
  vault: string;
  database: DatabaseSync;
  scopes: ReturnType<typeof createScopeStore>;
} {
  const root = mkdtempSync(
    join(process.cwd(), ".tmp", "scratch", "2026-10-15-vault-policy-"),
  );
  directories.push(root);
  const vault = join(root, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, VERBO_MIGRATIONS);
  const scopes = createScopeStore(database);
  const saved = scopes.apply({
    removeIds: [],
    updates: [],
    additions: [
      {
        alias: "parent",
        path: root,
        read: true,
        write: true,
        defaultSave: true,
      },
      {
        alias: "garden",
        path: vault,
        read: true,
        write: true,
        defaultSave: false,
        kind: "obsidian",
      },
    ],
  });
  expect(saved.ok).toBe(true);
  return { root, vault, database, scopes };
}
describe("canonical vault mutation boundaries", () => {
  it("classifies missing leaves, both endpoints and ancestor directory operations across all roots", () => {
    const { root, vault, scopes, database } = fixture();
    expect(
      classifyVaultTarget({
        path: join(vault, "missing", "note.md"),
        scopes: scopes.list(),
      }),
    ).toMatchObject([{ relation: "inside", relativePath: "missing/note.md" }]);
    expect(
      guardNativeVaultTargets({
        scopes: scopes.list(),
        targets: [{ path: root, purpose: "write", tree: true }],
      }),
    ).toMatchObject({ ok: false, code: "vault_backend_required" });
    expect(
      guardNativeVaultTargets({
        scopes: scopes.list(),
        targets: [{ path: join(root, "ordinary.md"), purpose: "write" }],
      }),
    ).toEqual({ ok: true });
    expect(
      guardNativeVaultTargets({
        scopes: scopes.list(),
        targets: [
          { path: join(root, "ordinary.md"), purpose: "read" },
          { path: join(vault, "new.md"), purpose: "write" },
        ],
      }),
    ).toMatchObject({ ok: false });
    database.close();
  });
  it.each(["garden:/new.md", "parent:/vault/new.md", "absolute"])(
    "blocks native writes through %s without touching the vault",
    async (reference) => {
      const { vault, database } = fixture();
      const result = await registryForDatabase(database).invoke(
        "files.create",
        {
          path: reference === "absolute" ? join(vault, "new.md") : reference,
          kind: "file",
          content: "Must not write",
        },
        { actor: "user_command", threadId: "thread" },
      );
      expect(result.code).toBe("vault_backend_required");
      expect(existsSync(join(vault, "new.md"))).toBe(false);
      database.close();
    },
  );
  it("honors a read-only nested vault independently of broader write aliases", async () => {
    const { database, scopes, vault } = fixture();
    const selected = scopes.list().find((scope) => scope.kind === "obsidian")!;
    scopes.apply({
      removeIds: [],
      additions: [],
      updates: [{ ...selected, write: false }],
    });
    writeFileSync(join(vault, "note.md"), "Original fixture data");
    const result = await registryForDatabase(database).invoke(
      "files.edit",
      { path: "parent:/vault/note.md", content: "No", mode: "full" },
      { actor: "user_command", threadId: "thread" },
    );
    expect(result.code).toBe("vault_permission_denied");
    database.close();
  });
});
