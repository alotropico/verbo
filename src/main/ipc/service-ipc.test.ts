import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { ServiceView } from "../services/service-manager";
import { registerServiceIpc } from "./service-ipc";

type InvokeHandler = (event: IpcMainInvokeEvent, payload?: unknown) => Promise<unknown>;

const ipc = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: InvokeHandler) => void>(),
  removeHandler: vi.fn<(channel: string) => void>(),
}));

const managerMock = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const snapshot = vi.fn();
  return {
    start,
    stop,
    snapshot,
    serviceManager: vi.fn(async () => ({
      start,
      stop,
      snapshot,
    })),
  };
});

const runtimeMock = vi.hoisted(() => ({
  setServiceHold: vi.fn(),
  requestTurnCancel: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "C:/fake-app-path" },
  ipcMain: ipc,
}));

vi.mock("../services/service-host", () => ({
  serviceManager: managerMock.serviceManager,
}));

vi.mock("../runtime/turn-session", () => ({
  requestTurnCancel: runtimeMock.requestTurnCancel,
}));

vi.mock("../runtime/queue-service", () => ({
  turnDispatcher: () => ({
    setServiceHold: runtimeMock.setServiceHold,
  }),
}));

function createFixture(): {
  window: EventEmitter & { webContents: { mainFrame: object } };
  invoke: (channel: string, payload?: unknown, eventOverrides?: Partial<IpcMainInvokeEvent>) => Promise<unknown>;
} {
  const window = Object.assign(new EventEmitter(), {
    webContents: {
      mainFrame: {},
    },
  });
  registerServiceIpc(window as unknown as BrowserWindow);

  const invoke = async (channel: string, payload?: unknown, eventOverrides?: Partial<IpcMainInvokeEvent>): Promise<unknown> => {
    const handler = ipc.handle.mock.calls.find(([name]) => name === channel)?.[1];
    if (!handler) throw new Error(`Missing handler for ${channel}`);
    const defaultEvent: Partial<IpcMainInvokeEvent> = {
      sender: window.webContents as IpcMainInvokeEvent["sender"],
      senderFrame: window.webContents.mainFrame as IpcMainInvokeEvent["senderFrame"],
    };
    return handler({ ...defaultEvent, ...eventOverrides } as IpcMainInvokeEvent, payload);
  };

  return { window, invoke };
}

describe("service IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers snapshot, start, and stop handlers", () => {
    createFixture();
    const registered = ipc.handle.mock.calls.map(([name]) => name);
    expect(registered).toContain(IPC_CHANNELS.servicesSnapshot);
    expect(registered).toContain(IPC_CHANNELS.servicesStart);
    expect(registered).toContain(IPC_CHANNELS.servicesStop);
  });

  it("rejects untrusted sender or frame", async () => {
    const { invoke } = createFixture();
    await expect(invoke(IPC_CHANNELS.servicesSnapshot, undefined, { sender: {} as IpcMainInvokeEvent["sender"] })).rejects.toThrow(
      "Untrusted IPC sender",
    );

    await expect(
      invoke(IPC_CHANNELS.servicesSnapshot, undefined, { senderFrame: {} as IpcMainInvokeEvent["senderFrame"] }),
    ).rejects.toThrow("Untrusted IPC frame");
  });

  it("rejects unknown service names", async () => {
    const { invoke } = createFixture();
    await expect(invoke(IPC_CHANNELS.servicesStart, { name: "invalid-service" })).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.servicesStop, { name: "unknown" })).rejects.toThrow();
  });

  it("routes web start without modifying chat hold", async () => {
    const { invoke } = createFixture();
    const webView: ServiceView = {
      name: "web",
      state: "ready",
      owned: true,
      reused: false,
      identity: "verbo-web",
      pid: 1234,
      error: null,
      suppressed: false,
      detail: "Web started.",
    };
    managerMock.start.mockResolvedValueOnce(webView);

    const result = await invoke(IPC_CHANNELS.servicesStart, { name: "web" });
    expect(result).toEqual(webView);
    expect(managerMock.start).toHaveBeenCalledWith("web");
    expect(runtimeMock.setServiceHold).not.toHaveBeenCalled();
  });

  it("routes web stop without cancelling turns or setting service hold", async () => {
    const { invoke } = createFixture();
    const stoppedResult = {
      ok: true,
      service: {
        name: "web" as const,
        state: "stopped" as const,
        owned: false,
        reused: false,
        identity: null,
        pid: null,
        error: null,
        suppressed: true,
        detail: "Web search is stopped. Start it to search.",
      },
    };
    managerMock.stop.mockResolvedValueOnce(stoppedResult);

    const result = await invoke(IPC_CHANNELS.servicesStop, { name: "web" });
    expect(result).toEqual(stoppedResult);
    expect(managerMock.stop).toHaveBeenCalledWith("web");
    expect(runtimeMock.setServiceHold).not.toHaveBeenCalled();
    expect(runtimeMock.requestTurnCancel).not.toHaveBeenCalled();
  });

  it("routes ollama stop and sets service hold and cancels turn", async () => {
    const { invoke } = createFixture();
    const stoppedOllama = {
      ok: true,
      service: {
        name: "ollama" as const,
        state: "stopped" as const,
        owned: false,
        reused: false,
        identity: null,
        pid: null,
        error: null,
        suppressed: true,
        detail: "Ollama is stopped.",
      },
    };
    managerMock.stop.mockResolvedValueOnce(stoppedOllama);

    const result = await invoke(IPC_CHANNELS.servicesStop, { name: "ollama" });
    expect(result).toEqual(stoppedOllama);
    expect(managerMock.stop).toHaveBeenCalledWith("ollama");
    expect(runtimeMock.setServiceHold).toHaveBeenCalledWith("Ollama is stopped. Start it to send this message.");
    expect(runtimeMock.requestTurnCancel).toHaveBeenCalledTimes(1);
  });

  it("removes handlers on window close", () => {
    const { window } = createFixture();
    window.emit("closed");
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.servicesSnapshot);
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.servicesStart);
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.servicesStop);
  });
});
