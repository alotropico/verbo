import type { AssistantAI } from "../shared/chat-ipc";
import type { ChatSettings } from "../shared/config";
import type { RemoteThreadMetadata } from "../shared/storage-ipc";

type VerboApi = {
  storage: {
    list: () => Promise<{ threads: RemoteThreadMetadata[] }>;
    initialize: (
      localId: string,
    ) => Promise<{ remoteId: string; externalId?: string }>;
    rename: (remoteId: string, title: string) => Promise<void>;
    archive: (remoteId: string) => Promise<void>;
    unarchive: (remoteId: string) => Promise<void>;
    delete: (remoteId: string) => Promise<void>;
    fetch: (remoteId: string) => Promise<RemoteThreadMetadata>;
    generateTitle: (payload: {
      threadId: string;
      messages: { role: "user" | "assistant"; content: string }[];
    }) => Promise<string>;
    loadMessages: (threadId: string) => Promise<{
      messages: { message: unknown; parentId: string | null }[];
      headId: string | null;
    }>;
    appendMessage: (payload: {
      threadId: string;
      parentId?: string;
      message: unknown;
    }) => Promise<void>;
  };
  ollama: {
    welcomeLine: (payload: {
      verb: string;
      modifier: string;
    }) => Promise<string>;
    status: () => Promise<
      | {
          ok: true;
          version?: string;
          models: string[];
          configuredModel: string;
          modelInstalled: boolean;
        }
      | { ok: false; error: string; models?: string[] }
    >;
  };
  settings: {
    get: () => Promise<ChatSettings>;
    set: (settings: ChatSettings) => Promise<ChatSettings>;
  };
};

declare global {
  interface Window {
    assistantAI: AssistantAI;
    verbo: VerboApi;
  }
}

export {};
