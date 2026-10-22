import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { WebStatus } from "../../shared/web";
import { webSettingsSchema, type WebSettings } from "../../shared/web-settings";
import { webClient } from "../web/client";
import { loadWebSettings, saveWebSettings } from "../web/settings-store";

function assertTrustedWindow(event: IpcMainInvokeEvent, mainWindow: BrowserWindow): void {
  if (event.sender !== mainWindow.webContents) {
    throw new Error("Untrusted IPC sender");
  }
  if (event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC frame");
  }
}

export function registerWebIpc(mainWindow: BrowserWindow): void {
  const getSettings = (event: IpcMainInvokeEvent): WebSettings => {
    assertTrustedWindow(event, mainWindow);
    return loadWebSettings();
  };

  const setSettings = (event: IpcMainInvokeEvent, payload: unknown): WebSettings => {
    assertTrustedWindow(event, mainWindow);
    const data = webSettingsSchema.parse(payload);
    return saveWebSettings(data);
  };

  const status = (event: IpcMainInvokeEvent): Promise<WebStatus> => {
    assertTrustedWindow(event, mainWindow);
    return webClient().status();
  };

  ipcMain.handle(IPC_CHANNELS.webSettingsGet, getSettings);
  ipcMain.handle(IPC_CHANNELS.webSettingsSet, setSettings);
  ipcMain.handle(IPC_CHANNELS.webStatus, status);

  mainWindow.once("closed", () => {
    ipcMain.removeHandler(IPC_CHANNELS.webSettingsGet);
    ipcMain.removeHandler(IPC_CHANNELS.webSettingsSet);
    ipcMain.removeHandler(IPC_CHANNELS.webStatus);
  });
}
