import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import {
  attachmentAddSchema,
  attachmentIdSchema,
  attachmentPreviewSchema,
  type AttachmentAddResult,
  type AttachmentPreview,
} from "../../shared/attachments";
import { getDatabase } from "../db/database";
import { createAssetStore, type AssetStore } from "../files/asset-store";

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

function store(): AssetStore {
  return createAssetStore(
    getDatabase(),
    join(app.getPath("userData"), "attachments"),
  );
}

export function registerAttachmentIpc(mainWindow: BrowserWindow): void {
  const add = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): AttachmentAddResult => {
    assertTrustedWindow(event, mainWindow);
    const data = attachmentAddSchema.parse(payload);
    const bytes = Buffer.from(data.bytesBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== data.bytesBase64) {
      return {
        ok: false,
        code: "invalid",
        summary: "That attachment could not be read.",
      };
    }
    return store().put({
      threadId: data.threadId,
      name: data.name,
      mediaType: data.mediaType,
      bytes,
    });
  };
  const remove = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): { ok: true } | { ok: false; summary: string } => {
    assertTrustedWindow(event, mainWindow);
    const data = attachmentIdSchema.parse(payload);
    const removed = store().remove(data.threadId, data.id);
    return removed
      ? { ok: true }
      : { ok: false, summary: "That attachment is not in this conversation." };
  };
  const preview = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): AttachmentPreview => {
    assertTrustedWindow(event, mainWindow);
    const data = attachmentPreviewSchema.parse(payload);
    const image = store().preview(data.id);
    if (!image) {
      return { ok: false, code: "missing", summary: "No image preview." };
    }
    return {
      ok: true,
      mediaType: image.mediaType,
      dataUrl: `data:${image.mediaType};base64,${image.bytes.toString("base64")}`,
    };
  };

  ipcMain.handle(IPC_CHANNELS.attachmentsAdd, add);
  ipcMain.handle(IPC_CHANNELS.attachmentsRemove, remove);
  ipcMain.handle(IPC_CHANNELS.attachmentsPreview, preview);
  mainWindow.once("closed", () => {
    ipcMain.removeHandler(IPC_CHANNELS.attachmentsAdd);
    ipcMain.removeHandler(IPC_CHANNELS.attachmentsRemove);
    ipcMain.removeHandler(IPC_CHANNELS.attachmentsPreview);
  });
}
