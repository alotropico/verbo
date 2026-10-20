import {
  chatExportAdvanced,
  chatExportFilename,
  chatExportMarkdown,
  type ChatExport,
} from "@shared/chat-export";
import { copyText } from "./clipboard";

export const CHAT_TRANSFER_ACTIONS = [
  { id: "copy-text", label: "Copy text", mode: "copy", format: "text" },
  { id: "copy-full", label: "Copy full data", mode: "copy", format: "full" },
  {
    id: "export-text",
    label: "Export text (.md)",
    mode: "export",
    format: "text",
  },
  {
    id: "export-full",
    label: "Export full data (.json)",
    mode: "export",
    format: "full",
  },
] as const;

export type ChatTransferAction = (typeof CHAT_TRANSFER_ACTIONS)[number];

/** Both chat menus expose the same explicit formats, independent of message settings. */
export function transferChat(
  chat: ChatExport,
  action: ChatTransferAction,
  interaction?: unknown,
): void {
  const full = action.format === "full";
  const text = full
    ? chatExportAdvanced(chat, interaction)
    : chatExportMarkdown(chat, { textOnly: true });
  if (action.mode === "copy") {
    void copyText(text);
    return;
  }
  const extension = full ? "json" : "md";
  const blob = new Blob([text], {
    type: full ? "application/json" : "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = chatExportFilename(chat.title, extension);
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
}
