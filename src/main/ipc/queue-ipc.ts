import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import {
  queueEditBeginSchema,
  queueEditCancelSchema,
  queueEditSaveSchema,
  queueEnqueueSchema,
  queueItemSchema,
  queueReorderSchema,
  queueThreadSchema,
  type QueueClaimResult,
  type QueueEnqueueResult,
  type QueueMutationResult,
  type QueueSnapshot,
} from "../../shared/turn-queue";
import { subscribeTurnQueue, turnDispatcher } from "../runtime/queue-service";

function assertTrustedWindow(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
): void {
  if (event.sender !== mainWindow.webContents) {
    throw new Error("Untrusted IPC sender");
  }
  if (event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC frame");
  }
}

export function registerQueueIpc(mainWindow: BrowserWindow): void {
  const unsubscribe = subscribeTurnQueue(() => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(IPC_CHANNELS.queueChanged);
  });

  const list = (event: IpcMainInvokeEvent, payload: unknown): QueueSnapshot => {
    assertTrustedWindow(event, mainWindow);
    const data = queueThreadSchema.parse(payload);
    return turnDispatcher().snapshot(data.threadId);
  };
  const enqueue = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): QueueEnqueueResult => {
    assertTrustedWindow(event, mainWindow);
    const data = queueEnqueueSchema.parse(payload);
    return turnDispatcher().enqueue(data);
  };
  const claim = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): QueueClaimResult => {
    assertTrustedWindow(event, mainWindow);
    const data = queueThreadSchema.parse(payload);
    return turnDispatcher().claim(data.threadId);
  };
  const remove = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): QueueMutationResult => {
    assertTrustedWindow(event, mainWindow);
    const data = queueItemSchema.parse(payload);
    return turnDispatcher().remove(data.id);
  };
  const acknowledge = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): QueueMutationResult => {
    assertTrustedWindow(event, mainWindow);
    const data = queueItemSchema.parse(payload);
    return turnDispatcher().acknowledge(data.id);
  };
  const discard = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): QueueMutationResult => {
    assertTrustedWindow(event, mainWindow);
    const data = queueItemSchema.parse(payload);
    return turnDispatcher().discard(data.id);
  };
  const rebind = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): QueueMutationResult => {
    assertTrustedWindow(event, mainWindow);
    const data = queueItemSchema.parse(payload);
    return turnDispatcher().rebind(data.id);
  };
  const sendAgain = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): QueueMutationResult => {
    assertTrustedWindow(event, mainWindow);
    const data = queueItemSchema.parse(payload);
    return turnDispatcher().sendAgain(data.id);
  };
  const clear = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): QueueMutationResult => {
    assertTrustedWindow(event, mainWindow);
    const data = queueThreadSchema.parse(payload);
    return turnDispatcher().clearPending(data.threadId);
  };
  const releaseHold = (event: IpcMainInvokeEvent): { ok: true } => {
    assertTrustedWindow(event, mainWindow);
    turnDispatcher().releaseHold();
    return { ok: true as const };
  };
  const release = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): { ok: true } => {
    assertTrustedWindow(event, mainWindow);
    const data = queueItemSchema.parse(payload);
    turnDispatcher().releaseReservation(data.id);
    return { ok: true as const };
  };

  ipcMain.handle(IPC_CHANNELS.queueList, list);
  ipcMain.handle(IPC_CHANNELS.queueEnqueue, enqueue);
  ipcMain.handle(IPC_CHANNELS.queueClaim, claim);
  ipcMain.handle(IPC_CHANNELS.queueRemove, remove);
  ipcMain.handle(IPC_CHANNELS.queueAcknowledge, acknowledge);
  ipcMain.handle(IPC_CHANNELS.queueDiscard, discard);
  ipcMain.handle(IPC_CHANNELS.queueRebind, rebind);
  ipcMain.handle(IPC_CHANNELS.queueSendAgain, sendAgain);
  ipcMain.handle(IPC_CHANNELS.queueClear, clear);
  ipcMain.handle(IPC_CHANNELS.queueReleaseHold, releaseHold);
  ipcMain.handle(IPC_CHANNELS.queueRelease, release);
  ipcMain.handle(IPC_CHANNELS.queueEditBegin, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return turnDispatcher().beginEdit(queueEditBeginSchema.parse(payload));
  });
  ipcMain.handle(IPC_CHANNELS.queueEditSave, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return turnDispatcher().saveEdit(queueEditSaveSchema.parse(payload));
  });
  ipcMain.handle(IPC_CHANNELS.queueEditCancel, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return turnDispatcher().cancelEdit(queueEditCancelSchema.parse(payload));
  });
  ipcMain.handle(IPC_CHANNELS.queueReorder, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return turnDispatcher().reorder(queueReorderSchema.parse(payload));
  });

  mainWindow.once("closed", () => {
    unsubscribe();
    ipcMain.removeHandler(IPC_CHANNELS.queueList);
    ipcMain.removeHandler(IPC_CHANNELS.queueEnqueue);
    ipcMain.removeHandler(IPC_CHANNELS.queueClaim);
    ipcMain.removeHandler(IPC_CHANNELS.queueRemove);
    ipcMain.removeHandler(IPC_CHANNELS.queueAcknowledge);
    ipcMain.removeHandler(IPC_CHANNELS.queueDiscard);
    ipcMain.removeHandler(IPC_CHANNELS.queueRebind);
    ipcMain.removeHandler(IPC_CHANNELS.queueSendAgain);
    ipcMain.removeHandler(IPC_CHANNELS.queueClear);
    ipcMain.removeHandler(IPC_CHANNELS.queueReleaseHold);
    ipcMain.removeHandler(IPC_CHANNELS.queueRelease);
    ipcMain.removeHandler(IPC_CHANNELS.queueEditBegin);
    ipcMain.removeHandler(IPC_CHANNELS.queueEditSave);
    ipcMain.removeHandler(IPC_CHANNELS.queueEditCancel);
    ipcMain.removeHandler(IPC_CHANNELS.queueReorder);
  });
}
