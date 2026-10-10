import type { ChatModelAdapter } from "@assistant-ui/react";
import type { ChatMessage } from "../../../shared/chat-ipc";

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
      context,
      abortSignal,
      unstable_threadId,
      unstable_parentId,
    }) {
      abortSignal.throwIfAborted();
      if (
        !unstable_threadId ||
        unstable_threadId === "active" ||
        unstable_threadId === "pending"
      ) {
        throw new Error("This chat has no persisted thread yet.");
      }

      const system = [context.system];
      const serializedMessages: ChatMessage[] = [];

      for (const message of messages) {
        const text = message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        if (!text) continue;

        if (message.role === "system") system.push(text);
        if (message.role === "user")
          serializedMessages.push({ role: "user", content: text });
        if (message.role === "assistant") {
          serializedMessages.push({ role: "assistant", content: text });
        }
      }

      const systemText = system.filter(Boolean).join("\n\n");
      const settings = await getSettings();
      let stop: (() => void) | undefined;
      let removeAbortListener: (() => void) | undefined;

      const deltas = new ReadableStream<string>({
        start(controller) {
          let settled = false;
          const close = () => {
            if (settled) return;
            settled = true;
            controller.close();
          };
          const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            controller.error(error);
          };

          stop = window.assistantAI.streamChat(
            {
              threadId: unstable_threadId,
              ...(unstable_parentId ? { parentId: unstable_parentId } : {}),
              ...(systemText ? { system: systemText } : {}),
              messages: serializedMessages,
              settings,
            },
            (event) => {
              if (event.type === "delta") controller.enqueue(event.text);
              if (event.type === "done") close();
              if (event.type === "error") fail(new Error(event.message));
            },
          );

          const onAbort = () => {
            stop?.();
            fail(abortSignal.reason);
          };
          abortSignal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            abortSignal.removeEventListener("abort", onAbort);
          if (abortSignal.aborted) onAbort();
        },
        cancel() {
          stop?.();
        },
      });

      const reader = deltas.getReader();
      let fullText = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          fullText = value;
          yield { content: [{ type: "text", text: fullText }] };
        }
      } finally {
        removeAbortListener?.();
        stop?.();
        reader.releaseLock();
      }
    },
  };
}
