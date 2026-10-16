import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { z } from "zod";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import { createRegistry } from "../capabilities/registry";
import { persistCommandReceipt } from "../db/command-receipts";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import { loadThreadHistory } from "../db/history";
import { createScopeStore } from "../db/scopes";
import { createWorkflowExecutionStore } from "../db/workflow-executions";
import { createAssetStore } from "../files/asset-store";
import { recordFileResource } from "../files/resource-events";
import { createTurnController } from "../runtime/controller";
import { createRequestGate } from "../runtime/request-gate";
import { createTurnDispatcher } from "../runtime/turn-dispatcher";
import { runWorkflowTurn } from "../runtime/workflow-runner";
import { resolveCTS } from "./cts";
import { constrainedDecision, localDecisionSchema } from "./decision";
import { createTurnBudget, invokeAgent } from "./invoke";
import { OBSIDIAN_OPERATION_INSTRUCTIONS } from "../workflows/definitions/obsidian";

it.skipIf(process.env.VERBO_QWEN_WORKFLOW_BENCHMARK !== "1")(
  "evaluates real local decisions and composed workflows with isolated fixture effects",
  async () => {
    let configured = DEFAULT_CHAT_SETTINGS;
    try {
      configured = chatSettingsSchema.parse(
        JSON.parse(
          readFileSync(
            join(process.env.APPDATA ?? "", "verbo", "settings.json"),
            "utf8",
          ),
        ),
      );
    } catch {
      /* Use installed configured default. */
    }
    const directory = mkdtempSync(
      join(
        process.cwd(),
        ".tmp",
        "scratch",
        `${new Date().toISOString().slice(0, 10)}-qwen-workflows-`,
      ),
    );
    const file = join(directory, "results.json");
    const record = {
      configured,
      directory,
      startedAt: new Date().toISOString(),
      local: [] as unknown[],
      workflows: [] as unknown[],
      finishedAt: "",
      effects:
        "No production handlers or CLI. Only the fixed fixture:/note.md can be created by the registered fixture capability.",
    };
    const save = (): void =>
      writeFileSync(file, JSON.stringify(record, null, 2));
    const gate = createRequestGate();
    const emptyRegistry = createRegistry([]);
    const choices = ["write", "edit", "move", "rename", "delete"];
    const schema = localDecisionSchema(choices);
    for (const [request, expected] of [
      ["Create a note about local AI", "write"],
      ["Rewrite the introduction of garden:/Idea.md", "edit"],
      ["Move garden:/Idea.md to Archive", "move"],
      ["Rename garden:/Idea.md to Thought.md", "rename"],
      ["Delete garden:/Old.md", "delete"],
      ["Explain how Obsidian works; do not change any note", "cannot_classify"],
    ]) {
      const start = performance.now();
      try {
        const cts = resolveCTS({
          invocationId: randomUUID(),
          agentId: "decision",
          ceiling: { modules: [], actions: [] },
          sources: [],
          trustedInstructions: OBSIDIAN_OPERATION_INSTRUCTIONS,
        });
        const budget = createTurnBudget({
          signal: new AbortController().signal,
          durationMs: 130_000,
        });
        const result = await constrainedDecision({
          schema,
          invoke: async (correction) =>
            (
              await invokeAgent({
                agentId: "decision",
                modelProfileId: "decision",
                configured,
                cts,
                value: {
                  request,
                  choices,
                  ...(correction ? { correction } : {}),
                },
                outputSchema: schema,
                outputJsonSchema: z.toJSONSchema(schema),
                registry: emptyRegistry,
                context: { actor: "model", threadId: "evaluation" },
                gate,
                budget,
              })
            ).output,
        });
        const selected =
          result.value.kind === "selected"
            ? result.value.value
            : result.value.kind;
        record.local.push({
          request,
          expected,
          result: result.value,
          correct: selected === expected,
          corrections: result.corrections,
          latencyMs: performance.now() - start,
        });
      } catch (error) {
        record.local.push({
          request,
          expected,
          correct: false,
          error: String(error),
          latencyMs: performance.now() - start,
        });
      }
      save();
    }
    for (const [index, request] of [
      "Hello, explain in one sentence what a workflow is.",
      "Use the registered environment.platform command to report this fixture's platform.",
      "Create fixture:/note.md containing Hello fixture, then ask me a required yes/no question about whether to continue.",
    ].entries()) {
      const root = join(directory, `case-${index}`);
      mkdirSync(root);
      const database = new DatabaseSync(join(root, "fixture.sqlite"));
      migrateDatabase(database, VERBO_MIGRATIONS);
      const scopes = createScopeStore(database);
      const added = scopes.apply({
        removeIds: [],
        updates: [],
        additions: [
          {
            alias: "fixture",
            path: root,
            read: true,
            write: true,
            defaultSave: true,
          },
        ],
      });
      if (!added.ok) throw new Error(added.summary);
      database
        .prepare(
          "INSERT INTO threads(id,title,created_at,updated_at) VALUES('fixture-thread','Fixture',1,1)",
        )
        .run();
      let effects = 0,
        commandDispatches = 0;
      const registry = createRegistry(
        [
          {
            id: "environment.platform",
            description: "Report fixture platform facts",
            kind: "read",
            args: z.object({}).strict(),
            approval: "none",
            example: {},
            execute: () => {
              commandDispatches += 1;
              return {
                action: "environment.platform",
                status: "success",
                summary: "The fixture platform is Windows.",
              };
            },
          },
          {
            id: "files.create",
            description:
              "Create the sole disposable fixture note. Only path fixture:/note.md is allowed.",
            kind: "mutation",
            args: z
              .object({
                path: z.literal("fixture:/note.md"),
                kind: z.literal("file").optional(),
                content: z.string().max(5000),
              })
              .strict(),
            approval: "none",
            example: {
              path: "fixture:/note.md",
              kind: "file",
              content: "Hello fixture",
            },
            execute: (args) => {
              commandDispatches += 1;
              const target = join(root, "note.md");
              if (existsSync(target))
                return {
                  action: "files.create",
                  status: "error",
                  code: "collision",
                  summary: "The fixture note already exists.",
                };
              writeFileSync(target, String(args.content), { flag: "wx" });
              effects += 1;
              recordFileResource(target, "write");
              return {
                action: "files.create",
                status: "success",
                summary: "Created fixture:/note.md with the requested content.",
              };
            },
          },
        ],
        { finalize: (input) => persistCommandReceipt(database, input) },
      );
      const assets = createAssetStore(database, join(root, "assets"));
      const dispatcher = createTurnDispatcher(database);
      const controller = createTurnController({
        database,
        dispatcher,
        retryDelays: [],
        work: (input) =>
          runWorkflowTurn({
            ...input,
            database,
            settings: configured,
            registry,
            assets,
            gate,
            inventory: {
              folders: [
                {
                  id: scopes.list()[0]!.id,
                  aliases: ["fixture"],
                  kind: "none",
                  description:
                    "Disposable generic note fixture. Use registered files commands.",
                  read: true,
                  write: true,
                  defaultSave: true,
                  available: true,
                  directories: [],
                  truncated: false,
                },
              ],
              truncated: false,
              generation: 1,
              refreshedAt: 1,
            },
            awaitDecision: undefined,
          }),
      });
      const start = performance.now();
      try {
        await controller.admitTurn(
          {
            threadId: "fixture-thread",
            userMessageId: "user-one",
            assistantMessageId: "assistant-one",
            admission: "immediate",
            source: "typed",
            text: request,
            attachmentIds: [],
          },
          () => undefined,
        ).completion;
        const store = createWorkflowExecutionStore(database);
        const execution = store.list("fixture-thread")[0];
        const receiptsBefore = database
          .prepare("SELECT id FROM command_receipts ORDER BY id")
          .all()
          .map((row) => row.id);
        let continuation: unknown;
        if (execution?.status === "awaiting_input") {
          await controller.admitTurn(
            {
              threadId: "fixture-thread",
              userMessageId: "user-two",
              assistantMessageId: "assistant-two",
              branchAnchor: "assistant-one",
              admission: "immediate",
              source: "typed",
              text: "yes",
              attachmentIds: [],
            },
            () => undefined,
          ).completion;
          continuation = {
            execution: store.read(execution.id)?.status,
            effectsAfterResume: effects,
            receiptsAfter: database
              .prepare("SELECT id FROM command_receipts ORDER BY id")
              .all()
              .map((row) => row.id),
          };
        }
        record.workflows.push({
          request,
          latencyMs: performance.now() - start,
          selectedWorkflow: execution?.workflowId,
          status: execution?.status,
          effects,
          commandDispatches,
          receiptsBefore,
          continuation,
          finalMessages: loadThreadHistory(database, "fixture-thread")
            .messages.filter((item) => item.message.role === "assistant")
            .map((item) => item.message),
        });
      } catch (error) {
        record.workflows.push({
          request,
          error: String(error),
          effects,
          commandDispatches,
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
