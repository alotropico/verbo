import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { z } from "zod";
import {
  ASSISTANT_STREAM_CHANNEL,
  type ChatEvent,
} from "../../shared/chat-ipc";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import { persistedThreadIdSchema } from "../../shared/thread-identity";
import { chatSettingsSchema } from "../../shared/storage-ipc";
import { getDatabase } from "../db/database";
import { abandonPendingPlan } from "../files/mutation-plan";
import { turnController } from "../runtime/controller-service";
import { turnDispatcher } from "../runtime/queue-service";
import {
  liveById,
  liveEvents,
  liveTurnForThread,
  requestTurnCancel,
  setTurnCancelHandler,
} from "../runtime/turn-session";

const chatRequestSchema = z
  .object({
    threadId: persistedThreadIdSchema,
    parentId: persistedThreadIdSchema.optional(),
    assistantMessageId: z.string().min(1).max(128),
    system: z.string().max(50_000).optional(),
    messages: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128).optional(),
            role: z.enum(["user", "assistant"]),
            content: z.string().max(500_000),
          })
          .strict(),
      )
      .max(200),
    settings: chatSettingsSchema.optional(),
    queueItemId: z.string().uuid().optional(),
    source: z.enum(["typed", "voice"]).optional(),
    attachmentIds: z.array(z.string().uuid()).max(8).optional(),
  })
  .strict();

export function registerAssistantStreamIpc(mainWindow: BrowserWindow): void {
  const dispatcher = turnDispatcher();
  const controller = turnController();
  const trusted = (
    event: Pick<IpcMainEvent, "sender" | "senderFrame">,
  ): void => {
    if (
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      throw new Error("Untrusted IPC sender");
  };
  dispatcher.setOnPromoted((item) => {
    const turnId = randomUUID();
    const send = (event?: ChatEvent): void => {
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.send(IPC_CHANNELS.turnStarted, {
          threadId: item.threadId,
          queueItemId: item.id,
          turnId,
          text: item.text,
          attachmentRefs: item.attachmentRefs,
          ...(event ? { event } : {}),
        });
    };
    send();
    try {
      controller.admitTurn(
        {
          turnId,
          threadId: item.threadId,
          userMessageId: item.id,
          assistantMessageId: randomUUID(),
          queueItemId: item.id,
          source: item.source,
          admission: "promoted",
          text: item.text,
          ...(item.branchAnchor ? { branchAnchor: item.branchAnchor } : {}),
          attachmentIds: item.attachmentRefs.map((ref) => ref.id),
        },
        send,
      );
    } catch (error) {
      dispatcher.setServiceHold(
        error instanceof Error ? error.message : "Turn admission failed.",
      );
    }
  });
  setTurnCancelHandler((turnId) => {
    const live = liveById(turnId);
    if (live?.operationId) abandonPendingPlan(getDatabase(), live.operationId);
    // Cancellation requests abort work. Only the Controller may release the slot.
  });
  ipcMain.handle(IPC_CHANNELS.turnCancel, (event) => {
    trusted(event);
    return { ok: requestTurnCancel() };
  });
  ipcMain.handle(IPC_CHANNELS.turnRetrySaving, (event, payload: unknown) => {
    trusted(event);
    return controller.retryFinalization(
      z
        .object({
          turnId: z.string().uuid(),
          threadId: persistedThreadIdSchema,
          assistantMessageId: z.string().min(1).max(128),
        })
        .strict()
        .parse(payload),
    );
  });
  ipcMain.handle(IPC_CHANNELS.turnSnapshot, (event, threadId: unknown) => {
    trusted(event);
    if (typeof threadId !== "string") return null;
    const live = liveTurnForThread(threadId);
    return live
      ? {
          turnId: live.turnId,
          threadId: live.threadId,
          queueItemId: live.queueItemId,
          userText: live.userText,
          userMessageId: live.userMessageId ?? null,
          assistantMessageId: live.assistantMessageId,
          events: liveEvents(live.turnId),
        }
      : null;
  });
  const handleStream = (event: IpcMainEvent, request: unknown): void => {
    const [port] = event.ports;
    if (!port) return;
    try {
      trusted(event);
    } catch {
      port.close();
      return;
    }
    port.start();
    const send = (message: ChatEvent): void => {
      try {
        port.postMessage(message);
        if (message.type === "done") port.close();
      } catch {
        /* Observation closure never cancels execution. */
      }
    };
    try {
      const parsed = chatRequestSchema.parse(request);
      const latest = parsed.messages.at(-1);
      if (!latest || latest.role !== "user")
        throw new Error("A turn needs a user message.");
      const admission = controller.admitTurn(
        {
          threadId: parsed.threadId,
          userMessageId: latest.id ?? parsed.parentId ?? randomUUID(),
          assistantMessageId: parsed.assistantMessageId,
          ...(parsed.messages.at(-2)?.id
            ? { branchAnchor: parsed.messages.at(-2)!.id }
            : {}),
          ...(parsed.queueItemId ? { queueItemId: parsed.queueItemId } : {}),
          source:
            (parsed.queueItemId
              ? dispatcher.queuedSource(parsed.queueItemId)
              : null) ?? "typed",
          admission: "immediate",
          text: latest.content,
          attachmentIds: parsed.attachmentIds ?? [],
        },
        send,
      );
      port.once("close", admission.detach);
    } catch (error) {
      send({
        type: "error",
        message:
          error instanceof Error ? error.message : "Invalid chat request.",
      });
      port.close();
    }
  };
  ipcMain.on(ASSISTANT_STREAM_CHANNEL, handleStream);
  mainWindow.once("closed", () => {
    ipcMain.removeListener(ASSISTANT_STREAM_CHANNEL, handleStream);
    dispatcher.setOnPromoted(null);
  });
}
