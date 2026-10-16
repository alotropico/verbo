import { app } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChatEvent, ExchangeRound } from "../../shared/chat-ipc";
import { FILE_MUTATION_LIMITS } from "../../shared/file-mutation";
import { routeUtterance } from "../../shared/local-commands";
import { registryForDatabase } from "../capabilities/catalog";
import { getDatabase } from "../db/database";
import { loadThreadHistory } from "../db/history";
import { createMemoryStore } from "../db/memory";
import { createScopeStore } from "../db/scopes";
import { expandHistoryWithTurnEvents } from "../db/turn-events";
import { createAssetStore } from "../files/asset-store";
import { decideOperation } from "../files/mutation-plan";
import { operationSession } from "../files/mutation-ports";
import {
  ollamaChatBody,
  streamOllamaTurn,
} from "../services/ollama-turn-stream";
import { loadSettings } from "../services/settings-store";
import { resolveApproval, waitForApproval } from "./approval-wait";
import { createTurnController, type TurnWork } from "./controller";
import { executeLocalCommand } from "./local-command";
import { refreshModelVision } from "./model-vision";
import { ollamaRequestGate } from "./ollama-gate";
import { toOllamaMessages, withUserImages } from "./ollama-wire";
import { turnDispatcher } from "./queue-service";
import { runTurn } from "./turn";
import { noteLiveOperation } from "./turn-session";
import { runWorkflowTurn } from "./workflow-runner";
import { routingInventoryForDatabase } from "../files/routing-inventory";
import { createWorkflowExecutionStore } from "../db/workflow-executions";
import { readGuidanceAssignments } from "../agents/guidance";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

