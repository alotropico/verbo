import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ChatTurnStop } from "../shared/chat-ipc";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import {
  closeLiveTurn,
  openLiveTurn,
  publishLive,
  subscribeLive,
} from "./runtime/turn-session";
import { registerReplyNotifications } from "./reply-notifications";

const windows: EventEmitter[] = [];
const turns: string[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.emit("closed");
  for (const turnId of turns.splice(0)) closeLiveTurn(turnId);
});

function setup(): EventEmitter & {
  isDestroyed: Mock<() => boolean>;
  isFocused: Mock<() => boolean>;
  flashFrame: Mock;
  webContents: { send: Mock };
} {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    flashFrame: vi.fn(),
    webContents: { send: vi.fn() },
  });
  windows.push(window);
  registerReplyNotifications(window as unknown as BrowserWindow);
  return window;
}

function startTurn(turnId = "turn"): string {
  turns.push(turnId);
  openLiveTurn({
    turnId,
    threadId: `thread-${turnId}`,
    queueItemId: null,
    assistantMessageId: `assistant-${turnId}`,
    userText: "Hello",
    operationId: null,
    abort: new AbortController(),
  });
  return turnId;
}

function finishTurn(turnId: string, stop: ChatTurnStop = "completed"): void {
  publishLive(turnId, { type: "turn_status", stop });
  publishLive(turnId, { type: "done" });
}

describe("background reply notifications", () => {
  it("waits for completion, then alerts even with no UI observer attached", () => {
    const window = setup();
    const turnId = startTurn();
    const detach = subscribeLive(turnId, vi.fn());
    detach();
    publishLive(turnId, { type: "delta", text: "Reply" });
    publishLive(turnId, { type: "turn_status", stop: "completed" });
    expect(window.flashFrame).not.toHaveBeenCalled();
    publishLive(turnId, { type: "done" });
    expect(window.flashFrame).toHaveBeenCalledExactlyOnceWith(true);
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.replyNotification,
    );
    // Attaching a new UI observer must not repeat the alert.
    subscribeLive(turnId, vi.fn())();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("keeps foreground replies quiet and clears attention on focus", () => {
    const window = setup();
    finishTurn(startTurn("background"));
    window.isFocused.mockReturnValue(true);
    window.emit("focus");
    expect(window.flashFrame).toHaveBeenLastCalledWith(false);
    finishTurn(startTurn("foreground"));
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    expect(window.flashFrame).toHaveBeenCalledTimes(2);
  });

  it.each(["cancelled", "failed"] as const)(
    "does not alert for %s turns",
    (stop) => {
      const window = setup();
      finishTurn(startTurn(), stop);
      expect(window.flashFrame).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalled();
    },
  );

  it("alerts once for each queued response", () => {
    const window = setup();
    finishTurn(startTurn("first"));
    finishTurn(startTurn("second"), "paused");
    expect(window.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("ignores destroyed windows and unsubscribes on close", () => {
    const window = setup();
    window.isDestroyed.mockReturnValue(true);
    finishTurn(startTurn("destroyed"));
    window.isDestroyed.mockReturnValue(false);
    window.emit("closed");
    finishTurn(startTurn("closed"));
    expect(window.flashFrame).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(window.listenerCount("focus")).toBe(0);
  });
});
