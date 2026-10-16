import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cpus, totalmem } from "node:os";
import { it } from "vitest";
import { DEFAULT_CHAT_SETTINGS, OLLAMA_BASE_URL } from "../../shared/config";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import { createRegistry } from "../capabilities/registry";
import { createRequestGate } from "../runtime/request-gate";
import { createWorkflowRegistry } from "../workflows/registry";
import { routeGlobalRequest } from "./routing";
import { createTurnBudget } from "./invoke";
import type { FolderCard } from "../files/routing-inventory";

const cases: {
  group: string;
  request: string;
  expected: string;
  multiple?: boolean;
}[] = [
  ...[
    "Create an Obsidian note about local AI",
    "Rename my Obsidian note ideas.md to thoughts.md",
    "Move my Obsidian note into Archive",
    "Edit the introduction of my Obsidian note",
    "Delete the old Obsidian scratch note",
  ].map((request) => ({
    group: "explicit-obsidian",
    request,
    expected: "obsidian",
  })),
  ...[
    "Save this idea as a note in garden",
    "Create a note in garden/Inbox about planning",
    "Rename the note garden:/ideas.md",
    "Move garden:/journal.md to garden:/Archive",
    "Update the note in my personal knowledge garden",
  ].map((request) => ({
    group: "implicit-folder",
    request,
    expected: "obsidian",
  })),
  ...[
    "Hello, how are you?",
    "Explain what Obsidian is",
    "Why does the sky look blue?",
    "Help me brainstorm names for a writing project",
    "Write a short poem about a garden",
  ].map((request) => ({
    group: "conversation",
    request,
    expected: "conversational",
  })),
  ...[
    "List PDF files in work",
    "Create work:/report.txt with the text hello",
    "Find package.json in my project folder",
    "Open the registered project Verbo",
    "Search the web for Electron documentation",
  ].map((request) => ({
    group: "generic-actions",
    request,
    expected: "commander",
  })),
  ...[
    "Save this as a note in one of my vaults",
    "Create an Obsidian note, I have two vaults",
    "Move a note to my other vault",
    "Put these meeting notes into a vault",
    "Update my note but I have not picked a vault",
  ].map((request) => ({
    group: "ambiguous-destination",
    request,
    expected: "clarify",
    multiple: true,
  })),
];
const garden: FolderCard = {
  id: "fixture-garden",
  aliases: ["garden", "personal"],
  kind: "obsidian",
  description: "Personal knowledge garden, ideas, meeting notes and journal",
  read: true,
  write: true,
  defaultSave: false,
  available: true,
  directories: ["Inbox", "Archive", "Ideas"],
  truncated: false,
};
const work: FolderCard = {
  ...garden,
  id: "fixture-work",
  aliases: ["work"],
  kind: "projects",
  description: "Software projects and generic reports",
  directories: ["Verbo", "Website"],
  defaultSave: true,
};

it.skipIf(process.env.VERBO_QWEN_ROUTING_BENCHMARK !== "1")(
  "measures real Qwen routing with fixture cards and external effects disabled",
  async () => {
    let configured = { ...DEFAULT_CHAT_SETTINGS };
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
      /* Installed default when no configuration is available. */
    }
    const finalEvaluation = process.env.VERBO_QWEN_EVAL_PHASE === "final";
    const directory = mkdtempSync(
      join(
        process.cwd(),
        ".tmp",
        "scratch",
        `${new Date().toISOString().slice(0, 10)}-qwen-routing-${finalEvaluation ? "final-" : "early-"}`,
      ),
    );
    const file = join(directory, "results.json");
    const record: Record<string, unknown> = {
      startedAt: new Date().toISOString(),
      configured,
      cpu: cpus()[0]?.model,
      memoryBytes: totalmem(),
      cases: [],
      effects: "disabled; fixture metadata only",
    };
    const results: unknown[] = [];
    record.cases = results;
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      record.installedModels = await response.json();
      if (!response.ok)
        throw new Error(`Ollama tags returned ${response.status}`);
    } catch (error) {
      record.status = "blocked";
      record.error = String(error);
      writeFileSync(file, JSON.stringify(record, null, 2));
      return;
    }
    const workflows = createWorkflowRegistry();
    const registry = createRegistry([]);
    const gate = createRequestGate();
    const samples = finalEvaluation
      ? [
          ...cases,
          {
            group: "contradictions",
            request:
              "Do not save anything. Explain how creating notes in Obsidian works.",
            expected: "conversational",
          },
          {
            group: "contradictions",
            request:
              "My project mentions Obsidian but I only want a poem, no file changes.",
            expected: "conversational",
          },
          {
            group: "mixed-domains",
            request:
              "Create work:/project-summary.txt describing my garden vault",
            expected: "commander",
          },
          {
            group: "mixed-domains",
            request:
              "Save a note about my software project in garden:/Ideas/Project.md",
            expected: "obsidian",
          },
          {
            group: "save-that",
            request: "Save that draft in garden as a note",
            expected: "obsidian",
          },
        ]
      : cases;
    for (const [index, sample] of samples.entries()) {
      const started = performance.now();
      let inferenceStarted: number | undefined;
      try {
        const result = await routeGlobalRequest({
          request: sample.request,
          threadId: "benchmark",
          turnId: `benchmark-${index}`,
          configured,
          inventory: {
            folders: sample.multiple
              ? [
                  garden,
                  {
                    ...garden,
                    id: "fixture-office",
                    aliases: ["office"],
                    description: "Office and team notes",
                  },
                  work,
                ]
              : [garden, work],
            truncated: false,
            generation: 1,
            refreshedAt: Date.now(),
          },
          workflows: workflows.cards,
          pending: [],
          queuedInterruption: false,
          contentRefs:
            sample.group === "save-that"
              ? [
                  {
                    messageId: "draft",
                    excerpt:
                      "# A retained draft\nUse this actual text when saving.",
                  },
                ]
              : [],
          sources: [],
          registry,
          gate,
          budget: createTurnBudget({
            signal: new AbortController().signal,
            durationMs: 130_000,
          }),
          onInferenceStart: () => {
            inferenceStarted ??= performance.now();
          },
        });
        const effective =
          result.value.kind === "new"
            ? result.value.workflowId
            : result.value.kind;
        const needsVaultClarification =
          sample.multiple &&
          result.value.kind === "new" &&
          result.value.workflowId === "obsidian" &&
          !result.value.targetHint;
        results.push({
          ...sample,
          result: result.value,
          correct:
            effective === sample.expected ||
            (sample.expected === "clarify" && needsVaultClarification),
          clarification: effective === "clarify" || needsVaultClarification,
          corrections: result.corrections,
          latencyMs: performance.now() - started,
          gateWaitMs:
            inferenceStarted === undefined ? null : inferenceStarted - started,
          warm: index > 0,
        });
      } catch (error) {
        results.push({
          ...sample,
          correct: false,
          invalid: true,
          error: String(error),
          latencyMs: performance.now() - started,
        });
      }
      writeFileSync(file, JSON.stringify(record, null, 2));
    }
    record.status = "measured";
    record.finishedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(record, null, 2));
  },
  3_500_000,
);
