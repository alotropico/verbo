import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { actionResultSchema } from "../../shared/action-contract";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { createOperationStore } from "../db/operations";
import {
  persistCommandReceipt,
  readCommandReceipt,
} from "../db/command-receipts";
import { operationSession } from "../files/mutation-ports";
import { createModuleRegistry, type CommandDefinition } from "./modules";
import { createPreparationOwner, decidePreparedOperation } from "./preparation";

const context = {
  actor: "model" as const,
  threadId: "prepared-thread",
  turnId: "prepared-turn",
};
function fixture(): {
  db: DatabaseSync;
  registry: ReturnType<typeof createModuleRegistry>;
  effects: string[];
  change: () => void;
} {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db, VERBO_MIGRATIONS);
  const effects: string[] = [];
  let revision = 1;
  const base = {
    aliases: [],
    tags: [],
    parameterHelp: {},
    output: actionResultSchema,
    messages: { failure: "Operation failed" },
    attachments: "none" as const,
    configurable: ["aliases"] as const,
    description: "Fixture command",
  };
  const commands: CommandDefinition[] = [
    {
      ...base,
      id: "fixture.resolve",
      kind: "read",
      approval: "none",
      args: z.object({}).strict(),
      example: {},
      execution: { type: "handler", handler: "resolve" },
    },
    {
      ...base,
      id: "fixture.launch",
      kind: "mutation",
      approval: "required",
      args: z.object({ target: z.string() }).strict(),
      example: { target: "one" },
      execution: { type: "handler", handler: "launch" },
      preparation: "launch",
    },
    {
      ...base,
      id: "fixture.open",
      kind: "mutation",
      approval: "required",
      args: z.object({}).strict(),
      example: {},
      prepareChildren: true,
      execution: {
        type: "composite",
        onFailure: "stop",
        aggregate: "collect",
        steps: [
          { id: "resolve", command: "fixture.resolve", args: {} },
          {
            id: "launch",
            command: "fixture.launch",
            forEach: {
              from: "step",
              step: "resolve",
              path: ["data", "targets"],
            },
            args: { target: { from: "item", path: [] } },
          },
        ],
      },
    },
  ];
  const registry = createModuleRegistry(
    [
      {
        id: "fixture",
        aliases: [],
        description: "Fixture",
        version: 1,
        scopes: [],
        commands,
      },
    ],
    {
      handlers: {
        resolve: () => ({
          action: "fixture.resolve",
          status: "success",
          summary: "Resolved.",
          data: { targets: ["one", "two", "three"] },
        }),
        launch: (args) => {
          effects.push(String(args.target));
          return {
            action: "fixture.launch",
            status:
              args.target === "two" && revision === 9 ? "error" : "success",
            summary: `Launched ${args.target}.`,
          };
        },
      },
      processes: {},
      preparers: {
        launch: (args) => ({
          snapshot: { revision, target: String(args.target) },
          summary: `Launch ${args.target}.`,
          automatic: true,
        }),
      },
      aggregators: {
        collect: (action, children) => ({
          action,
          status: "success",
          summary: children.map((child) => child.summary).join(" "),
        }),
      },
    },
    {
      preparation: createPreparationOwner(db),
      finalize: (input) => persistCommandReceipt(db, input),
    },
  );
  return {
    db,
    registry,
    effects,
    change: () => {
      revision += 1;
    },
  };
}

