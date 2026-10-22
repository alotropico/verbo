import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ChatTurnStop } from "../shared/chat-ipc";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { closeLiveTurn, openLiveTurn, publishLive, subscribeLive } from "./runtime/turn-session";
import { registerReplyNotifications } from "./reply-notifications";
import type { ReplyAttentionStore } from "./reply-attention-store";

const ipc = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) => ipc.set(channel, listener),
    removeListener: (channel: string) => ipc.delete(channel),
  },
}));
beforeEach(() => ipc.clear());

const windows: EventEmitter[] = [];
const turns: string[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.emit("closed");
  for (const turnId of turns.splice(0)) closeLiveTurn(turnId);
});

function setup(store?: ReplyAttentionStore, enabled = true): EventEmitter & {
  isDestroyed: Mock<() => boolean>;
  isFocused: Mock<() => boolean>;
  flashFrame: Mock;
  setIcon: Mock;
  forgetThread: (threadId: string) => void;
  webContents: EventEmitter & { send: Mock; mainFrame: object };
} {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    flashFrame: vi.fn(),
    setIcon: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { send: vi.fn(), mainFrame: {} }),
  });
  windows.push(window);
  const notifications = registerReplyNotifications(window as unknown as BrowserWindow, {
    iconDirectory: "icons",
    platform: "win32",
    store,
    enabled,
  });
  return Object.assign(window, notifications);
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

function visible(window: ReturnType<typeof setup>, threadId: string | null): void {
  ipc.get(IPC_CHANNELS.replyVisibleThread)?.({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, threadId);
}
const icon = (state?: string): string => (state ? join("icons", "replies", state, "icon.ico") : join("icons", "icon.ico"));

describe("background reply notifications", () => {
  it("does not subscribe or request attention when presentation is disabled", () => {
    const load = vi.fn(() => []);
    const save = vi.fn();
    const window = setup({ load, save }, false);
    finishTurn(startTurn("hidden"));
    expect(ipc.size).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(window.flashFrame).not.toHaveBeenCalled();
    expect(window.setIcon).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalled();
    window.forgetThread("thread-hidden");
  });

  it("restores persisted unread status and saves it when the chat is read", () => {
    const save = vi.fn();
    const window = setup({ load: () => [{ turnId: "prior", threadId: "chat", state: "error" }], save });
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("error"));
    window.isFocused.mockReturnValue(true);
    visible(window, "chat");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon());
    expect(save).toHaveBeenLastCalledWith([]);
  });
  it("persists replies even when their shared color does not change and forgets removed chats", () => {
    const save = vi.fn();
    const window = setup({ load: () => [], save });
    finishTurn(startTurn("first"));
    finishTurn(startTurn("second"));
    expect(save.mock.lastCall?.[0]).toHaveLength(2);
    window.forgetThread("thread-first");
    expect(save.mock.lastCall?.[0]).toHaveLength(1);
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("success"));
    window.forgetThread("thread-second");
    expect(save).toHaveBeenLastCalledWith([]);
    expect(window.setIcon).toHaveBeenLastCalledWith(icon());
  });
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
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.replyNotification);
    // Attaching a new UI observer must not repeat the alert.
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("success"));
    subscribeLive(turnId, vi.fn())();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("keeps foreground replies quiet and clears attention on focus", () => {
    const window = setup();
    finishTurn(startTurn("background"));
    visible(window, "thread-background");
    window.isFocused.mockReturnValue(true);
    window.emit("focus");
    expect(window.flashFrame).toHaveBeenLastCalledWith(false);
    expect(window.setIcon).toHaveBeenLastCalledWith(icon());
    visible(window, "thread-foreground");
    finishTurn(startTurn("foreground"));
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    expect(window.flashFrame).toHaveBeenCalledTimes(2);
  });

  it.each(["cancelled", "failed"] as const)("shows red without playing the reply sound for %s turns", (stop) => {
    const window = setup();
    finishTurn(startTurn(), stop);
    expect(window.flashFrame).toHaveBeenCalledWith(true);
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("error"));
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

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
    expect(window.webContents.listenerCount("did-start-loading")).toBe(0);
    expect(ipc.has(IPC_CHANNELS.replyVisibleThread)).toBe(false);
  });

  it("keeps other chats unread when the window gains focus", () => {
    const window = setup();
    visible(window, "thread-current");
    finishTurn(startTurn("other"));
    window.isFocused.mockReturnValue(true);
    window.emit("focus");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("success"));
    visible(window, "thread-other");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon());
  });
  it("keeps foreground replies quiet only when that chat is visible", () => {
    const window = setup();
    window.isFocused.mockReturnValue(true);
    visible(window, "thread-current");
    finishTurn(startTurn("current"));
    expect(window.setIcon).not.toHaveBeenCalled();
    visible(window, null);
    finishTurn(startTurn("settings"));
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("success"));
    expect(window.flashFrame).not.toHaveBeenCalled();
  });
  it("prioritizes questions, errors and partial replies, clearing only viewed chats", () => {
    const window = setup();
    finishTurn(startTurn("success"));
    finishTurn(startTurn("partial"), "limit");
    finishTurn(startTurn("error"), "failed");
    publishLive(startTurn("question"), { type: "input_required" });
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("question"));
    window.isFocused.mockReturnValue(true);
    visible(window, "thread-question");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("error"));
    visible(window, "thread-error");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("partial"));
    visible(window, "thread-partial");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("success"));
    visible(window, "thread-success");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon());
  });
  it("shows approval blue immediately and replaces it after resolution", () => {
    const window = setup();
    const turn = startTurn();
    const common = { toolCallId: "call", name: "actions.invoke", args: {} };
    publishLive(turn, {
      ...common,
      type: "approval",
      result: { action: "files.move", status: "requires_confirmation", summary: "Approve" },
    });
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("question"));
    publishLive(turn, { ...common, type: "tool_result", result: { action: "files.move", status: "success", summary: "Moved" } });
    expect(window.setIcon).toHaveBeenLastCalledWith(icon());
    finishTurn(turn);
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("success"));
  });
  it("rejects foreign frames and malformed visible-chat messages", () => {
    const window = setup();
    finishTurn(startTurn());
    window.isFocused.mockReturnValue(true);
    for (const event of [
      { sender: {}, senderFrame: window.webContents.mainFrame },
      { sender: window.webContents, senderFrame: {} },
    ]) {
      ipc.get(IPC_CHANNELS.replyVisibleThread)?.(event, "thread-turn");
    }
    ipc.get(IPC_CHANNELS.replyVisibleThread)?.({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, {});
    window.emit("focus");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("success"));
  });
  it("retains unread replies across renderer reloads and deduplicates completion", () => {
    const window = setup();
    const turn = startTurn();
    finishTurn(turn);
    publishLive(turn, { type: "done" });
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    visible(window, "thread-turn");
    window.webContents.emit("did-start-loading");
    window.isFocused.mockReturnValue(true);
    window.emit("focus");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon("success"));
    visible(window, "thread-turn");
    expect(window.setIcon).toHaveBeenLastCalledWith(icon());
    publishLive(turn, { type: "done" });
    expect(window.setIcon).toHaveBeenLastCalledWith(icon());
  });
});
