import { createRootStore } from "../db/registered-roots";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  readEntitySettings,
  removeApplicationRegistration,
  saveApplicationRegistration,
  saveProjectPreferences,
} from "../db/application-registration";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { saveProjectImportSettings } from "../db/project-import-settings";
import { createScopeStore } from "../db/scopes";
import { analyzeFolder, importFolderProjects, updateFolderSettings } from "./folder-import";

describe("folder classification and project imports", { timeout: 20_000 }, () => {
  it("merges independent autosave patches and keeps one writable default without re-importing removed projects", async () => {
    const root = mkdtempSync(join(tmpdir(), "verbo-folder-patches-"));
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, VERBO_MIGRATIONS);
      mkdirSync(join(root, "one"));
      mkdirSync(join(root, "two"));
      writeFileSync(join(root, "one", "AGENTS.md"), "instructions");
      const store = createScopeStore(database);
      expect(
        (
          await store.apply({
            removeIds: [],
            updates: [],
            additions: ["one", "two"].map((alias) => ({
              alias,
              path: join(root, alias),
              read: true,
              write: true,
              defaultSave: alias === "one",
              kind: "none",
            })),
          })
        ).ok,
      ).toBe(true);
      const first = (await store.list()).find((scope) => scope.alias === "one")!;
      const second = (await store.list()).find((scope) => scope.alias === "two")!;
      expect((await updateFolderSettings(database, { id: first.id, alias: "renamed" })).ok).toBe(true);
      expect((await updateFolderSettings(database, { id: first.id, kind: "projects" })).ok).toBe(true);
      expect((await store.list()).find((scope) => scope.id === first.id)).toMatchObject({
        alias: "renamed",
        write: true,
        kind: "projects",
      });
      const project = (await readEntitySettings(database)).projects[0];
      await createRootStore(database, "registered_projects", "project").remove(project.id);
      expect((await updateFolderSettings(database, { id: first.id, write: false })).ok).toBe(true);
      expect((await readEntitySettings(database)).projects).toEqual([]);
      expect((await store.list()).find((scope) => scope.id === first.id)?.defaultSave).toBe(false);
      expect((await updateFolderSettings(database, { id: second.id, defaultSave: true })).ok).toBe(true);
      expect((await store.list()).filter((scope) => scope.defaultSave).map((scope) => scope.id)).toEqual([second.id]);
      expect((await updateFolderSettings(database, { id: first.id, path: "C:/elsewhere" })).ok).toBe(false);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("detects a vault and first/second-level projects once without following junctions or third-level markers", () => {
    const root = mkdtempSync(join(tmpdir(), "verbo-folder-import-"));
    const outside = mkdtempSync(join(tmpdir(), "verbo-folder-outside-"));
    try {
      mkdirSync(join(root, "first", "second", "third"), { recursive: true });
      writeFileSync(join(root, "first", "package.json"), "{}");
      writeFileSync(join(root, "first", "AGENTS.md"), "instructions");
      writeFileSync(join(root, "first", "second", "AGENTS.md"), "instructions");
      writeFileSync(join(root, "first", "second", "third", "package.json"), "{}");
      writeFileSync(join(outside, "package.json"), "{}");
      symlinkSync(outside, join(root, "linked"), "junction");
      const found = analyzeFolder(root);
      expect(found.kind).toBe("projects");
      expect(found.complete).toBe(true);
      expect(found.projects).toHaveLength(2);
      expect(found.projects.every((path) => !path.includes("third") && !path.includes("outside"))).toBe(true);
      mkdirSync(join(root, ".obsidian"));
      expect(analyzeFolder(root).kind).toBe("obsidian");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("persists folder kinds and imports new favorites without resetting existing preferences or duplicating projects", async () => {
    const root = mkdtempSync(join(tmpdir(), "verbo-import-defaults-"));
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, VERBO_MIGRATIONS);
      mkdirSync(join(root, "alpha"));
      writeFileSync(join(root, "alpha", "package.json"), "{}");
      const scopes = createScopeStore(database);
      const registered = await scopes.apply({
        removeIds: [],
        updates: [],
        additions: [
          {
            alias: "work",
            path: root,
            read: true,
            write: false,
            defaultSave: false,
            kind: "projects",
          },
        ],
      });
      expect(registered.ok).toBe(true);
      expect((await scopes.list())[0].kind).toBe("projects");
      const first = await importFolderProjects(database, root);
      expect(first.imported).toBe(1);
      const original = (await readEntitySettings(database)).projects[0];
      expect(
        (
          await saveProjectPreferences(database, {
            id: original.id,
            name: "Keep this title",
            aliases: [],
            enabled: false,
            defaultApplicationId: null,
            favoriteApplicationIds: [],
          })
        ).ok,
      ).toBe(true);
      const binary = join(root, "editor.exe");
      const pe = Buffer.alloc(128);
      pe.writeUInt16LE(0x5a4d, 0);
      pe.writeUInt32LE(64, 0x3c);
      pe.writeUInt32LE(0x4550, 64);
      writeFileSync(binary, pe);
      expect(
        (
          await saveApplicationRegistration(database, {
            name: "Fixture editor",
            aliases: ["fixture"],
            executable: binary,
            enabled: true,
            supportedTargets: ["folder"],
            launchArguments: [{ target: "path" }],
            cwdPolicy: "project",
            supportedPlatforms: ["win32"],
          })
        ).ok,
      ).toBe(true);
      const appId = (await readEntitySettings(database)).applications[0].id;
      expect(
        (
          await saveProjectImportSettings(database, {
            enabled: true,
            applicationIds: [appId],
          })
        ).ok,
      ).toBe(true);
      mkdirSync(join(root, "beta"));
      writeFileSync(join(root, "beta", "AGENTS.md"), "instructions");
      expect(await importFolderProjects(database, root)).toMatchObject({
        imported: 1,
        existing: 1,
        complete: true,
      });
      const projects = (await readEntitySettings(database)).projects;
      expect(projects.find((project) => project.id === original.id)).toMatchObject({
        name: "Keep this title",
        enabled: false,
        favoriteApplicationIds: [],
      });
      expect(projects.find((project) => project.id !== original.id)?.favoriteApplicationIds).toEqual([appId]);
      expect((await importFolderProjects(database, root)).imported).toBe(0);
      expect((await readEntitySettings(database)).projects).toHaveLength(2);
      expect((await removeApplicationRegistration(database, appId)).ok).toBe(false);
      const beta = projects.find((project) => project.id !== original.id)!;
      expect(
        (
          await saveProjectPreferences(database, {
            id: beta.id,
            name: beta.name,
            aliases: [],
            enabled: beta.enabled,
            defaultApplicationId: null,
            favoriteApplicationIds: [],
          })
        ).ok,
      ).toBe(true);
      expect((await removeApplicationRegistration(database, appId)).ok).toBe(true);
      expect((await readEntitySettings(database)).projectImport?.applicationIds).toEqual([]);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
