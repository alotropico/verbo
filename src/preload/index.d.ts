import type { ActionResult } from "../shared/action-contract";
import type { ActionsOverview } from "../shared/actions-overview";
import type {
  AttachmentAddResult,
  AttachmentPreview,
  AttachmentRef,
} from "../shared/attachments";
import type { AssistantAI } from "../shared/chat-ipc";
import type { ChatSettings } from "../shared/config";
import type {
  OperationReview,
  OperationReviewFailure,
} from "../shared/file-mutation";
import type { FileUiAction } from "../shared/file-query";
import type {
  FileSurfaceIntent,
  FileSurfaceResult,
} from "../shared/file-surface";
import type {
  FileScopeProposal,
  FileScopeRecord,
  ScopeCommit,
} from "../shared/files";
import type { LocalCommandResult } from "../shared/local-commands";
import type {
  ContextMeters,
  MemoryChange,
  MemoryInclusion,
  MemoryRecord,
  MemoryScope,
  MemoryUsage,
} from "../shared/memory";
import type { RegisteredRoot } from "../shared/projects";
import type { SettingsRecovery } from "../shared/settings-recovery";
import type { RemoteThreadMetadata } from "../shared/storage-ipc";
import type {
  QueueClaimResult,
  QueueEditResult,
  QueueEnqueueResult,
  QueueMutationResult,
  QueueSnapshot,
  QueueSource,
} from "../shared/turn-queue";
import type {
  VoiceAudioResult,
  VoiceStatus,
  VoiceSynthInput,
  VoiceTextResult,
} from "../shared/voice";
import type { VoiceDraftResult } from "../shared/voice-draft";
import type { VoiceSettings } from "../shared/voice-settings";
import type { WindowControlsApi } from "../shared/window-controls";

type ServiceView = {
  name: "ollama" | "voice";
  state: "stopped" | "starting" | "ready" | "error";
  owned: boolean;
  reused: boolean;
  identity: string | null;
  pid: number | null;
  error: string | null;
  suppressed: boolean;
  detail: string;
};

type MemoryMutation = (
  | { ok: true; summary: string; entry?: MemoryRecord }
  | { ok: false; code: string; summary: string }
) & { usage: MemoryUsage };

