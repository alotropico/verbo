import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { z } from "zod";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import { invokeAgent, createTurnBudget } from "../agents/invoke";
import { resolveCTS } from "../agents/cts";
import { resolveModelProfile } from "../agents/profiles";
import { createRegistry } from "../capabilities/registry";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { loadThreadHistory } from "../db/history";
import { createAssetStore } from "../files/asset-store";
import { serviceManager } from "../services/service-host";
import { generateThreadTitle } from "../services/thread-title";
import { streamOllamaTurn } from "../services/ollama-turn-stream";
import { createTurnController } from "./controller";
import { createTurnDispatcher } from "./turn-dispatcher";
import { runWorkflowTurn } from "./workflow-runner";
import { ollamaRequestGate } from "./ollama-gate";
import { toOllamaMessages } from "./ollama-wire";
import { inferenceMeasurements } from "./prompt-eval";

it.skipIf(process.env.VERBO_LIVE_CONTEXT_METRICS !== "1")(
  "observes installed Ollama reuse and scoped disposable workflows",
  async () => {
    const settings = chatSettingsSchema.parse(
      JSON.parse(
        readFileSync(
          join(process.env.APPDATA ?? "", "verbo", "settings.json"),
          "utf8",
        ),
      ),
    );
    const manager = await serviceManager(process.cwd());
    const service = await manager.start("ollama");
    const evidenceFile = join(
      process.cwd(),
      ".tmp",
      "scratch",
      "2026-10-16-ollama-live-evidence.json",
    );
    const observations: unknown[] = [];
    const record = (value: unknown): void => {
      observations.push(value);
      writeFileSync(
        evidenceFile,
        JSON.stringify(
          {
            settings,
            service,
            observations,
            measurements: inferenceMeasurements.list(),
          },
          null,
          2,
        ),
      );
    };
    const snapshot = async (label: string): Promise<void> => {
      const ps = await fetch("http://127.0.0.1:11434/api/ps").then((response) =>
        response.json(),
      );
      let pids = "unavailable";
      let gpu = "unavailable";
      try {
        pids = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-Process *llama* -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | ConvertTo-Json -Compress",
          ],
          { windowsHide: true, encoding: "utf8" },
        );
      } catch {
        /* Optional diagnostics. */
      }
      try {
        gpu = execFileSync(
          "nvidia-smi",
          [
            "--query-gpu=memory.used,memory.total",
            "--format=csv,noheader,nounits",
          ],
          { windowsHide: true, encoding: "utf8" },
        );
      } catch {
        /* Optional diagnostics. */
      }
      record({
        label,
        at: new Date().toISOString(),
        ps,
        pids,
        gpuMemoryMiB: gpu,
      });
      console.log(`Live observation: ${label}`);
    };
    const directory = mkdtempSync(
      join(process.cwd(), ".tmp", "scratch", "2026-10-16-live-context-"),
    );
    const database = new DatabaseSync(":memory:");
    try {
      expect(service.state).toBe("ready");
      record({
        version: await fetch("http://127.0.0.1:11434/api/version").then(
          (response) => response.json(),
        ),
        serverEnvironment: Object.fromEntries(
          [
            "OLLAMA_NUM_PARALLEL",
            "OLLAMA_MAX_LOADED_MODELS",
            "OLLAMA_FLASH_ATTENTION",
            "OLLAMA_KV_CACHE_TYPE",
          ].map((key) => [
            key,
            process.env[key] ?? "not set in client environment",
          ]),
        ),
      });
      await snapshot("before");
      migrateDatabase(database, VERBO_MIGRATIONS);
      const ids: string[] = [randomUUID(), randomUUID()];
      const markers = ["amber-sparrow-427", "violet-comet-931"];
      for (const id of ids)
        database
          .prepare(
            "INSERT INTO threads(id,title,created_at,updated_at) VALUES(?,?,1,1)",
          )
          .run(id, "Disposable validation");
      mkdirSync(join(directory, "assets"));
      const assets = createAssetStore(database, join(directory, "assets"));
      const registry = createRegistry([]);
      const controller = createTurnController({
        database,
        dispatcher: createTurnDispatcher(database),
        retryDelays: [],
        work: (input) =>
          runWorkflowTurn({
            ...input,
            database,
            settings,
            assets,
            registry,
            gate: ollamaRequestGate,
            inventory: {
              folders: [],
              truncated: false,
              generation: 1,
              refreshedAt: 1,
            },
            awaitDecision: undefined,
            invoke: (input) =>
              invokeAgent({
                ...input,
                model: async (messages, hooks, options) => {
                  const text = JSON.stringify(messages);
                  const other =
                    markers[1 - ids.indexOf(input.context.threadId)]!;
                  expect(text).not.toContain(other);
                  record({
                    payloadScopeChecked: true,
                    threadId: input.context.threadId,
                    invocationId: input.cts.policy.id,
                    agentId: input.agentId,
                    historyMessageIds: input.history?.map(
                      (message) => message.messageId,
                    ),
                  });
                  return streamOllamaTurn(
                    toOllamaMessages(messages),
                    resolveModelProfile(input.modelProfileId, settings)
                      .settings,
                    hooks.signal!,
                    hooks.onText,
                    options,
                  );
                },
              }),
          }),
      });
      const send = (
        index: number,
        text: string,
        branchAnchor?: string,
      ): {
        assistantMessageId: string;
        completion: ReturnType<typeof controller.admitTurn>["completion"];
      } => {
        const userMessageId = randomUUID();
        const assistantMessageId = randomUUID();
        const handle = controller.admitTurn(
          {
            threadId: ids[index]!,
            userMessageId,
            assistantMessageId,
            branchAnchor,
            source: "typed",
            admission: "immediate",
            text,
            attachmentIds: [],
          },
          (event) => {
            if (event.type === "routing_stage")
              record({ routingStage: event.stage });
          },
        );
        return { assistantMessageId, completion: handle.completion };
      };
      // Submit both chats before awaiting either, retaining the existing admission policy.
      const a = send(
        0,
        `Remember my private marker ${markers[0]}. Reply with just the marker.`,
      );
      let b: ReturnType<typeof send> | undefined;
      try {
        b = send(
          1,
          `Remember my private marker ${markers[1]}. Reply with just the marker.`,
        );
      } catch (error) {
        record({
          interleavedAdmission:
            error instanceof Error ? error.message : String(error),
        });
      }
      await a.completion;
      b ??= send(
        1,
        `Remember my private marker ${markers[1]}. Reply with just the marker.`,
      );
      await b.completion;
      await snapshot("two-chat-interleaved-no-titles");
      for (let index = 0; index < 2; index++) {
        const text = JSON.stringify(
          loadThreadHistory(database, ids[index]!).messages,
        );
        expect(text).toContain(markers[index]);
        expect(text).not.toContain(markers[1 - index]);
        expect(
          inferenceMeasurements.latest(ids[index], "conversational")?.status,
        ).toBe("completed");
      }
      const beforeTitle = inferenceMeasurements.latest(
        ids[0],
        "conversational",
      );
      const title = await generateThreadTitle(
        ids[0]!,
        [{ role: "user", content: "A disposable marker chat" }],
        settings,
      );
      expect(title.length).toBeLessThanOrEqual(24);
      expect(inferenceMeasurements.latest(ids[0], "conversational")).toEqual(
        beforeTitle,
      );
      await snapshot("late-title-same-context");
      for (const [index, anchor] of [
        a.assistantMessageId,
        b.assistantMessageId,
      ].entries()) {
        const recall = send(
          index,
          "What is my private marker? Reply with just the marker.",
          anchor,
        );
        await recall.completion;
        const message = loadThreadHistory(database, ids[index]!).messages.at(
          -1,
        );
        const ownMarkerRecalled = JSON.stringify(
          message?.message.content,
        ).includes(markers[index]!);
        record({ recallChat: index, ownMarkerRecalled });
        await snapshot(`return-to-chat-${index}`);
      }
      for (let index = 0; index < 2; index++) {
        const cts = resolveCTS({
          invocationId: randomUUID(),
          agentId: "writer",
          ceiling: { modules: [], actions: [] },
          sources: [],
        });
        await invokeAgent({
          agentId: "writer",
          modelProfileId: "writer",
          configured: settings,
          cts,
          value: {
            request: `Write one sentence about disposable fixture ${index}.`,
          },
          outputSchema: z.object({ body: z.string() }),
          outputJsonSchema: z.toJSONSchema(z.object({ body: z.string() })),
          context: { actor: "model", threadId: ids[index]! },
          registry,
          gate: ollamaRequestGate,
          budget: createTurnBudget({ signal: new AbortController().signal }),
          model: async (messages, hooks, options) => {
            expect(messages).toHaveLength(2);
            expect(JSON.stringify(messages)).not.toContain(markers[0]);
            expect(JSON.stringify(messages)).not.toContain(markers[1]);
            return streamOllamaTurn(
              toOllamaMessages(messages),
              resolveModelProfile("writer", settings).settings,
              hooks.signal!,
              hooks.onText,
              options,
            );
          },
        });
        await snapshot(`specialized-${index}`);
      }
      record({
        outcome: "completed",
        uiSwitching: "not inspected",
        preChangeBaseline: "unavailable",
        titleComparison:
          "sequential post-change requests, not a controlled performance baseline",
      });
    } catch (error) {
      record({
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
      if (service.owned) {
        // The Windows service process can leave its runner child alive on exit.
        // Clean up only children of the service this disposable test started.
        try {
          if (service.pid && process.platform === "win32") {
            execFileSync(
              "powershell.exe",
              [
                "-NoProfile",
                "-Command",
                `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${service.pid}' | Where-Object Name -eq 'llama-server.exe' | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
              ],
              { windowsHide: true },
            );
          }
        } finally {
          await manager.stop("ollama");
        }
      }
    }
  },
  600_000,
);
