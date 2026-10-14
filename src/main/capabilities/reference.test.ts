import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { registryForDatabase } from "./catalog";
import { dispatchModelTool } from "./registry";
import { executeLocalCommand } from "../runtime/local-command";
import { createMemoryStore } from "../db/memory";
import { createScopeStore } from "../db/scopes";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { readCommandReceipt } from "../db/command-receipts";
import { decideOperation } from "../files/mutation-plan";
import { operationSession } from "../files/mutation-ports";
import { createAssetStore } from "../files/asset-store";

describe("native command reference", () => {
  it("shares discovery, model/human validation, one native approval and durable resources", async () => {
    const directory = mkdtempSync(join(tmpdir(), "verbo-command-reference-"));
    const db = new DatabaseSync(":memory:");
    try {
      migrateDatabase(db, VERBO_MIGRATIONS);
      expect(
        createScopeStore(db).apply({
          removeIds: [],
          updates: [],
          additions: [
            {
              alias: "notes",
              path: directory,
              read: true,
              write: true,
              defaultSave: false,
            },
          ],
        }).ok,
      ).toBe(true);
      writeFileSync(join(directory, "before.md"), "verified text");
      writeFileSync(join(directory, "second.md"), "second text");
      const registry = registryForDatabase(db);
      const context = {
        actor: "model" as const,
        threadId: "reference-thread",
        turnId: "reference-turn",
      };
      expect(registry.describe(["fs.cat"]).entries[0].id).toBe("files.read");
      expect(
        registry
          .search("reader")
          .matches.some((match) => match.id === "files.read"),
      ).toBe(true);
      const read = await dispatchModelTool(
        registry,
        "actions.invoke",
        { name: "fs.cat", args: { path: "notes:/before.md" } },
        context,
      );
      expect(read.status).toBe("success");
      expect(read.resourceCount).toBe(1);
      expect(
        readCommandReceipt(db, read.receiptId!, context.threadId)?.resources[0]
          .path,
      ).toBe(join(directory, "before.md"));
      const local = await executeLocalCommand({
        text: '/action fs.retitle {"items":[{"from":"notes:/before.md","to":"notes:/after.md"},{"from":"notes:/second.md","to":"notes:/second-after.md"}]}',
        threadId: context.threadId,
        registry,
        store: createMemoryStore(db),
      });
      expect(local.receipt?.status).toBe("requires_confirmation");
      expect(readFileSync(join(directory, "before.md"), "utf8")).toBe(
        "verified text",
      );
      const operationId = local.receipt!.operationId!;
      const result = await decideOperation({
        database: db,
        scopes: createScopeStore(db),
        threadId: context.threadId,
        operationId,
        sessionId: operationSession(),
        decision: "approve",
      });
      expect(result.status).toBe("success");
      expect(result.receiptId).toBe(operationId);
      expect(readFileSync(join(directory, "after.md"), "utf8")).toBe(
        "verified text",
      );
      const stored = readCommandReceipt(db, operationId, context.threadId);
      expect(stored?.resources.map((resource) => resource.path)).toEqual([
        join(directory, "after.md"),
        join(directory, "second-after.md"),
      ]);
      expect(stored?.children).toHaveLength(2);
      const assets = createAssetStore(db, join(directory, "uploads"));
      expect(assets.liveReferences(context.threadId, operationId)).toEqual(
        stored?.resources,
      );
      expect(assets.liveReferences("other-thread", operationId)).toEqual([]);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM attachments").get()?.count,
      ).toBe(0);
      expect(readCommandReceipt(db, operationId, "other-thread")).toBe(null);
      const repeated = await decideOperation({
        database: db,
        scopes: createScopeStore(db),
        threadId: context.threadId,
        operationId,
        sessionId: operationSession(),
        decision: "approve",
      });
      expect(repeated.status).toBe("error");
      expect(
        readCommandReceipt(db, operationId, context.threadId)?.result.status,
      ).toBe("success");
      db.exec(
        `DELETE FROM operation_items; DELETE FROM operation_plans; DELETE FROM action_audit;`,
      );
      expect(
        readCommandReceipt(db, operationId, context.threadId)?.result.status,
      ).toBe("success");
      expect(
        readCommandReceipt(db, operationId, context.threadId)?.resources,
      ).toHaveLength(2);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