type VerboApi = {
  notifications: {
    onReply: (listener: () => void) => () => void;
  };
  clipboard: {
    writeText: (text: string) => Promise<void>;
  };
  window: WindowControlsApi;
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
    patch: (
      patch: Partial<import("../shared/config").ChatSettings>,
    ) => Promise<import("../shared/config").ChatSettings>;
    get: () => Promise<SettingsRecovery>;
    set: (settings: ChatSettings) => Promise<ChatSettings>;
  };
  memory: {
    list: (query?: {
      scope?: MemoryScope;
      threadId?: string;
      offset?: number;
    }) => Promise<{
      entries: MemoryRecord[];
      more: boolean;
      usage: MemoryUsage;
      changes: MemoryChange[];
    }>;
    add: (input: {
      text: string;
      scope: MemoryScope;
      inclusion: MemoryInclusion;
      threadId?: string;
      audiences?: import("../shared/workflows").AgentId[];
    }) => Promise<MemoryMutation>;
    update: (input: {
      id: string;
      text?: string;
      inclusion?: MemoryInclusion;
      audiences?: import("../shared/workflows").AgentId[];
    }) => Promise<MemoryMutation>;
    remove: (id: string) => Promise<MemoryMutation>;
  };
  commands: {
    saveProjectImport: (
      input: import("../shared/application-registration").ProjectImportSettings,
    ) => Promise<import("../shared/application-registration").EntitySaveResult>;
    entities: () => Promise<
      import("../shared/application-registration").EntitySettings
    >;
    saveApplication: (
      input: import("../shared/application-registration").ApplicationRegistrationInput,
    ) => Promise<import("../shared/application-registration").EntitySaveResult>;
    removeApplication: (
      id: string,
    ) => Promise<import("../shared/application-registration").EntitySaveResult>;
    saveProject: (
      input: import("../shared/application-registration").ProjectPreferences,
    ) => Promise<import("../shared/application-registration").EntitySaveResult>;
    discoverApplications: () => Promise<
      Array<{ name: string; aliases: string[]; executable: string }>
    >;
    settings: () => Promise<import("../shared/commands").CommandSettings>;
    save: (
      input: import("../shared/commands").CommandOverride,
    ) => Promise<{ ok: true } | { ok: false; summary: string }>;
    reset: (nodeId: string) => Promise<void>;
    receipt: (input: {
      receiptId: string;
      threadId: string;
      offset?: number;
    }) => Promise<import("../shared/command-receipts").CommandReceipt | null>;
    run: (input: {
      text: string;
      threadId?: string;
    }) => Promise<LocalCommandResult>;
  };
  context: {
    estimate: (input?: {
      threadId?: string;
      audience?: import("../shared/workflows").AgentId;
    }) => Promise<ContextMeters>;
  };
  files: {
    refreshRouting(): Promise<unknown>;
    update: (
      input: import("../shared/files").ScopePatch,
    ) => Promise<
      | { ok: true; summary: string; scopes: FileScopeRecord[] }
      | { ok: false; code: string; summary: string }
    >;
    list: () => Promise<{
      scopes: FileScopeRecord[];
      proposal: FileScopeProposal;
    }>;
    query: (input: {
      threadId: string;
      actionId: FileUiAction;
      args: Record<string, unknown>;
    }) => Promise<ActionResult>;
    surface: (input: {
      path: string;
      intent: FileSurfaceIntent;
    }) => Promise<FileSurfaceResult>;
    pick: () => Promise<
      | {
          ok: true;
          pickId: string;
          path: string;
          suggestedAlias: string;
          kind?: import("../shared/files").FolderKind;
        }
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
      decision: "approve" | "deny";
    }) => Promise<ActionResult | OperationReviewFailure>;
  };
  actions: {
    overview: () => Promise<ActionsOverview>;
  };
  projects: {
    add: (input: {
      pickId: string;
      alias: string;
    }) => Promise<
      | { ok: true; summary: string; root: RegisteredRoot }
      | { ok: false; code: string; summary: string }
    >;
    remove: (
      id: string,
    ) => Promise<
      | { ok: true; summary: string }
      | { ok: false; code: string; summary: string }
    >;
  };
  ags: {
    addHost: (input: {
      pickId: string;
      alias: string;
    }) => Promise<
      | { ok: true; summary: string; root: RegisteredRoot }
      | { ok: false; code: string; summary: string }
    >;
    removeHost: (
      id: string,
    ) => Promise<
      | { ok: true; summary: string }
      | { ok: false; code: string; summary: string }
    >;
    chooseCheck: () => Promise<
      { ok: true; path: string } | { ok: false; code: string; summary: string }
    >;
    clearCheck: () => Promise<{ ok: true; summary: string }>;
  };
  queue: {
    list: (threadId: string) => Promise<QueueSnapshot>;
    enqueue: (input: {
      threadId: string;
      text: string;
      branchAnchor: string | null;
      source: QueueSource;
      attachmentRefs?: AttachmentRef[];
    }) => Promise<QueueEnqueueResult>;
    claim: (threadId: string) => Promise<QueueClaimResult>;
    remove: (id: string) => Promise<QueueMutationResult>;
    acknowledge: (id: string) => Promise<QueueMutationResult>;
    discard: (id: string) => Promise<QueueMutationResult>;
    rebind: (id: string) => Promise<QueueMutationResult>;
    sendAgain: (id: string) => Promise<QueueMutationResult>;
    clear: (threadId: string) => Promise<QueueMutationResult>;
    releaseHold: () => Promise<{ ok: true }>;
    release: (id: string) => Promise<{ ok: true }>;
    beginEdit: (input: {
      id: string;
      threadId: string;
      revision: number;
      composerText: string;
      composerRefs: AttachmentRef[];
    }) => Promise<QueueEditResult>;
    saveEdit: (input: {
      id: string;
      threadId: string;
      revision: number;
      token: string;
      text: string;
      attachmentRefs: AttachmentRef[];
    }) => Promise<QueueEditResult>;
    cancelEdit: (input: {
      id: string;
      threadId: string;
      token: string;
    }) => Promise<QueueEditResult>;
    reorder: (input: {
      id: string;
      threadId: string;
      revision: number;
      direction: "up" | "down";
    }) => Promise<QueueMutationResult>;
    subscribe: (listener: () => void) => () => void;
  };
  turns: {
    retrySaving(identity: {
      turnId: string;
      threadId: string;
      assistantMessageId: string;
    }): Promise<boolean>;
    cancel: () => Promise<{ ok: boolean }>;
    snapshot: (threadId: string) => Promise<{
      turnId: string;
      threadId: string;
      queueItemId: string | null;
      userText: string;
      userMessageId: string | null;
      assistantMessageId: string;
      events: unknown[];
    } | null>;
    onStarted: (
      listener: (payload: {
        threadId: string;
        queueItemId: string;
        turnId: string;
        text?: string;
        attachmentRefs?: AttachmentRef[];
        event?: unknown;
      }) => void,
    ) => () => void;
  };
  services: {
    snapshot: () => Promise<{ ollama: ServiceView; voice: ServiceView }>;
    start: (name: "ollama" | "voice") => Promise<ServiceView>;
    stop: (
      name: "ollama" | "voice",
    ) => Promise<
      | { ok: true; service: ServiceView }
      | { ok: false; summary: string; service: ServiceView }
    >;
  };
  voice: {
    settings: () => Promise<VoiceSettings>;
    setSettings: (settings: VoiceSettings) => Promise<VoiceSettings>;
    status: () => Promise<VoiceStatus>;
    transcribe: (input: {
      audio: Uint8Array;
      language?: "en" | "es";
    }) => Promise<VoiceTextResult>;
    synthesize: (input: VoiceSynthInput) => Promise<VoiceAudioResult>;
    cancel: () => Promise<{ ok: true }>;
    draft: (threadId: string) => Promise<VoiceDraftResult>;
    commit: (input: {
      threadId: string;
      text: string;
      branchAnchor: string | null;
      captureMode?: "dictation" | "control";
    }) => Promise<VoiceDraftResult>;
    flush: (input: {
      threadId: string;
      branchAnchor: string | null;
    }) => Promise<VoiceDraftResult>;
    save: (input: {
      threadId: string;
      text: string;
    }) => Promise<VoiceDraftResult>;
    discard: (threadId: string) => Promise<VoiceDraftResult>;
    send: (input: {
      threadId: string;
      branchAnchor: string | null;
    }) => Promise<VoiceDraftResult>;
  };
  attachments: {
    add: (input: {
      threadId: string;
      name: string;
      mediaType: string;
      bytesBase64: string;
    }) => Promise<AttachmentAddResult>;
    remove: (input: {
      threadId: string;
      id: string;
    }) => Promise<{ ok: true } | { ok: false; summary: string }>;
    preview: (id: string) => Promise<AttachmentPreview>;
  };
};

declare global {
  interface Window {
    assistantAI: AssistantAI;
    verbo: VerboApi;
  }
}

export {};
