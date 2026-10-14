import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { MutationSubmit } from "./mutation-plan";
import {
  consumePreparedFileChild,
  dispatchPreparedFileChild,
} from "./prepared-file-child";
import { createScopeStore } from "../db/scopes";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";

describe("private prepared file authorization", () => {
  it("binds exact args, actor, turn and database and consumes a child once", async () => {
    const database = new DatabaseSync(":memory:");
    const other = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, VERBO_MIGRATIONS);
      const input: MutationSubmit = {
        database,
        scopes: createScopeStore(database),
        actor: "model",
        threadId: "thread",
        turnId: "turn",
        action: "files.create",
        args: { path: "tmp:/approved.md", kind: "file", content: "approved" },
      };
      let effects = 0;
      const grant = {
        ...input,
        execute: () => {
          effects++;
          return {
            action: input.action,
            status: "success" as const,
            summary: "Executed",
          };
        },
      };
      expect(consumePreparedFileChild(input)).toBeUndefined();
      for (const altered of [
        { ...input, database: other },
        { ...input, threadId: "other" },
        { ...input, turnId: "other" },
        { ...input, actor: "ui" as const },
        { ...input, args: { ...input.args, content: "changed" } },
      ]) {
        expect(
          await dispatchPreparedFileChild(grant, async () =>
            consumePreparedFileChild(altered)!,
          ),
        ).toMatchObject({ status: "error", code: "invalid_grant" });
      }
      expect(effects).toBe(0);
      await dispatchPreparedFileChild(grant, async () => {
        expect(consumePreparedFileChild(input)?.status).toBe("success");
        expect(consumePreparedFileChild(input)?.code).toBe("invalid_grant");
        return { action: input.action, status: "success", summary: "Checked" };
      });
      expect(effects).toBe(1);
      expect(consumePreparedFileChild(input)).toBeUndefined();
    } finally {
      database.close();
      other.close();
    }
  });
});
