import { randomUUID } from "node:crypto";
import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { FILE_MUTATION_LIMITS } from "../../shared/file-mutation";
import { resolveApproval, waitForApproval } from "../runtime/approval-wait";
import {
  closeLiveTurn,
  liveById,
  liveEvents,
  liveTurnForThread,
  noteLiveOperation,
  openLiveTurn,
  publishLive,
  requestTurnCancel,
  setTurnCancelHandler,
  subscribeLive,
} from "../runtime/turn-session";
import { abandonPendingPlan, decideOperation } from "../files/mutation-plan";
import { operationSession } from "../files/mutation-ports";
import { createScopeStore } from "../db/scopes";
import { appendStoredMessage } from "../db/history";
import { loadHistory } from "../services/conversations";
import {
  ASSISTANT_STREAM_CHANNEL,
  USER_ABORT_NOTICE,
  type ChatEvent,
  type ChatMessage,
  type ExchangeRound,
} from "../../shared/chat-ipc";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import { routeUtterance } from "../../shared/local-commands";
import { persistedThreadIdSchema } from "../../shared/thread-identity";
import { registryForDatabase } from "../capabilities/catalog";
import { getDatabase } from "../db/database";
import { createMemoryStore } from "../db/memory";
import { assertTurnThread } from "../db/history";
import {
  expandHistoryWithTurnEvents,
  recordTurnEvent,
  type TurnEventKind,
} from "../db/turn-events";
import {
  ollamaChatBody,
  streamOllamaTurn,
} from "../services/ollama-turn-stream";
import { loadSettings } from "../services/settings-store";
import { executeLocalCommand } from "../runtime/local-command";
import { ollamaRequestGate } from "../runtime/ollama-gate";
import { turnDispatcher } from "../runtime/queue-service";
import { refreshModelVision } from "../runtime/model-vision";
import { toOllamaMessages, withUserImages } from "../runtime/ollama-wire";
import type { ContextMessage } from "../runtime/context-builder";
import type { ChatSettings } from "../../shared/config";
import { runTurn, type TurnUpdate } from "../runtime/turn";
import { createAssetStore } from "../files/asset-store";
import type { QueuedTurn } from "../../shared/turn-queue";
import {
  emptyChatProjection,
  projectChatEvent,
  visibleProjection,
} from "../../shared/chat-projection";

const chatMessageSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    role: z.enum(["user", "assistant"]),
    content: z.string().max(500_000),
  })
  .strict();

const chatRequestSchema = z
  .object({
    threadId: persistedThreadIdSchema,
    parentId: persistedThreadIdSchema.optional(),
    assistantMessageId: z.string().min(1).max(128),
    system: z.string().max(50_000).optional(),
    messages: z.array(chatMessageSchema).max(200),
    settings: chatSettingsSchema.optional(),
    queueItemId: z.string().uuid().optional(),
    source: z.enum(["typed", "voice"]).optional(),
    attachmentIds: z.array(z.string().uuid()).max(8).optional(),
  })
  .strict();

function recordingModel(
  settings: ChatSettings,
  images: string[],
  fallbackSignal: AbortSignal,
  rounds: ExchangeRound[],
) {
  return (
    messages: ContextMessage[],
    hooks: { onText: (snapshot: string) => void; signal?: AbortSignal },
  ): Promise<unknown[]> => {
    const wire = withUserImages(toOllamaMessages(messages), images);
    const request = ollamaChatBody(wire, settings);
    return streamOllamaTurn(
      wire,
      settings,
      hooks.signal ?? fallbackSignal,
      hooks.onText,
    ).then((response) => {
      rounds.push({
        context: structuredClone(messages),
        request,
        response,
      });
      return response;
    });
  };
}

