import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { liveEvents, subscribeTurnEvents } from "./runtime/turn-session";

export function registerReplyNotifications(window: BrowserWindow): void {
  const unsubscribe = subscribeTurnEvents((turnId, event) => {
    if (event.type !== "done" || window.isDestroyed() || window.isFocused())
      return;
    const status = liveEvents(turnId).findLast(
      (item) => item.type === "turn_status",
    );
    if (!status || status.stop === "cancelled" || status.stop === "failed")
      return;
    window.flashFrame(true);
    window.webContents.send(IPC_CHANNELS.replyNotification);
  });
  const clearAttention = (): void => window.flashFrame(false);
  window.on("focus", clearAttention);
  window.once("closed", () => {
    unsubscribe();
    window.removeListener("focus", clearAttention);
  });
}
