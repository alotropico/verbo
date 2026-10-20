import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { WindowState } from "../../shared/window-controls";
import { registerWindowIpc } from "./window-ipc";

type StateHandler = (
  event: IpcMainInvokeEvent,
  text?: unknown,
) => WindowState | void;
type CommandHandler = (event: IpcMainEvent) => void;

const ipc = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: StateHandler) => void>(),
  on: vi.fn<(channel: string, handler: CommandHandler) => void>(),
  removeHandler: vi.fn<(channel: string) => void>(),
  removeListener: vi.fn<(channel: string, handler: CommandHandler) => void>(),
  writeText: vi.fn<(text: string) => void>(),
}));

vi.mock("electron", () => ({
  ipcMain: ipc,
  clipboard: { writeText: ipc.writeText },
}));

type WindowFixture = {
  window: EventEmitter & {
    webContents: {
      mainFrame: object;
      send: Mock<(channel: string, state: WindowState) => void>;
    };
    isMaximized: () => boolean;
    minimize: Mock<() => void>;
    maximize: Mock<() => void>;
    unmaximize: Mock<() => void>;
    close: Mock<() => void>;
  };
  trusted: IpcMainEvent;
  command: (channel: string, event?: IpcMainEvent) => void;
  read: (event?: IpcMainEvent) => WindowState;
};

function createWindow(): WindowFixture {
  const events = new EventEmitter();
  let maximized = false;
  const window = Object.assign(events, {
    webContents: {
      mainFrame: {},
      send: vi.fn<(channel: string, state: WindowState) => void>(),
    },
    isMaximized: () => maximized,
    minimize: vi.fn(),
    maximize: vi.fn(() => {
      maximized = true;
      events.emit("maximize");
    }),
    unmaximize: vi.fn(() => {
      maximized = false;
      events.emit("unmaximize");
    }),
    close: vi.fn(() => {
      events.emit("closed");
    }),
  });
  registerWindowIpc(window as unknown as BrowserWindow);
  const trusted = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  } as unknown as IpcMainEvent;
  const command = (channel: string, event = trusted): void => {
    const handler = ipc.on.mock.calls.find(([name]) => name === channel)?.[1];
    if (!handler) throw new Error(`Missing command: ${channel}`);
    handler(event);
  };
  const read = (event = trusted): WindowState => {
    const handler = ipc.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.windowState,
    )?.[1];
    if (!handler) throw new Error("Missing window state handler");
    return handler(event as unknown as IpcMainInvokeEvent) as WindowState;
  };
  return { window, trusted, command, read };
}

describe("window controls IPC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("minimizes, toggles maximize/restore, and closes the owning window", () => {
    const { window, command, read } = createWindow();
    expect(read()).toEqual({
      nativeControls: process.platform === "darwin",
      maximized: false,
    });
    command(IPC_CHANNELS.windowMinimize);
    expect(window.minimize).toHaveBeenCalledTimes(1);
    command(IPC_CHANNELS.windowToggleMaximize);
    expect(read().maximized).toBe(true);
    command(IPC_CHANNELS.windowToggleMaximize);
    expect(read().maximized).toBe(false);
    command(IPC_CHANNELS.windowClose);
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it("acknowledges text writes from the owning main frame and rejects invalid requests", () => {
    const { trusted } = createWindow();
    const handler = ipc.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.clipboardWrite,
    )?.[1];
    if (!handler) throw new Error("Missing clipboard handler");
    const event = trusted as unknown as IpcMainInvokeEvent;
    expect(handler(event, '{"ok":true}')).toBeUndefined();
    expect(ipc.writeText).toHaveBeenCalledWith('{"ok":true}');
    ipc.writeText.mockClear();
    expect(() =>
      handler({ ...event, sender: {} } as IpcMainInvokeEvent, "nope"),
    ).toThrow("Untrusted clipboard");
    expect(() =>
      handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, "nope"),
    ).toThrow("Untrusted clipboard");
    expect(() => handler(event, 12)).toThrow("Clipboard text must be a string");
    expect(ipc.writeText).not.toHaveBeenCalled();
    expect(handler(event, "")).toBeUndefined();
    expect(ipc.writeText).toHaveBeenCalledWith("");
  });

  it("propagates native clipboard failures instead of reporting success", () => {
    const { trusted } = createWindow();
    const handler = ipc.handle.mock.calls.find(
      ([name]) => name === IPC_CHANNELS.clipboardWrite,
    )?.[1];
    if (!handler) throw new Error("Missing clipboard handler");
    ipc.writeText.mockImplementationOnce(() => {
      throw new Error("Clipboard unavailable");
    });
    expect(() =>
      handler(trusted as unknown as IpcMainInvokeEvent, "text"),
    ).toThrow("Clipboard unavailable");
  });

  it("rejects other windows and subframes for all operations", () => {
    const { window, trusted, command, read } = createWindow();
    const untrusted = [
      { ...trusted, sender: {} },
      { ...trusted, senderFrame: {} },
    ] as unknown as IpcMainEvent[];
    for (const event of untrusted) {
      expect(() => read(event)).toThrow("Untrusted window IPC sender");
      command(IPC_CHANNELS.windowMinimize, event);
      command(IPC_CHANNELS.windowToggleMaximize, event);
      command(IPC_CHANNELS.windowClose, event);
    }
    expect(window.minimize.mock.calls.length).toBe(0);
    expect(window.maximize.mock.calls.length).toBe(0);
    expect(window.close.mock.calls.length).toBe(0);
  });

  it("publishes state changes originating outside the renderer controls", () => {
    const { window } = createWindow();
    window.maximize();
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.windowStateChanged,
      { nativeControls: process.platform === "darwin", maximized: true },
    );
    window.unmaximize();
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.windowStateChanged,
      { nativeControls: process.platform === "darwin", maximized: false },
    );
  });

  it("removes only its owned listeners when the window closes", () => {
    const { window } = createWindow();
    const otherObserver = vi.fn();
    window.on("maximize", otherObserver);
    window.close();
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.windowState);
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.clipboardWrite);
    expect(ipc.removeListener.mock.calls).toEqual(ipc.on.mock.calls);
    expect(window.listenerCount("unmaximize")).toBe(0);
    expect(window.listenerCount("maximize")).toBe(1);
    window.emit("maximize");
    expect(otherObserver).toHaveBeenCalledTimes(1);
    expect(window.webContents.send.mock.calls.length).toBe(0);
  });
});
