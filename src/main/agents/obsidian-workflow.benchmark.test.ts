import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import type { ChatEvent } from "../../shared/chat-ipc";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import {
  obsidianCreateSchema,
  obsidianDeleteSchema,
  obsidianEditSchema,
  obsidianTargetSchema,
  obsidianTransferSchema,
} from "../../shared/obsidian";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import { persistCommandReceipt } from "../test-support/receipts";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import { createScopeStore } from "../db/scopes";
import { createWorkflowExecutionStore } from "../db/workflow-executions";
import { createAssetStore } from "../files/asset-store";
import { createTurnController } from "../runtime/controller";
import { createRequestGate } from "../runtime/request-gate";
import { createTurnDispatcher } from "../runtime/turn-dispatcher";
import { runWorkflowTurn } from "../runtime/workflow-runner";
import { createRegistry, type Capability } from "../test-support/registry";

it.skipIf(process.env.VERBO_QWEN_OBSIDIAN_BENCHMARK !== "1")(
  "measures all five real-Qwen Obsidian compositions with CLI effects disabled",
  async () => {
    const root = mkdtempSync(
      join(
        process.cwd(),
        ".tmp",
        "scratch",
        `${new Date().toISOString().slice(0, 10)}-qwen-obsidian-`,
      ),
    );
    const vault = join(root, "Fixture Garden");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    let settings = DEFAULT_CHAT_SETTINGS;
    try {
      settings = chatSettingsSchema.parse(
        JSON.parse(
          readFileSync(
            join(process.env.APPDATA ?? "", "verbo", "settings.json"),
            "utf8",
          ),
        ),
      );
    } catch {
      /* Installed configured default. */
    }
    const record = {
      settings,
      root,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      effects: "disabled; fixture-only registry, no production handlers or CLI",
      cases: [] as unknown[],
    };
    const save = (): void =>
      writeFileSync(
        join(root, "results.json"),
        JSON.stringify(record, null, 2),
      );
    const gate = createRequestGate();
    for (const [operation, request] of [
      [
        "write",
        "Create a new Obsidian note garden:/Inbox/New.md about local AI. Compose its body and save it.",
      ],
      [
        "edit",
        "Rewrite the introduction of Obsidian note garden:/Inbox/Exact.md to be more concise. Preserve its identity.",
      ],
      [
        "move",
        "Move Obsidian note garden:/Inbox/Exact.md to Archive/Exact.md.",
      ],
      [
        "rename",
        "Rename Obsidian note garden:/Inbox/Exact.md to Thought.md in the same folder.",
      ],
      ["delete", "Delete Obsidian note garden:/Inbox/Exact.md."],
    ]) {
      if (
        process.env.VERBO_QWEN_OBSIDIAN_CASES &&
        !process.env.VERBO_QWEN_OBSIDIAN_CASES.split(",").includes(operation!)
      )
        continue;
      const database = new DatabaseSync(join(root, `${operation}.sqlite`));
      migrateDatabase(database, VERBO_MIGRATIONS);
      const threadId = randomUUID();
      database
        .prepare(
          "INSERT INTO threads(id,title,created_at,updated_at) VALUES(?,?,1,1)",
        )
        .run(threadId, "Fixture");
      const scopes = createScopeStore(database);
      const added = scopes.apply({
        removeIds: [],
        updates: [],
        additions: [
          {
            alias: "garden",
            path: vault,
            kind: "obsidian",
            read: true,
            write: true,
            defaultSave: false,
          },
        ],
      });
      if (!added.ok) throw new Error(added.summary);
      const assets = createAssetStore(
        database,
        join(root, `${operation}-assets`),
      );
      const body = assets.put({
        threadId,
        name: "original.md",
        mediaType: "text/markdown",
        bytes: Buffer.from(
          "# Exact\nA long introduction to the original fixture note about reliable local workflows.\n",
        ),
      });
      if (!body.ok) throw new Error(body.summary);
      const dispatches: string[] = [];
      const schemas = {
        read: obsidianTargetSchema,
        create: obsidianCreateSchema,
        edit: obsidianEditSchema,
        move: obsidianTransferSchema,
        rename: obsidianTransferSchema,
        delete: obsidianDeleteSchema,
      };
      const capabilities = Object.entries(schemas).map(
        ([name, args]): Capability => ({
          id: `obsidian.${name}`,
          description: `${name} an exact Obsidian fixture note. Effects are disabled for this evaluation.`,
          kind: name === "read" ? "read" : "mutation",
          approval: "none",
          args,
          example:
            name === "create"
              ? { vault: "garden", path: "Inbox/New.md", content: "Body" }
              : name === "edit"
                ? {
                    vault: "garden",
                    path: "Inbox/Exact.md",
                    revision: "a".repeat(64),
                    content: "Body",
                  }
                : ["move", "rename"].includes(name)
                  ? {
                      vault: "garden",
                      path: "Inbox/Exact.md",
                      to: "Archive/Exact.md",
                    }
                  : { vault: "garden", path: "Inbox/Exact.md" },
          execute: () => {
            dispatches.push(name);
            return name === "read"
              ? {
                  action: "obsidian.read",
                  status: "success",
                  summary: "Read the exact fixture note.",
                  data: {
                    contentRef: body.attachment.id,
                    path: "Inbox/Exact.md",
                    revision: "a".repeat(64),
                  },
                }
              : {
                  action: `obsidian.${name}`,
                  status: "not_supported",
                  code: "fixture_effects_disabled",
                  summary: `The ${name} CLI effect is disabled in this fixture. Nothing was changed.`,
                };
          },
        }),
      );
      const registry = createRegistry(capabilities, {
        finalize: (value) => persistCommandReceipt(database, value),
      });
      const dispatcher = createTurnDispatcher(database);
      const controller = createTurnController({
        database,
        dispatcher,
        retryDelays: [],
        work: (input) =>
          runWorkflowTurn({
            ...input,
            database,
            settings,
            assets,
            registry,
            gate,
            inventory: {
              folders: [
                {
                  id: scopes.list()[0]!.id,
                  aliases: ["garden"],
                  kind: "obsidian",
                  description: "Explicit isolated Obsidian fixture vault",
                  read: true,
                  write: true,
                  defaultSave: false,
                  available: true,
                  directories: ["Inbox", "Archive"],
                  truncated: false,
                },
              ],
              generation: scopes.generation(),
              refreshedAt: Date.now(),
              truncated: false,
            },
            awaitDecision: undefined,
          }),
      });
      const start = performance.now();
      const toolEvents: ChatEvent[] = [];
      try {
        await controller.admitTurn(
          {
            threadId,
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
            source: "typed",
            admission: "immediate",
            text: request,
            attachmentIds: [],
          },
          (event) => {
            if (
              ["tools", "tool_result"].includes(event.type) &&
              toolEvents.length < 100
            )
              toolEvents.push(event);
          },
        ).completion;
        const execution =
          createWorkflowExecutionStore(database).list(threadId)[0];
        record.cases.push({
          operation,
          request,
          latencyMs: performance.now() - start,
          workflow: execution?.workflowId,
          status: execution?.status,
          localDecision: execution?.checkpoint.outputs.operation,
          steps: Object.keys(execution?.checkpoint.outputs ?? {}),
          dispatches,
          outcome: execution?.outcome,
          effects: 0,
          toolEvents,
        });
      } catch (error) {
        record.cases.push({
          operation,
          error: String(error),
          dispatches,
          effects: 0,
          latencyMs: performance.now() - start,
        });
      }
      database.close();
      save();
    }
    record.finishedAt = new Date().toISOString();
    save();
  },
  1_200_000,
);
