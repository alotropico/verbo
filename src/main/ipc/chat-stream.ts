import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { z } from "zod";
import {
  ASSISTANT_STREAM_CHANNEL,
  type ChatEvent,
  type ChatRequest,
} from "../../shared/chat-ipc";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import { persistedThreadIdSchema } from "../../shared/thread-identity";
import { streamOllamaChat } from "../services/ollama";
import { trimMessagesForContext } from "../services/history-trim";
import { loadSettings } from "../services/settings-store";
import { getDatabase } from "../db/database";
import { assertTurnThread } from "../db/history";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(500_000),
});

const chatRequestSchema = z.object({
  threadId: persistedThreadIdSchema,
  parentId: persistedThreadIdSchema.optional(),
  system: z.string().max(50_000).optional(),
  messages: z.array(chatMessageSchema).max(200),
  settings: chatSettingsSchema.optional(),
});

function isChatRequest(value: unknown): value is ChatRequest {
  const result = chatRequestSchema.safeParse(value);
  return result.success;
}

export function registerAssistantStreamIpc(mainWindow: BrowserWindow): void {
  const handleStream = (event: IpcMainEvent, request: unknown) => {
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
    const send = (message: ChatEvent) => port.postMessage(message);

    if (!isChatRequest(request)) {
      send({ type: "error", message: "Invalid chat request." });
      port.close();
      return;
    }

    try {
      assertTurnThread(getDatabase(), request.threadId, request.parentId);
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "Invalid thread.",
      });
      port.close();
      return;
    }

    const settings = request.settings ?? loadSettings();
    const { messages, removedCount } = trimMessagesForContext(
      request.messages,
      Math.floor(settings.numCtx * 0.75),
    );
    if (removedCount > 0) {
      send({ type: "context_trimmed", removedCount });
    }

    const abortController = new AbortController();
    port.once("close", () => abortController.abort());

    void streamOllamaChat(messages, settings, abortController.signal, {
      onDelta: (text) => send({ type: "delta", text }),
      onDone: () => {
        send({ type: "done" });
        port.close();
      },
      onError: (message) => {
        if (abortController.signal.aborted) return;
        send({ type: "error", message });
        port.close();
      },
    });
  };

  ipcMain.on(ASSISTANT_STREAM_CHANNEL, handleStream);
  mainWindow.once("closed", () => {
    ipcMain.removeListener(ASSISTANT_STREAM_CHANNEL, handleStream);
  });
}