const work: TurnWork = async ({
  envelope,
  signal,
  emit,
  persist,
  checkpointPresentation,
}) => {
  const database = getDatabase();
  const dispatcher = turnDispatcher();
  const { threadId, turnId } = envelope;
  const registry = registryForDatabase(database);
  const awaitApproval = async (
    result: import("../../shared/action-contract").ActionResult,
  ): Promise<import("../../shared/action-contract").ActionResult> => {
    const operationId = result.operationId;
    if (!operationId) return result;
    dispatcher.awaitApproval(turnId);
    noteLiveOperation(turnId, operationId);
    const pending = waitForApproval(operationId, turnId, signal);
    const timer = setTimeout(() => {
      void decideOperation({
        database,
        scopes: createScopeStore(database),
        operationId,
        threadId,
        sessionId: operationSession(),
        decision: "deny",
      }).then((expired) => resolveApproval(operationId, expired));
    }, FILE_MUTATION_LIMITS.planTtlMs + 50);
    try {
      return await pending;
    } finally {
      clearTimeout(timer);
      dispatcher.settleApproval(turnId);
    }
  };
  if (routeUtterance(envelope.text, envelope.source).kind !== "model") {
    const result = await executeLocalCommand({
      text: envelope.text,
      source: envelope.source,
      threadId,
      store: createMemoryStore(database),
      registry,
      turnId,
      signal,
    });
    if (result.receipt) {
      let receipt = result.receipt;
      const toolCallId = receipt.receiptId ?? `${turnId}:command`;
      const commandEvent = (type: "approval" | "tool_result"): ChatEvent => ({
        type,
        toolCallId,
        name: "actions.invoke",
        args: { name: receipt.action, args: {} },
        result: receipt,
      });
      if (receipt.status === "requires_confirmation") {
        emit(commandEvent("approval"));
        receipt = await awaitApproval(receipt);
      }
      persist("tool_result", {
        toolName: "actions.invoke",
        content: JSON.stringify(receipt),
      });
      emit(commandEvent("tool_result"));
      emit({ type: "delta", text: receipt.summary });
    } else emit({ type: "delta", text: result.summary });
    if (result.newThread || result.openMemory)
      emit({
        type: "local_command",
        ...(result.newThread ? { newThread: true } : {}),
        ...(result.openMemory ? { openMemory: true } : {}),
      });
    return { stop: signal.aborted ? "cancelled" : "completed" };
  }
  const settings = loadSettings();
  if (process.env.VERBO_WORKFLOW_V1 !== "0") {
    const assets = createAssetStore(
      database,
      join(app.getPath("userData"), "attachments"),
    );
    return runWorkflowTurn({
      envelope,
      signal,
      emit,
      persist,
      checkpointPresentation,
      database,
      settings,
      assets,
      registry,
      gate: ollamaRequestGate,
      inventory: routingInventoryForDatabase(database).get(),
      awaitDecision: awaitApproval,
      guidance: readGuidanceAssignments(
        join(app.getPath("userData"), "agent-guidance.json"),
      ),
    });
  }
  const all = loadThreadHistory(database, threadId).messages;
  const byId = new Map(all.map((item) => [item.message.id, item]));
  const branch: typeof all = [];
  let parent = envelope.branchAnchor;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const item = byId.get(parent);
    if (!item) break;
    branch.unshift(item);
    parent = item.parentId ?? undefined;
  }
  const history = expandHistoryWithTurnEvents(
    database,
    branch.flatMap((item) =>
      item.message.role === "assistant" || item.message.role === "user"
        ? [
            {
              id: item.message.id,
              role: item.message.role,
              content: textContent(item.message.content),
            },
          ]
        : [],
    ),
  );
  const assets = createAssetStore(
    database,
    join(app.getPath("userData"), "attachments"),
  );
  signal.throwIfAborted();
  const vision = await refreshModelVision(settings.model);
  signal.throwIfAborted();
  const images = vision
    ? assets.imagePayloads(threadId, envelope.attachmentIds)
    : [];
  const excerpt = assets.excerpt(threadId, envelope.attachmentIds);
  const rounds: ExchangeRound[] = [];
  try {
    return await runTurn({
      inferenceSource: {
        threadId,
        turnId,
        invocationId: randomUUID(),
        agentId: "conversational",
        work: "foreground",
        model: settings.model,
        numCtx: settings.numCtx,
      },
      userText: excerpt ? `${envelope.text}\n\n${excerpt}` : envelope.text,
      history,
      numCtx: settings.numCtx,
      memory: createMemoryStore(database).snapshot(threadId),
      registry,
      context: { actor: "model", threadId, turnId },
      gate: ollamaRequestGate,
      signal,
      awaitDecision: awaitApproval,
      onUpdate: (update) => {
        if (update.type === "notice") {
          persist("backend_notice", update.notice);
          emit({ type: "backend_notice", notice: update.notice });
        }
        if (update.type === "trimmed" && update.removedCount)
          emit({ type: "context_trimmed", removedCount: update.removedCount });
        if (update.type === "text") emit({ type: "delta", text: update.text });
        if (update.type === "assistant_tools") {
          persist("assistant_tools", {
            content: update.content,
            toolCalls: update.toolCalls,
          });
          emit({
            type: "tools",
            content: update.content,
            calls: update.toolCalls,
          });
        }
        if (update.type === "approval") {
          dispatcher.awaitApproval(turnId);
          if (update.result.operationId)
            noteLiveOperation(turnId, update.result.operationId);
        }
        if (update.type === "approval" || update.type === "tool_result") {
          if (update.type === "tool_result")
            persist("tool_result", {
              toolName: update.toolName,
              content: update.content,
            });
          emit({
            type: update.type === "approval" ? "approval" : "tool_result",
            toolCallId: update.call.id,
            name: update.call.name,
            args: update.call.arguments,
            result: update.result,
          });
        }
        if (update.type === "stop" && update.content)
          persist("assistant_text", { content: update.content });
      },
      model: async (messages, hooks) => {
        const wire = withUserImages(toOllamaMessages(messages), images);
        const response = await streamOllamaTurn(
          wire,
          settings,
          hooks.signal ?? signal,
          hooks.onText,
          { onCompletion: hooks.onCompletion },
        );
        rounds.push({
          context: structuredClone(messages),
          request: ollamaChatBody(wire, settings),
          response,
        });
        return response;
      },
    });
  } finally {
    if (rounds.length)
      emit({
        type: "exchange",
        interaction: {
          assistantMessageId: envelope.assistantMessageId,
          threadId,
          rounds,
        },
      });
  }
};

let singleton: ReturnType<typeof createTurnController> | undefined;
export function turnController(): ReturnType<typeof createTurnController> {
  if (!singleton) {
    singleton = createTurnController({
      database: getDatabase(),
      dispatcher: turnDispatcher(),
      work,
    });
    createWorkflowExecutionStore(getDatabase()).reconcileInterrupted();
    singleton.recoverFinalizations();
  }
  return singleton;
}
