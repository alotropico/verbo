import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { z } from "zod";
import {
  ASSISTANT_STREAM_CHANNEL,
  type ChatEvent,
} from "../../shared/chat-ipc";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import { modelRoute } from "../../shared/local-commands";
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
import { toOllamaMessages } from "../runtime/ollama-wire";
import { runTurn, type TurnUpdate } from "../runtime/turn";

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
    if (modelRoute(latest.content) === "local") {
      const result = executeLocalCommand({
        text: latest.content,
        threadId: chatRequest.threadId,
        store: createMemoryStore(database),
        registry: registryForDatabase(database),
      });
      send({ type: "delta", text: result.summary });
      send({ type: "done" });
      port.close();
      return;
    }
    const memory = createMemoryStore(database).snapshot(chatRequest.threadId);
    const history = expandHistoryWithTurnEvents(
      getDatabase(),
      chatRequest.messages.slice(0, -1),
    );
    const abortController = new AbortController();
    port.once("close", () => abortController.abort());
    const turnId = randomUUID();
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

    void runTurn({
      userText: latest.content,
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
          toOllamaMessages(messages),
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
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Stream failed",
        });
        port.close();
      });
  };

  ipcMain.on(ASSISTANT_STREAM_CHANNEL, handleStream);
  mainWindow.once("closed", () => {
    ipcMain.removeListener(ASSISTANT_STREAM_CHANNEL, handleStream);
  });
}
