import { isAttachmentId } from "../../../shared/attachments";
import { publishLocalCommandEffect } from "./command-status";
import { takeQueueLease } from "./queue-lease";
import type { ChatModelAdapter } from "@assistant-ui/react";
import type { ChatEvent, ChatMessage } from "../../../shared/chat-ipc";
import {
  emptyChatProjection,
  projectChatEvent,
  visibleProjection,
} from "../../../shared/chat-projection";

export function createChatModelAdapter(
  getSettings: () => Promise<{
    model: string;
    think: boolean;
    temperature: number;
    numCtx: number;
    keepAlive: string;
  }>,
): ChatModelAdapter {
  return {
    async *run({
      messages,
      abortSignal,
      unstable_threadId,
      unstable_parentId,
      unstable_assistantMessageId,
    }) {
      abortSignal.throwIfAborted();
      if (
        !unstable_threadId ||
        unstable_threadId === "active" ||
        unstable_threadId === "pending"
      ) {
        throw new Error("This chat has no persisted thread yet.");
      }
      if (!unstable_assistantMessageId) {
        throw new Error("This chat has no assistant message id yet.");
      }

      const serializedMessages: ChatMessage[] = [];
      let attachmentIds: string[] = [];

      for (const message of messages) {
        const text = message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        const ids = message.content.flatMap((part) =>
          part.type === "file" &&
          part.sourceType === "id" &&
          isAttachmentId(part.data)
            ? [part.data]
            : [],
        );
        const hasTools = message.content.some(
          (part) => part.type === "tool-call",
        );
        if (!text && !hasTools && ids.length === 0) continue;
        if (message.role !== "user" && message.role !== "assistant") continue;
        if (message.role === "user") attachmentIds = ids;
        serializedMessages.push({
          id: message.id,
          role: message.role,
          content: text || (ids.length > 0 ? "Attached files." : ""),
        });
      }

      const queueItemId = takeQueueLease();
      const settings = await getSettings();
      const queue: ChatEvent[] = [];
      let wake: (() => void) | undefined;
      const stop = window.assistantAI.streamChat(
        {
          threadId: unstable_threadId,
          assistantMessageId: unstable_assistantMessageId,
          ...(unstable_parentId ? { parentId: unstable_parentId } : {}),
          messages: serializedMessages,
          settings,
          ...(queueItemId ? { queueItemId } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        },
        (event) => {
          queue.push(event);
          const notify = wake;
          wake = undefined;
          notify?.();
        },
      );

      const onAbort = (): void => {
        stop();
        const notify = wake;
        wake = undefined;
        notify?.();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) onAbort();

      let state = emptyChatProjection();
      try {
        while (true) {
          abortSignal.throwIfAborted();
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const event = queue.shift();
          if (!event) continue;
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "local_command") {
            publishLocalCommandEffect(event);
            continue;
          }
          if (event.type === "done") return;
          state = projectChatEvent(state, event);
          const content = visibleProjection(state);
          if (content.length > 0) yield { content };
        }
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
        stop();
      }
    },
  };
}