describe("persisted command preparation", () => {
  it("materializes one review, executes registered children once and retains their receipts", async () => {
    const f = fixture();
    try {
      const pending = await f.registry.invoke("fixture.open", {}, context);
      expect(pending.status).toBe("requires_confirmation");
      expect(f.effects).toEqual([]);
      expect(
        createOperationStore(f.db).items(pending.operationId!),
      ).toHaveLength(3);
      const decision = {
        database: f.db,
        registry: f.registry,
        operationId: pending.operationId!,
        threadId: context.threadId,
        sessionId: operationSession(),
        decision: "approve" as const,
      };
      const completed = await decidePreparedOperation(decision);
      expect(completed.status).toBe("success");
      expect(f.effects).toEqual(["one", "two", "three"]);
      const children = f.db
        .prepare(
          "SELECT action_id FROM command_receipts WHERE parent_receipt_id = ?",
        )
        .all(pending.operationId!);
      expect(children.map((child) => child.action_id)).toEqual([
        "fixture.resolve",
        "fixture.launch",
        "fixture.launch",
        "fixture.launch",
      ]);
      expect((await decidePreparedOperation(decision)).code).toBe("replayed");
      expect(f.effects).toHaveLength(3);
      expect(
        readCommandReceipt(f.db, pending.receiptId!, context.threadId),
      ).not.toBeNull();
    } finally {
      f.db.close();
    }
  });
  it("rejects changed targets, forged approval args and a different thread with zero effects", async () => {
    const f = fixture();
    try {
      expect(
        (
          await f.registry.invoke(
            "fixture.launch",
            { target: "one", approved: true },
            context,
          )
        ).code,
      ).toBe("invalid_args");
      const pending = await f.registry.invoke("fixture.open", {}, context);
      const decision = {
        database: f.db,
        registry: f.registry,
        operationId: pending.operationId!,
        threadId: context.threadId,
        sessionId: operationSession(),
        decision: "approve" as const,
      };
      expect(
        (await decidePreparedOperation({ ...decision, threadId: "another" }))
          .code,
      ).toBe("wrong_thread");
      f.change();
      expect((await decidePreparedOperation(decision)).code).toBe(
        "stale_target",
      );
      expect(f.effects).toEqual([]);
    } finally {
      f.db.close();
    }
  });
  it("denial, expiry, cancellation and content tampering never execute", async () => {
    for (const mode of ["deny", "expired", "cancelled", "tampered"] as const) {
      const f = fixture();
      try {
        const pending = await f.registry.invoke("fixture.open", {}, context);
        const id = pending.operationId!;
        if (mode === "expired")
          f.db
            .prepare("UPDATE operation_plans SET expires_at=0 WHERE id=?")
            .run(id);
        if (mode === "cancelled") createOperationStore(f.db).requestCancel(id);
        if (mode === "tampered")
          f.db
            .prepare(
              "UPDATE operation_items SET content='{}' WHERE operation_id=?",
            )
            .run(id);
        const result = await decidePreparedOperation({
          database: f.db,
          registry: f.registry,
          operationId: id,
          threadId: context.threadId,
          sessionId: operationSession(),
          decision: mode === "deny" ? "deny" : "approve",
        });
        expect(result.code).toBe(
          mode === "tampered"
            ? "stale_plan"
            : mode === "deny"
              ? "denied"
              : mode,
        );
        expect(f.effects).toEqual([]);
      } finally {
        f.db.close();
      }
    }
  });
  it("trusted human selection can execute immediately but model selection always waits", async () => {
    const f = fixture();
    try {
      const model = await f.registry.invoke(
        "fixture.launch",
        { target: "one" },
        context,
      );
      expect(model.status).toBe("requires_confirmation");
      const human = await f.registry.invoke(
        "fixture.launch",
        { target: "three" },
        { ...context, actor: "user_command" },
      );
      expect(human.status).toBe("success");
      expect(f.effects).toEqual(["three"]);
    } finally {
      f.db.close();
    }
  });
  it("stops after the first failed effect and reports earlier successes without replay", async () => {
    const f = fixture();
    try {
      for (let index = 0; index < 8; index += 1) f.change();
      const pending = await f.registry.invoke("fixture.open", {}, context);
      const decision = {
        database: f.db,
        registry: f.registry,
        operationId: pending.operationId!,
        threadId: context.threadId,
        sessionId: operationSession(),
        decision: "approve" as const,
      };
      const result = await decidePreparedOperation(decision);
      expect(result.status).toBe("partial");
      expect(result.data).toMatchObject({
        succeeded: 1,
        failed: 1,
        notAttempted: 1,
      });
      expect(f.effects).toEqual(["one", "two"]);
      expect(
        createOperationStore(f.db)
          .items(pending.operationId!)
          .map((item) => item.status),
      ).toEqual(["succeeded", "failed", "not_attempted"]);
      expect((await decidePreparedOperation(decision)).code).toBe("replayed");
    } finally {
      f.db.close();
    }
  });
  it("concurrent decisions cannot duplicate a launch, and cancellation between children stops the next effect", async () => {
    const f = fixture();
    try {
      const pending = await f.registry.invoke("fixture.open", {}, context);
      const decision = {
        database: f.db,
        registry: f.registry,
        operationId: pending.operationId!,
        threadId: context.threadId,
        sessionId: operationSession(),
        decision: "approve" as const,
      };
      const results = await Promise.all([
        decidePreparedOperation(decision),
        decidePreparedOperation(decision),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "error",
        "success",
      ]);
      expect(f.effects).toEqual(["one", "two", "three"]);
      const next = await f.registry.invoke("fixture.open", {}, context);
      const controller = new AbortController();
      const invocation = decidePreparedOperation({
        ...decision,
        operationId: next.operationId!,
        signal: controller.signal,
      });
      setImmediate(() => controller.abort());
      const cancelled = await invocation;
      expect(cancelled.status).toBe("partial");
      expect(f.effects).toEqual(["one", "two", "three", "one"]);
      expect(cancelled.data).toMatchObject({ succeeded: 1, notAttempted: 2 });
    } finally {
      f.db.close();
    }
  });
});
