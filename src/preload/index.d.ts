import type { ActionResult } from "../shared/action-contract";
import type { AssistantAI } from "../shared/chat-ipc";
import type {
  OperationReview,
  OperationReviewFailure,
} from "../shared/file-mutation";
import type { ChatSettings } from "../shared/config";
import type { LocalCommandResult } from "../shared/local-commands";
import type {
  FileScopeProposal,
  FileScopeRecord,
  ScopeCommit,
} from "../shared/files";
import type {
  ContextMeters,
  MemoryChange,
  MemoryInclusion,
  MemoryRecord,
  MemoryScope,
  MemoryUsage,
} from "../shared/memory";
import type { SettingsRecovery } from "../shared/settings-recovery";
import type { RemoteThreadMetadata } from "../shared/storage-ipc";

type MemoryMutation = (
  | { ok: true; summary: string; entry?: MemoryRecord }
  | { ok: false; code: string; summary: string }
) & { usage: MemoryUsage };

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
    get: () => Promise<SettingsRecovery>;
    set: (settings: ChatSettings) => Promise<ChatSettings>;
  };
  memory: {
    list: (query?: { scope?: MemoryScope; threadId?: string }) => Promise<{
      entries: MemoryRecord[];
      usage: MemoryUsage;
      changes: MemoryChange[];
    }>;
    add: (input: {
      text: string;
      scope: MemoryScope;
      inclusion: MemoryInclusion;
      threadId?: string;
    }) => Promise<MemoryMutation>;
    update: (input: {
      id: string;
      text?: string;
      inclusion?: MemoryInclusion;
    }) => Promise<MemoryMutation>;
    remove: (id: string) => Promise<MemoryMutation>;
  };
  commands: {
    run: (input: {
      text: string;
      threadId?: string;
    }) => Promise<LocalCommandResult>;
  };
  context: {
    estimate: (input?: { threadId?: string }) => Promise<ContextMeters>;
  };
  files: {
    list: () => Promise<{
      scopes: FileScopeRecord[];
      proposal: FileScopeProposal;
    }>;
    pick: () => Promise<
      | { ok: true; pickId: string; path: string; suggestedAlias: string }
      | { ok: false; code: string; summary: string }
    >;
    commit: (
      input: ScopeCommit,
    ) => Promise<
      | { ok: true; summary: string; scopes: FileScopeRecord[] }
      | { ok: false; code: string; summary: string }
    >;
  };
  operations: {
    review: (input: {
      operationId: string;
      threadId: string;
    }) => Promise<OperationReview | OperationReviewFailure>;
    confirm: (input: {
      operationId: string;
      threadId: string;
    }) => Promise<ActionResult | OperationReviewFailure>;
  };
};

declare global {
  interface Window {
    assistantAI: AssistantAI;
    verbo: VerboApi;
  }
}

export {};
