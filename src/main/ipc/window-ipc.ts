import {
  clipboard,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { WindowState } from "../../shared/window-controls";

export function registerWindowIpc(mainWindow: BrowserWindow): void {
  const isTrusted = (
    event: Pick<IpcMainEvent, "sender" | "senderFrame">,
  ): boolean =>
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame;

  const getState = (): WindowState => ({
    nativeControls: process.platform === "darwin",
    maximized: mainWindow.isMaximized(),
  });
  const readState = (event: IpcMainInvokeEvent): WindowState => {
    if (!isTrusted(event)) throw new Error("Untrusted window IPC sender");
    return getState();
  };
  const minimize = (event: IpcMainEvent): void => {
    if (isTrusted(event)) mainWindow.minimize();
  };
  const toggleMaximize = (event: IpcMainEvent): void => {
    if (!isTrusted(event)) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  };
  const close = (event: IpcMainEvent): void => {
    if (isTrusted(event)) mainWindow.close();
  };
  const publishState = (): void => {
    mainWindow.webContents.send(IPC_CHANNELS.windowStateChanged, getState());
  };

  const writeClipboard = (event: IpcMainInvokeEvent, text: unknown): void => {
    if (!isTrusted(event)) throw new Error("Untrusted clipboard IPC sender");
    if (typeof text !== "string")
      throw new Error("Clipboard text must be a string");
    clipboard.writeText(text);
  };

  ipcMain.handle(IPC_CHANNELS.clipboardWrite, writeClipboard);
  ipcMain.handle(IPC_CHANNELS.windowState, readState);
  ipcMain.on(IPC_CHANNELS.windowMinimize, minimize);
  ipcMain.on(IPC_CHANNELS.windowToggleMaximize, toggleMaximize);
  ipcMain.on(IPC_CHANNELS.windowClose, close);
  mainWindow.on("maximize", publishState);
  mainWindow.on("unmaximize", publishState);

  mainWindow.once("closed", () => {
    ipcMain.removeHandler(IPC_CHANNELS.windowState);
    ipcMain.removeHandler(IPC_CHANNELS.clipboardWrite);
    ipcMain.removeListener(IPC_CHANNELS.windowMinimize, minimize);
    ipcMain.removeListener(IPC_CHANNELS.windowToggleMaximize, toggleMaximize);
    ipcMain.removeListener(IPC_CHANNELS.windowClose, close);
    mainWindow.removeListener("maximize", publishState);
    mainWindow.removeListener("unmaximize", publishState);
  });
}
