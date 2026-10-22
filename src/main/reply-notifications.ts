import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { persistedThreadIdSchema } from "../shared/thread-identity";
import { replyAttention, replyAttentionStates, type ReplyAttention } from "../shared/reply-attention";
import { liveById, liveEvents, subscribeTurnEvents } from "./runtime/turn-session";
import type { ReplyAttentionStore } from "./reply-attention-store";

export function registerReplyNotifications(
  window: BrowserWindow,
  { iconDirectory, platform = process.platform, store, enabled = true }: { iconDirectory: string; platform?: NodeJS.Platform; store?: ReplyAttentionStore; enabled?: boolean },
): { forgetThread: (threadId: string) => void } {
  if (!enabled) return { forgetThread: () => undefined };
  const unread = new Map<string, { threadId: string; state: ReplyAttention }>(
    store?.load().map(({ turnId, ...reply }) => [turnId, reply]) ?? [],
  );
  const sounded = new Set<string>();
  let visibleThread: string | null = null;
  let iconState: ReplyAttention | undefined;
  const render = (): void => {
    store?.save([...unread].map(([turnId, reply]) => ({ turnId, ...reply })));
    const next = replyAttentionStates.find((state) => [...unread.values()].some((reply) => reply.state === state));
    if (next === iconState || window.isDestroyed()) return;
    iconState = next;
    // Native overlays are fixed to the bottom right; a complete icon variant
    // places the dot at the requested top right at every supported size.
    if (platform === "win32") window.setIcon(next ? join(iconDirectory, "replies", next, "icon.ico") : join(iconDirectory, "icon.ico"));
  };
  const markVisibleRead = (): void => {
    if (!window.isFocused() || !visibleThread) return;
    for (const [id, reply] of unread) {
      if (reply.threadId === visibleThread) unread.delete(id);
    }
    render();
  };
  const setVisibleThread = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    const parsed = persistedThreadIdSchema.nullable().safeParse(value);
    if (!parsed.success) return;
    visibleThread = parsed.data;
    markVisibleRead();
  };
  ipcMain.on(IPC_CHANNELS.replyVisibleThread, setVisibleThread);
  const unsubscribe = subscribeTurnEvents((turnId, event) => {
    if (
      window.isDestroyed() ||
      !["approval", "tool_result", "execution", "input_required", "finalization", "error", "done"].includes(event.type)
    )
      return;
    const live = liveById(turnId);
    if (!live) return;
    if (event.type === "done" && sounded.has(turnId)) return;
    const state = replyAttention(liveEvents(turnId));
    const previous = unread.get(turnId);
    const read = window.isFocused() && visibleThread === live.threadId;
    if (state && !read) unread.set(turnId, { threadId: live.threadId, state });
    else unread.delete(turnId);
    render();
    if (state && !read && state !== previous?.state && !window.isFocused()) window.flashFrame(true);
    if (event.type === "done" && !sounded.has(turnId)) {
      sounded.add(turnId);
      const status = liveEvents(turnId).findLast((item) => item.type === "turn_status");
      if (!window.isFocused() && status && status.stop !== "cancelled" && status.stop !== "failed")
        window.webContents.send(IPC_CHANNELS.replyNotification);
    }
  });
  const focus = (): void => {
    window.flashFrame(false);
    markVisibleRead();
  };
  const resetVisibility = (): void => {
    visibleThread = null;
  };
  window.on("focus", focus);
  window.webContents.on("did-start-loading", resetVisibility);
  window.once("closed", () => {
    unsubscribe();
    ipcMain.removeListener(IPC_CHANNELS.replyVisibleThread, setVisibleThread);
    window.removeListener("focus", focus);
    window.webContents.removeListener("did-start-loading", resetVisibility);
  });
  render();
  return {
    forgetThread(threadId) {
      for (const [turnId, reply] of unread) {
        if (reply.threadId === threadId) unread.delete(turnId);
      }
      render();
    },
  };
}
