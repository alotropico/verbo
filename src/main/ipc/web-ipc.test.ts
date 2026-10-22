import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { WebStatus } from "../../shared/web";
import type { WebSettings } from "../../shared/web-settings";
import { registerWebIpc } from "./web-ipc";

type InvokeHandler = (event: IpcMainInvokeEvent, payload?: unknown) => unknown;

const ipc = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: InvokeHandler) => void>(),
  removeHandler: vi.fn<(channel: string) => void>(),
}));

const settingsMock = vi.hoisted(() => ({
  loadWebSettings: vi.fn<() => WebSettings>(),
  saveWebSettings: vi.fn<(settings: WebSettings) => WebSettings>(),
}));

const clientMock = vi.hoisted(() => ({
  webClient: vi.fn(() => ({
    status: vi.fn<() => Promise<WebStatus>>(),
  })),
}));

vi.mock("electron", () => ({
  ipcMain: ipc,
}));

vi.mock("../web/settings-store", () => ({
  loadWebSettings: settingsMock.loadWebSettings,
  saveWebSettings: settingsMock.saveWebSettings,
}));

vi.mock("../web/client", () => ({
  webClient: clientMock.webClient,
}));

function createFixture(): {
  window: EventEmitter & { webContents: { mainFrame: object } };
  invoke: (channel: string, payload?: unknown, event?: Partial<IpcMainInvokeEvent>) => unknown;
} {
  const window = Object.assign(new EventEmitter(), {
    webContents: {
      mainFrame: {},
    },
  });
  registerWebIpc(window as unknown as BrowserWindow);

  const invoke = (channel: string, payload?: unknown, eventOverrides?: Partial<IpcMainInvokeEvent>): unknown => {
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

describe("web IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers handlers for settings get/set and status", () => {
    createFixture();
    const registered = ipc.handle.mock.calls.map(([name]) => name);
    expect(registered).toContain(IPC_CHANNELS.webSettingsGet);
    expect(registered).toContain(IPC_CHANNELS.webSettingsSet);
    expect(registered).toContain(IPC_CHANNELS.webStatus);
  });

  it("rejects untrusted sender or frame", async () => {
    const { invoke } = createFixture();
    expect(() => invoke(IPC_CHANNELS.webSettingsGet, undefined, { sender: {} as IpcMainInvokeEvent["sender"] })).toThrow(
      "Untrusted IPC sender",
    );

    expect(() => invoke(IPC_CHANNELS.webSettingsGet, undefined, { senderFrame: {} as IpcMainInvokeEvent["senderFrame"] })).toThrow(
      "Untrusted IPC frame",
    );
  });

  it("handles getSettings via loadWebSettings", () => {
    const { invoke } = createFixture();
    const fakeSettings: WebSettings = {
      engines: ["duckduckgo", "brave"],
      pageSize: 5,
      maxSnippetChars: 240,
      timeoutMs: 8000,
    };
    settingsMock.loadWebSettings.mockReturnValueOnce(fakeSettings);

    const result = invoke(IPC_CHANNELS.webSettingsGet);
    expect(result).toEqual(fakeSettings);
    expect(settingsMock.loadWebSettings).toHaveBeenCalledTimes(1);
  });

  it("handles setSettings with validation; rejects invalid payloads without writing", () => {
    const { invoke } = createFixture();
    const valid: WebSettings = {
      engines: ["duckduckgo", "google"],
      pageSize: 8,
      maxSnippetChars: 300,
      timeoutMs: 10000,
    };
    settingsMock.saveWebSettings.mockReturnValueOnce(valid);

    const result = invoke(IPC_CHANNELS.webSettingsSet, valid);
    expect(result).toEqual(valid);
    expect(settingsMock.saveWebSettings).toHaveBeenCalledWith(valid);

    // Invalid payload: empty engines
    expect(() => invoke(IPC_CHANNELS.webSettingsSet, { ...valid, engines: [] })).toThrow();
    // Invalid payload: out of range pageSize
    expect(() => invoke(IPC_CHANNELS.webSettingsSet, { ...valid, pageSize: 0 })).toThrow();
    // Invalid payload: extra unknown key (strict)
    expect(() => invoke(IPC_CHANNELS.webSettingsSet, { ...valid, unknownKey: true })).toThrow();

    // Verify saveWebSettings was not called for invalid payloads
    expect(settingsMock.saveWebSettings).toHaveBeenCalledTimes(1);
  });

  it("handles web status without exposing secrets", async () => {
    const { invoke } = createFixture();
    const statusResult: WebStatus = {
      ok: true,
      identity: "verbo-web",
      apiVersion: "1",
      ready: true,
      engines: ["duckduckgo", "brave", "bing"],
    };
    const mockStatusFn = vi.fn<() => Promise<WebStatus>>().mockResolvedValue(statusResult);
    clientMock.webClient.mockReturnValueOnce({
      status: mockStatusFn,
    });

    const result = await invoke(IPC_CHANNELS.webStatus);
    expect(result).toEqual(statusResult);
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("secret");
  });

  it("removes handlers on window close", () => {
    const { window } = createFixture();
    window.emit("closed");
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.webSettingsGet);
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.webSettingsSet);
    expect(ipc.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.webStatus);
  });
});