function exchangeEvent(
  assistantMessageId: string,
  threadId: string,
  rounds: ExchangeRound[],
): ChatEvent | null {
  if (rounds.length === 0) return null;
  return {
    type: "exchange",
    interaction: { assistantMessageId, threadId, rounds },
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) return [];
      const text = part.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

async function startPromotedTurn(
  mainWindow: BrowserWindow,
  item: QueuedTurn,
): Promise<void> {
  const database = getDatabase();
  const dispatcher = turnDispatcher();
  const turnId = randomUUID();
  const assistantMessageId = randomUUID();
  const begun = dispatcher.begin({
    queueItemId: item.id,
    threadId: item.threadId,
    turnId,
  });
  if (!begun.ok || begun.attached) return;
  const anchor = item.branchAnchor ?? undefined;
  appendStoredMessage(database, item.threadId, anchor, {
    id: item.id,
    role: "user",
    content: [{ type: "text", text: item.text }],
  });
  const plain: ChatMessage[] = loadHistory(item.threadId).messages.flatMap(
    (entry) => {
      const role =
        entry.message.role === "assistant"
          ? ("assistant" as const)
          : entry.message.role === "user"
            ? ("user" as const)
            : null;
      if (!role || entry.message.id === item.id) return [];
      return [
        {
          id: entry.message.id,
          role,
          content: messageText(entry.message.content),
        },
      ];
    },
  );
  const history = expandHistoryWithTurnEvents(database, plain);
  const settings = loadSettings();
  const abortController = new AbortController();
  openLiveTurn({
    turnId,
    threadId: item.threadId,
    queueItemId: item.id,
    assistantMessageId,
    userText: item.text,
    operationId: null,
    abort: abortController,
  });
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.turnStarted, {
      threadId: item.threadId,
      queueItemId: item.id,
      turnId,
      text: item.text,
      attachmentRefs: item.attachmentRefs,
    });
  }
  let projection = emptyChatProjection();
  const emit = (message: ChatEvent): void => {
    projection = projectChatEvent(projection, message);
    publishLive(turnId, message);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.turnStarted, {
        threadId: item.threadId,
        queueItemId: item.id,
        turnId,
        event: message,
      });
    }
  };
  let seq = 0;
  const persist = (kind: TurnEventKind, payload: unknown): void => {
    seq += 1;
    recordTurnEvent(database, {
      id: `${turnId}:${seq}`,
      threadId: item.threadId,
      messageId: assistantMessageId,
      turnId,
      seq,
      kind,
      payload,
    });
  };
  const onUpdate = (update: TurnUpdate): void => {
    if (update.type === "text") emit({ type: "delta", text: update.text });
    if (update.type === "approval") {
      dispatcher.awaitApproval(turnId);
      if (update.result.operationId) {
        noteLiveOperation(turnId, update.result.operationId);
      }
      emit({
        type: "approval",
        toolCallId: update.call.id,
        name: update.call.name,
        args: update.call.arguments,
        result: update.result,
      });
    }
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
    if (update.type === "tool_result") {
      persist("tool_result", {
        toolName: update.toolName,
        content: update.content,
      });
      emit({
        type: "tool_result",
        toolCallId: update.call.id,
        name: update.call.name,
        args: update.call.arguments,
        result: update.result,
      });
    }
    if (update.type === "stop") {
      if (update.stop === "paused") dispatcher.awaitApproval(turnId);
      else if (update.stop === "completed") dispatcher.complete(turnId);
      else if (update.stop === "cancelled") dispatcher.cancelIfRunning(turnId);
      else dispatcher.fail(turnId);
      if (update.stop === "completed" && update.content) {
        persist("assistant_text", { content: update.content });
      }
      emit({
        type: "turn_status",
        stop: update.stop,
        ...(update.summary ? { summary: update.summary } : {}),
      });
    }
  };
  const assets = createAssetStore(
    database,
    join(app.getPath("userData"), "attachments"),
  );
  const attachmentIds = item.attachmentRefs.map((ref) => ref.id);
  const rounds: ExchangeRound[] = [];
  let tracedSent = false;
  const emitTrace = (): void => {
    if (tracedSent) return;
    tracedSent = true;
    const traced = exchangeEvent(assistantMessageId, item.threadId, rounds);
    if (traced) emit(traced);
  };
  try {
    const vision = await refreshModelVision(settings.model);
    if (abortController.signal.aborted) return;
    const images = vision
      ? assets.imagePayloads(item.threadId, attachmentIds)
      : [];
    const excerpt = assets.excerpt(item.threadId, attachmentIds);
    await runTurn({
      userText: excerpt ? `${item.text}\n\n${excerpt}` : item.text,
      history,
      numCtx: settings.numCtx,
      memory: createMemoryStore(database).snapshot(item.threadId),
      registry: registryForDatabase(database),
      context: { actor: "model", threadId: item.threadId, turnId },
      gate: ollamaRequestGate,
      signal: abortController.signal,
      onUpdate,
      awaitDecision: async (result) => {
        const operationId = result.operationId;
        if (!operationId) return result;
        const pending = waitForApproval(
          operationId,
          turnId,
          abortController.signal,
        );
        const timer = setTimeout(() => {
          resolveApproval(
            operationId,
            decideOperation({
              database: getDatabase(),
              scopes: createScopeStore(getDatabase()),
              operationId,
              threadId: item.threadId,
              sessionId: operationSession(),
              decision: "deny",
            }),
          );
        }, FILE_MUTATION_LIMITS.planTtlMs + 50);
        try {
          const final = await pending;
          dispatcher.settleApproval(turnId);
          return final;
        } finally {
          clearTimeout(timer);
        }
      },
      model: recordingModel(settings, images, abortController.signal, rounds),
    });
    emitTrace();
    appendStoredMessage(database, item.threadId, item.id, {
      id: assistantMessageId,
      role: "assistant",
      content: visibleProjection(projection),
    });
    emit({ type: "done" });
  } catch (error) {
    emitTrace();
    if (!abortController.signal.aborted) {
      dispatcher.fail(turnId);
      emit({
        type: "error",
        message: error instanceof Error ? error.message : "Stream failed",
      });
    } else {
      emit({
        type: "turn_status",
        stop: "cancelled",
        summary: USER_ABORT_NOTICE,
      });
    }
  } finally {
    closeLiveTurn(turnId);
  }
}

