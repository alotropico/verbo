import {
  ExportedMessageRepository,
  RuntimeAdapterProvider,
  useAui,
  type AttachmentAdapter,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { isPersistedThreadId } from "@shared/thread-identity";
import { useMemo, type PropsWithChildren, type ReactElement } from "react";
import { createVerboAttachmentAdapter } from "./attachment-adapter";

function messageText(message: ThreadMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function titleAssistantStream(title: string): never {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({
        type: "part-start",
        path: [0],
        part: { type: "text" },
      });
      controller.enqueue({
        type: "text-delta",
        path: [0],
        textDelta: title,
      });
      controller.enqueue({ type: "part-finish", path: [0] });
      controller.close();
    },
  }) as never;
}

function useThreadHistoryAdapter(): ThreadHistoryAdapter {
  const aui = useAui();
  return useMemo(
    () => ({
      async load() {
        const { remoteId } = aui.threadListItem.getState();
        if (!remoteId) {
          return ExportedMessageRepository.fromArray([]);
        }
        const { messages, headId } =
          await window.verbo.storage.loadMessages(remoteId);
        return ExportedMessageRepository.fromBranchableArray(
          messages as { message: ThreadMessageLike; parentId: string | null }[],
          { headId },
        );
      },
      async append({ message, parentId }) {
        const { remoteId } = await aui.threadListItem.initialize();
        await window.verbo.storage.appendMessage({
          threadId: remoteId,
          parentId: parentId ?? undefined,
          message,
        });
      },
    }),
    [aui],
  );
}

function useAttachmentAdapter(): AttachmentAdapter {
  const aui = useAui();
  return useMemo(
    () =>
      createVerboAttachmentAdapter(() => {
        const remoteId = aui.threadListItem.getState().remoteId;
        return isPersistedThreadId(remoteId) ? remoteId : null;
      }),
    [aui],
  );
}

function ThreadAdaptersProvider({
  children,
}: PropsWithChildren): ReactElement {
  const history = useThreadHistoryAdapter();
  const attachments = useAttachmentAdapter();
  const adapters = useMemo(
    () => ({ history, attachments }),
    [attachments, history],
  );
  return (
    <RuntimeAdapterProvider adapters={adapters}>
      {children}
    </RuntimeAdapterProvider>
  );
}

function useThreadAdapters(): {
  history: ThreadHistoryAdapter;
  attachments: AttachmentAdapter;
} {
  const history = useThreadHistoryAdapter();
  const attachments = useAttachmentAdapter();
  return useMemo(() => ({ history, attachments }), [attachments, history]);
}

export const verboThreadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const { threads } = await window.verbo.storage.list();
    return { threads };
  },
  async initialize(localId) {
    return window.verbo.storage.initialize(localId);
  },
  async rename(remoteId, title) {
    await window.verbo.storage.rename(remoteId, title);
  },
  async archive(remoteId) {
    await window.verbo.storage.archive(remoteId);
  },
  async unarchive(remoteId) {
    await window.verbo.storage.unarchive(remoteId);
  },
  async delete(remoteId) {
    await window.verbo.storage.delete(remoteId);
  },
  async fetch(remoteId) {
    return window.verbo.storage.fetch(remoteId);
  },
  async generateTitle(remoteId, messages) {
    const snippets = messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: messageText(message),
      }))
      .filter((message) => message.content)
      .slice(0, 6);
    const title = await window.verbo.storage.generateTitle({
      threadId: remoteId,
      messages: snippets,
    });
    return titleAssistantStream(title);
  },
  unstable_Provider: ThreadAdaptersProvider,
  unstable_useAdapters: useThreadAdapters,
};
