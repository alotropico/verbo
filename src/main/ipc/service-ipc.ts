import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import { serviceManager } from "../services/service-host";
import { requestTurnCancel } from "../runtime/turn-session";
import { turnDispatcher } from "../runtime/queue-service";
import type {
  ManagedServiceName,
  ServiceManager,
  ServiceView,
} from "../services/service-manager";

const nameSchema = z.object({ name: z.enum(["ollama", "voice"]) }).strict();

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

export type ServiceSnapshot = {
  ollama: ServiceView;
  voice: ServiceView;
};

export function registerServiceIpc(mainWindow: BrowserWindow): void {
  const manager = (): Promise<ServiceManager> =>
    serviceManager(app.getAppPath());
  ipcMain.handle(
    IPC_CHANNELS.servicesSnapshot,
    async (event): Promise<ServiceSnapshot> => {
      assertTrustedWindow(event, mainWindow);
      return (await manager()).snapshot();
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.servicesStart,
    async (event, payload: unknown): Promise<ServiceView> => {
      assertTrustedWindow(event, mainWindow);
      const data = nameSchema.parse(payload);
      const started = await (await manager()).start(data.name);
      if (data.name === "ollama" && started.state === "ready") {
        turnDispatcher().setServiceHold(null);
      }
      return started;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.servicesStop,
    async (
      event,
      payload: unknown,
    ): Promise<
      | { ok: true; service: ServiceView }
      | { ok: false; summary: string; service: ServiceView }
    > => {
      assertTrustedWindow(event, mainWindow);
      const data = nameSchema.parse(payload);
      if (data.name === "ollama") {
        turnDispatcher().setServiceHold(
          "Ollama is stopped. Start it to send this message.",
        );
        requestTurnCancel();
      }
      return (await manager()).stop(data.name as ManagedServiceName);
    },
  );
  mainWindow.once("closed", () => {
    ipcMain.removeHandler(IPC_CHANNELS.servicesSnapshot);
    ipcMain.removeHandler(IPC_CHANNELS.servicesStart);
    ipcMain.removeHandler(IPC_CHANNELS.servicesStop);
  });
}
