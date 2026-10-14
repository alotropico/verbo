import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateDatabase, VERBO_MIGRATIONS } from "./migrate";
import { registryForDatabase } from "../capabilities/catalog";
import {
  effectiveCommandNodes,
  resetCommandOverrides,
  saveCommandOverride,
} from "./command-overrides";

describe("safe command configuration", () => {
  it("compiles before committing, preserves IDs and recovers corrupt fields independently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateDatabase(db, VERBO_MIGRATIONS);
      const defaults = registryForDatabase(db, true).nodes();
      expect(
        defaults
          .filter((node) => node.id.includes("."))
          .every((node) => node.aliases.length >= 2),
      ).toBe(true);
      expect(
        saveCommandOverride(db, defaults, {
          nodeId: "files.rename",
          version: 1,
          aliases: ["title", "retitle"],
        }),
      ).toEqual({ ok: true });
      expect(registryForDatabase(db).resolve("fs.title")).toEqual({
        ok: true,
        id: "files.rename",
      });
      expect(
        saveCommandOverride(db, defaults, {
          nodeId: "files.read",
          version: 1,
          aliases: ["title"],
        }).ok,
      ).toBe(false);
      expect(registryForDatabase(db).resolve("fs.cat")).toEqual({
        ok: true,
        id: "files.read",
      });
      expect(
        saveCommandOverride(db, defaults, {
          nodeId: "files.read",
          version: 1,
          aliases: ["cat"],
          approval: "none",
        }).ok,
      ).toBe(false);
      db.prepare(`INSERT INTO command_overrides VALUES (?, 1, ?, 0)`).run(
        "files.read",
        '{"nodeId":"files.read","version":1,"aliases":["/unsafe"]}',
      );
      const effective = effectiveCommandNodes(db, defaults);
      expect(
        effective.find((node) => node.id === "files.read")?.aliases,
      ).toEqual(["open", "cat", "show"]);
      expect(
        effective.find((node) => node.id === "files.rename")?.aliases,
      ).toEqual(["title", "retitle"]);
      resetCommandOverrides(db, "files");
      expect(effectiveCommandNodes(db, defaults)).toEqual(defaults);
    } finally {
      db.close();
    }
  });
});
