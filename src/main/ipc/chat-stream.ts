import { randomUUID } from "node:crypto";
import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { z } from "zod";
import {
  ASSISTANT_STREAM_CHANNEL,
  type ChatEvent,
} from "../../shared/chat-ipc";
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
import { streamOllamaTurn } from "../services/ollama-turn-stream";
import { loadSettings } from "../services/settings-store";
import { executeLocalCommand } from "../runtime/local-command";
import { ollamaRequestGate } from "../runtime/ollama-gate";
import { turnDispatcher } from "../runtime/queue-service";
import { refreshModelVision } from "../runtime/model-vision";
import { toOllamaMessages, withUserImages } from "../runtime/ollama-wire";
import { runTurn, type TurnUpdate } from "../runtime/turn";
import { createAssetStore } from "../files/asset-store";

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

export function registerAssistantStreamIpc(mainWindow: BrowserWindow): void {
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
    const memory = createMemoryStore(database).snapshot(chatRequest.threadId);
    const history = expandHistoryWithTurnEvents(
      getDatabase(),
      chatRequest.messages.slice(0, -1),
    );
    const abortController = new AbortController();
    port.once("close", () => {
      abortController.abort();
      dispatcher.cancelIfRunning(turnId);
    });
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
        send({ type: "context_trimmed", removedCount: update.removedCount });
      }
      if (update.type === "text") send({ type: "delta", text: update.text });
      if (update.type === "assistant_tools") {
        persist("assistant_tools", {
          content: update.content,
          toolCalls: update.toolCalls,
        });
        send({
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
        send({
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
        send({
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
        model: (messages, hooks) =>
          streamOllamaTurn(
            withUserImages(toOllamaMessages(messages), images),
            settings,
            hooks.signal ?? abortController.signal,
            hooks.onText,
          ),
      })
        .then(() => {
          if (abortController.signal.aborted) return;
          send({ type: "done" });
          port.close();
        })
        .catch((error: unknown) => {
          if (abortController.signal.aborted) return;
          dispatcher.fail(turnId);
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Stream failed",
          });
          port.close();
        });
    })();
  };

  ipcMain.on(ASSISTANT_STREAM_CHANNEL, handleStream);
  mainWindow.once("closed", () => {
    ipcMain.removeListener(ASSISTANT_STREAM_CHANNEL, handleStream);
  });
}
