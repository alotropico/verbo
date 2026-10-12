import type {
  RemoteThreadListAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import type { RemoteThreadMetadata as StoredThread } from "@shared/storage-ipc";
import { useThreadAdapters } from "./thread-adapters";
import { ThreadAdaptersProvider } from "./ThreadAdaptersProvider";

function toRemoteThread(thread: StoredThread): {
  custom?: { messageCount: number };
  externalId?: string;
  lastMessageAt?: Date;
  remoteId: string;
  status: "regular" | "archived";
  title?: string;
} {
  return {
    remoteId: thread.remoteId,
    status: thread.status,
    ...(thread.externalId === undefined
      ? {}
      : { externalId: thread.externalId }),
    ...(thread.title === undefined ? {} : { title: thread.title }),
    ...(thread.lastMessageAt === undefined
      ? {}
      : { lastMessageAt: new Date(thread.lastMessageAt) }),
    ...(thread.messageCount === undefined
      ? {}
      : { custom: { messageCount: thread.messageCount } }),
  };
}

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

export const verboThreadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const { threads } = await window.verbo.storage.list();
    return { threads: threads.map(toRemoteThread) };
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
    return toRemoteThread(await window.verbo.storage.fetch(remoteId));
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