export function registerAssistantStreamIpc(mainWindow: BrowserWindow): void {
  const dispatcher = turnDispatcher();
  dispatcher.setOnPromoted((item) => {
    void startPromotedTurn(mainWindow, item);
  });
  setTurnCancelHandler((turnId) => {
    const live = liveById(turnId);
    if (live?.operationId) abandonPendingPlan(getDatabase(), live.operationId);
    turnDispatcher().cancelIfRunning(turnId);
  });
  ipcMain.handle(IPC_CHANNELS.turnCancel, (event) => {
    if (
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      throw new Error("Untrusted IPC sender");
    }
    return { ok: requestTurnCancel() };
  });
  ipcMain.handle(IPC_CHANNELS.turnSnapshot, (event, threadId: unknown) => {
    if (
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      throw new Error("Untrusted IPC sender");
    }
    if (typeof threadId !== "string") return null;
    const live = liveTurnForThread(threadId);
    if (!live) return null;
    return {
      turnId: live.turnId,
      threadId: live.threadId,
      queueItemId: live.queueItemId,
      userText: live.userText,
      events: liveEvents(live.turnId),
    };
  });
  const handleStream = (event: IpcMainEvent, request: unknown): void => {
    const [port] = event.ports;
    if (!port) return;

    if (
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      port.close();
      return;
    }

    port.start();
    const send = (message: ChatEvent): void => port.postMessage(message);
    const parsed = chatRequestSchema.safeParse(request);

    if (!parsed.success) {
      send({ type: "error", message: "Invalid chat request." });
      port.close();
      return;
    }

    const chatRequest = parsed.data;
    const latest = chatRequest.messages.at(-1);
    if (!latest || latest.role !== "user") {
      send({ type: "error", message: "A turn needs a user message." });
      port.close();
      return;
    }

    try {
      assertTurnThread(
        getDatabase(),
        chatRequest.threadId,
        chatRequest.parentId,
      );
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "Invalid thread.",
      });
      port.close();
      return;
    }

    const settings = chatRequest.settings ?? loadSettings();
    const database = getDatabase();
    const dispatcher = turnDispatcher();
    const queuedSource = chatRequest.queueItemId
      ? dispatcher.queuedSource(chatRequest.queueItemId)
      : null;
    const source = chatRequest.source ?? queuedSource ?? "typed";
    if (routeUtterance(latest.content, source).kind !== "model") {
      const result = executeLocalCommand({
        text: latest.content,
        source,
        threadId: chatRequest.threadId,
        store: createMemoryStore(database),
        registry: registryForDatabase(database),
      });
      if (chatRequest.queueItemId) {
        dispatcher.completeReserved(chatRequest.queueItemId);
      }
      send({ type: "delta", text: result.summary });
      if (result.newThread || result.openMemory) {
        send({
          type: "local_command",
          ...(result.newThread ? { newThread: true } : {}),
          ...(result.openMemory ? { openMemory: true } : {}),
        });
      }
      send({ type: "done" });
      port.close();
      return;
    }
    const turnId = randomUUID();
    const begun = dispatcher.begin({
      threadId: chatRequest.threadId,
      turnId,
      ...(chatRequest.queueItemId
        ? { queueItemId: chatRequest.queueItemId }
        : {}),
    });
    if (!begun.ok) {
      send({ type: "error", message: begun.summary });
      port.close();
      return;
    }
    if (begun.attached && begun.turnId) {
      const attachedId = begun.turnId;
      for (const prior of liveEvents(attachedId)) send(prior);
      const stopLive = subscribeLive(attachedId, (event) => {
        try {
          send(event);
        } catch {
          stopLive();
        }
      });
      port.once("close", () => stopLive());
      return;
    }
    const memory = createMemoryStore(database).snapshot(chatRequest.threadId);
    const history = expandHistoryWithTurnEvents(
      getDatabase(),
      chatRequest.messages.slice(0, -1),
    );
    const abortController = new AbortController();
    openLiveTurn({
      turnId,
      threadId: chatRequest.threadId,
      queueItemId: chatRequest.queueItemId ?? null,
      assistantMessageId: chatRequest.assistantMessageId,
      userText: latest.content,
      operationId: null,
      abort: abortController,
    });
    const emit = (message: ChatEvent): void => {
      publishLive(turnId, message);
      try {
        send(message);
      } catch {
        // The renderer port can close without cancelling the turn.
      }
    };
    let seq = 0;
    const persist = (kind: TurnEventKind, payload: unknown): void => {
      seq += 1;
      recordTurnEvent(getDatabase(), {
        id: `${turnId}:${seq}`,
        threadId: chatRequest.threadId,
        messageId: chatRequest.assistantMessageId,
        turnId,
        seq,
        kind,
        payload,
      });
    };

    const onUpdate = (update: TurnUpdate): void => {
      if (update.type === "trimmed" && update.removedCount > 0) {
        emit({ type: "context_trimmed", removedCount: update.removedCount });
      }
      if (update.type === "text") emit({ type: "delta", text: update.text });
      if (update.type === "approval") {
        dispatcher.awaitApproval(turnId);
        if (update.result.operationId) {
          noteLiveOperation(turnId, update.result.operationId);
        }
        emit({
          type: "approval",
          toolCallId: update.call.id,
          name: update.call.name,
          args: update.call.arguments,
          result: update.result,
        });
      }
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
      if (update.type === "tool_result") {
        persist("tool_result", {
          toolName: update.toolName,
          content: update.content,
        });
        emit({
          type: "tool_result",
          toolCallId: update.call.id,
          name: update.call.name,
          args: update.call.arguments,
          result: update.result,
        });
      }
      if (update.type === "stop") {
        if (update.stop === "paused") dispatcher.awaitApproval(turnId);
        else if (update.stop === "completed") dispatcher.complete(turnId);
        else if (update.stop === "cancelled")
          dispatcher.cancelIfRunning(turnId);
        else dispatcher.fail(turnId);
        if (update.stop === "completed" && update.content) {
          persist("assistant_text", { content: update.content });
        }
        emit({
          type: "turn_status",
          stop: update.stop,
          ...(update.summary ? { summary: update.summary } : {}),
        });
      }
    };

    const assets = createAssetStore(
      database,
      join(app.getPath("userData"), "attachments"),
    );
    const attachmentIds = chatRequest.attachmentIds ?? [];
    const excerpt = assets.excerpt(chatRequest.threadId, attachmentIds);
    const userText = excerpt
      ? `${latest.content}\n\n${excerpt}`
      : latest.content;
    void (async () => {
      const vision = await refreshModelVision(settings.model);
      if (abortController.signal.aborted) return;
      const images = vision
        ? assets.imagePayloads(chatRequest.threadId, attachmentIds)
        : [];
      const rounds: ExchangeRound[] = [];
      void runTurn({
        userText,
        history,
        numCtx: settings.numCtx,
        memory,
        registry: registryForDatabase(database),
        context: {
          actor: "model",
          threadId: chatRequest.threadId,
          turnId,
        },
        gate: ollamaRequestGate,
        signal: abortController.signal,
        onUpdate,
        awaitDecision: async (result) => {
          const operationId = result.operationId;
          if (!operationId) return result;
          const pending = waitForApproval(
            operationId,
            turnId,
            abortController.signal,
          );
          const timer = setTimeout(() => {
            const expired = decideOperation({
              database: getDatabase(),
              scopes: createScopeStore(getDatabase()),
              operationId,
              threadId: chatRequest.threadId,
              sessionId: operationSession(),
              decision: "deny",
            });
            resolveApproval(operationId, expired);
          }, FILE_MUTATION_LIMITS.planTtlMs + 50);
          try {
            const final = await pending;
            dispatcher.settleApproval(turnId);
            return final;
          } finally {
            clearTimeout(timer);
          }
        },
        model: recordingModel(
          settings,
          images,
          abortController.signal,
          rounds,
        ),
      })
        .then(() => {
          const traced = exchangeEvent(
            chatRequest.assistantMessageId,
            chatRequest.threadId,
            rounds,
          );
          if (traced) emit(traced);
          emit({ type: "done" });
          closeLiveTurn(turnId);
          port.close();
        })
        .catch((error: unknown) => {
          const traced = exchangeEvent(
            chatRequest.assistantMessageId,
            chatRequest.threadId,
            rounds,
          );
          if (traced) emit(traced);
          if (!abortController.signal.aborted) {
            dispatcher.fail(turnId);
            emit({
              type: "error",
              message: error instanceof Error ? error.message : "Stream failed",
            });
          } else {
            emit({
              type: "turn_status",
              stop: "cancelled",
              summary: USER_ABORT_NOTICE,
            });
            emit({ type: "done" });
          }
          closeLiveTurn(turnId);
          port.close();
        });
    })();
  };

  ipcMain.on(ASSISTANT_STREAM_CHANNEL, handleStream);
  mainWindow.once("closed", () => {
    ipcMain.removeListener(ASSISTANT_STREAM_CHANNEL, handleStream);
  });
}
