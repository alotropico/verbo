import { contextBridge, ipcRenderer } from "electron";
import {
  ASSISTANT_STREAM_CHANNEL,
  type AssistantAI,
  type ChatEvent,
  type ChatRequest,
} from "../shared/chat-ipc";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { WindowControlsApi, WindowState } from "../shared/window-controls";
import type { ChatSettings } from "../shared/config";
import type {
  FileSurfaceIntent,
  FileSurfaceResult,
} from "../shared/file-surface";
import type { FileUiAction } from "../shared/file-query";
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
import type {
  AttachmentAddResult,
  AttachmentPreview,
  AttachmentRef,
} from "../shared/attachments";
import type { ActionsOverview } from "../shared/actions-overview";
import type { ActionResult } from "../shared/action-contract";
import type {
  OperationReview,
  OperationReviewFailure,
} from "../shared/file-mutation";
import type { RegisteredRoot } from "../shared/projects";
import type { SettingsRecovery } from "../shared/settings-recovery";
import type {
  QueueClaimResult,
  QueueEnqueueResult,
  QueueMutationResult,
  QueueSnapshot,
  QueueSource,
} from "../shared/turn-queue";
import type { VoiceDraftResult } from "../shared/voice-draft";
import type { VoiceSettings } from "../shared/voice-settings";
import type {
  VoiceAudioResult,
  VoiceStatus,
  VoiceSynthInput,
  VoiceTextResult,
} from "../shared/voice";

const assistantAI: AssistantAI = {
  streamChat(request: ChatRequest, onEvent: (event: ChatEvent) => void) {
    const { port1, port2 } = new MessageChannel();
    const onMessage = (event: MessageEvent<ChatEvent>): void =>
      onEvent(event.data);

    port1.addEventListener("message", onMessage);
    port1.start();
    ipcRenderer.postMessage(ASSISTANT_STREAM_CHANNEL, request, [port2]);

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      port1.removeEventListener("message", onMessage);
      port1.close();
    };
  },
};

const verbo = {
  clipboard: {
    writeText: (text: string): void => {
      ipcRenderer.send(IPC_CHANNELS.clipboardWrite, text);
    },
  },
  window: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.windowState),
    minimize: () => ipcRenderer.send(IPC_CHANNELS.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC_CHANNELS.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC_CHANNELS.windowClose),
    subscribe(listener: (state: WindowState) => void): () => void {
      const onChange = (
        _event: Electron.IpcRendererEvent,
        state: WindowState,
      ): void => listener(state);
      ipcRenderer.on(IPC_CHANNELS.windowStateChanged, onChange);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.windowStateChanged, onChange);
      };
    },
  } satisfies WindowControlsApi,
  storage: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.threadsList),
    initialize: (localId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.threadsInitialize, localId),
    rename: (remoteId: string, title: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.threadsRename, remoteId, title),
    archive: (remoteId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.threadsArchive, remoteId),
    unarchive: (remoteId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.threadsUnarchive, remoteId),
    delete: (remoteId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.threadsDelete, remoteId),
    fetch: (remoteId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.threadsFetch, remoteId),
    generateTitle: (payload: {
      threadId: string;
      messages: { role: "user" | "assistant"; content: string }[];
    }) => ipcRenderer.invoke(IPC_CHANNELS.threadsGenerateTitle, payload),
    loadMessages: (threadId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.messagesLoad, threadId),
    appendMessage: (payload: {
      threadId: string;
      parentId?: string;
      message: unknown;
    }) => ipcRenderer.invoke(IPC_CHANNELS.messagesAppend, payload),
  },
  ollama: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.ollamaStatus),
    welcomeLine: (payload: {
      verb: string;
      modifier: string;
    }): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.ollamaWelcomeLine, payload),
  },
  settings: {
    patch: (patch: Partial<ChatSettings>): Promise<ChatSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsPatch, patch),
    get: (): Promise<SettingsRecovery> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (settings: ChatSettings): Promise<ChatSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsSet, settings),
  },
  memory: {
    list: (query?: {
      scope?: MemoryScope;
      threadId?: string;
      offset?: number;
    }): Promise<{
      entries: MemoryRecord[];
      more: boolean;
      usage: MemoryUsage;
      changes: MemoryChange[];
    }> => ipcRenderer.invoke(IPC_CHANNELS.memoryList, query ?? {}),
    add: (input: {
      text: string;
      scope: MemoryScope;
      inclusion: MemoryInclusion;
      threadId?: string;
      audiences?: import("../shared/workflows").AgentId[];
    }): Promise<
      (
        | { ok: true; summary: string; entry?: MemoryRecord }
        | { ok: false; code: string; summary: string }
      ) & { usage: MemoryUsage }
    > => ipcRenderer.invoke(IPC_CHANNELS.memoryAdd, input),
    update: (input: {
      id: string;
      text?: string;
      inclusion?: MemoryInclusion;
      audiences?: import("../shared/workflows").AgentId[];
    }): Promise<
      (
        | { ok: true; summary: string; entry?: MemoryRecord }
        | { ok: false; code: string; summary: string }
      ) & { usage: MemoryUsage }
    > => ipcRenderer.invoke(IPC_CHANNELS.memoryUpdate, input),
    remove: (
      id: string,
    ): Promise<
      (
        | { ok: true; summary: string }
        | { ok: false; code: string; summary: string }
      ) & { usage: MemoryUsage }
    > => ipcRenderer.invoke(IPC_CHANNELS.memoryRemove, { id }),
  },
  commands: {
    entities: (): Promise<
      import("../shared/application-registration").EntitySettings
    > => ipcRenderer.invoke(IPC_CHANNELS.entitiesSettings),
    saveApplication: (
      input: import("../shared/application-registration").ApplicationRegistrationInput,
    ): Promise<import("../shared/application-registration").EntitySaveResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.applicationsSave, input),
    removeApplication: (
      id: string,
    ): Promise<import("../shared/application-registration").EntitySaveResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.applicationsRemove, { id }),
    saveProject: (
      input: import("../shared/application-registration").ProjectPreferences,
    ): Promise<import("../shared/application-registration").EntitySaveResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.projectsPreferencesSave, input),
    saveProjectImport: (
      input: import("../shared/application-registration").ProjectImportSettings,
    ): Promise<import("../shared/application-registration").EntitySaveResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.projectImportSave, input),
    discoverApplications: (): Promise<
      Array<{ name: string; aliases: string[]; executable: string }>
    > => ipcRenderer.invoke(IPC_CHANNELS.applicationsDiscover),
    saveWeb: (
      input: import("../shared/web-contracts").WebSettings,
    ): Promise<{ ok: true } | { ok: false; summary: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.commandsWebSave, input),
    settings: (): Promise<import("../shared/commands").CommandSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.commandsSettings),
    save: (
      input: import("../shared/commands").CommandOverride,
    ): Promise<{ ok: true } | { ok: false; summary: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.commandsSave, input),
    reset: (nodeId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.commandsReset, { nodeId }),
    receipt: (input: {
      receiptId: string;
      threadId: string;
      offset?: number;
    }): Promise<import("../shared/command-receipts").CommandReceipt | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.commandsReceipt, input),
    run: (input: {
      text: string;
      threadId?: string;
    }): Promise<LocalCommandResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.commandsRun, input),
  },
  context: {
    estimate: (input?: {
      threadId?: string;
      audience?: import("../shared/workflows").AgentId;
    }): Promise<ContextMeters> =>
      ipcRenderer.invoke(IPC_CHANNELS.contextEstimate, input ?? {}),
  },
  files: {
    refreshRouting: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.filesRoutingRefresh),
    update: (
      input: import("../shared/files").ScopePatch,
    ): Promise<import("../shared/files").ScopeMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.filesUpdate, input),
    list: (): Promise<{
      scopes: FileScopeRecord[];
      proposal: FileScopeProposal;
    }> => ipcRenderer.invoke(IPC_CHANNELS.filesList),
    query: (input: {
      threadId: string;
      actionId: FileUiAction;
      args: Record<string, unknown>;
    }): Promise<ActionResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.filesQuery, input),
    surface: (input: {
      path: string;
      intent: FileSurfaceIntent;
    }): Promise<FileSurfaceResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.filesSurface, input),
    pick: (): Promise<
      | {
          ok: true;
          pickId: string;
          path: string;
          suggestedAlias: string;
          kind?: import("../shared/files").FolderKind;
        }
      | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.filesPick),
    commit: (
      input: ScopeCommit,
    ): Promise<
      | { ok: true; summary: string; scopes: FileScopeRecord[] }
      | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.filesCommit, input),
  },
  operations: {
    review: (input: {
      operationId: string;
      threadId: string;
    }): Promise<OperationReview | OperationReviewFailure> =>
      ipcRenderer.invoke(IPC_CHANNELS.operationsReview, input),
    confirm: (input: {
      operationId: string;
      threadId: string;
    }): Promise<ActionResult | OperationReviewFailure> =>
      ipcRenderer.invoke(IPC_CHANNELS.operationsConfirm, input),
  },
  actions: {
    overview: (): Promise<ActionsOverview> =>
      ipcRenderer.invoke(IPC_CHANNELS.actionsOverview),
  },
  projects: {
    add: (input: {
      pickId: string;
      alias: string;
    }): Promise<
      | { ok: true; summary: string; root: RegisteredRoot }
      | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.projectsAdd, input),
    remove: (
      id: string,
    ): Promise<
      | { ok: true; summary: string }
      | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.projectsRemove, { id }),
  },
  ags: {
    addHost: (input: {
      pickId: string;
      alias: string;
    }): Promise<
      | { ok: true; summary: string; root: RegisteredRoot }
      | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.agsHostAdd, input),
    removeHost: (
      id: string,
    ): Promise<
      | { ok: true; summary: string }
      | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.agsHostRemove, { id }),
    chooseCheck: (): Promise<
      { ok: true; path: string } | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.agsCheckChoose),
    clearCheck: (): Promise<{ ok: true; summary: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.agsCheckClear),
  },
  queue: {
    list: (threadId: string): Promise<QueueSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueList, { threadId }),
    enqueue: (input: {
      threadId: string;
      text: string;
      branchAnchor: string | null;
      source: QueueSource;
      attachmentRefs?: AttachmentRef[];
    }): Promise<QueueEnqueueResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueEnqueue, input),
    claim: (threadId: string): Promise<QueueClaimResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueClaim, { threadId }),
    remove: (id: string): Promise<QueueMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueRemove, { id }),
    acknowledge: (id: string): Promise<QueueMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueAcknowledge, { id }),
    discard: (id: string): Promise<QueueMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueDiscard, { id }),
    rebind: (id: string): Promise<QueueMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueRebind, { id }),
    sendAgain: (id: string): Promise<QueueMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueSendAgain, { id }),
    clear: (threadId: string): Promise<QueueMutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueClear, { threadId }),
    releaseHold: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueReleaseHold),
    release: (id: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC_CHANNELS.queueRelease, { id }),
    beginEdit: (input: {
      id: string;
      threadId: string;
      revision: number;
      composerText: string;
      composerRefs: AttachmentRef[];
    }) => ipcRenderer.invoke(IPC_CHANNELS.queueEditBegin, input),
    saveEdit: (input: {
      id: string;
      threadId: string;
      revision: number;
      token: string;
      text: string;
      attachmentRefs: AttachmentRef[];
    }) => ipcRenderer.invoke(IPC_CHANNELS.queueEditSave, input),
    cancelEdit: (input: { id: string; threadId: string; token: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueEditCancel, input),
    reorder: (input: {
      id: string;
      threadId: string;
      revision: number;
      direction: "up" | "down";
    }) => ipcRenderer.invoke(IPC_CHANNELS.queueReorder, input),
    subscribe(listener: () => void): () => void {
      const wrapped = (): void => listener();
      ipcRenderer.on(IPC_CHANNELS.queueChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.queueChanged, wrapped);
      };
    },
  },
  turns: {
    retrySaving: (identity: {
      turnId: string;
      threadId: string;
      assistantMessageId: string;
    }): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.turnRetrySaving, identity),
    cancel: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.turnCancel),
    snapshot: (threadId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.turnSnapshot, threadId),
    onStarted(
      listener: (payload: {
        threadId: string;
        queueItemId: string;
        turnId: string;
        text?: string;
        attachmentRefs?: AttachmentRef[];
        event?: unknown;
      }) => void,
    ): () => void {
      const wrapped = (
        _event: unknown,
        payload: {
          threadId: string;
          queueItemId: string;
          turnId: string;
          text?: string;
          attachmentRefs?: AttachmentRef[];
          event?: unknown;
        },
      ): void => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.turnStarted, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.turnStarted, wrapped);
      };
    },
  },
  services: {
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.servicesSnapshot),
    start: (name: "ollama" | "voice") =>
      ipcRenderer.invoke(IPC_CHANNELS.servicesStart, { name }),
    stop: (name: "ollama" | "voice") =>
      ipcRenderer.invoke(IPC_CHANNELS.servicesStop, { name }),
  },
  voice: {
    settings: (): Promise<VoiceSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceSettingsGet),
    setSettings: (settings: VoiceSettings): Promise<VoiceSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceSettingsSet, settings),
    status: (): Promise<VoiceStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceStatus),
    transcribe: (input: {
      audio: Uint8Array;
      language?: "en" | "es";
    }): Promise<VoiceTextResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceTranscribe, input),
    synthesize: (input: VoiceSynthInput): Promise<VoiceAudioResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceSynthesize, input),
    cancel: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceCancel),
    draft: (threadId: string): Promise<VoiceDraftResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceDraftGet, { threadId }),
    commit: (input: {
      threadId: string;
      text: string;
      branchAnchor: string | null;
      captureMode?: "dictation" | "control";
    }): Promise<VoiceDraftResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceDraftCommit, input),
    flush: (input: {
      threadId: string;
      branchAnchor: string | null;
    }): Promise<VoiceDraftResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceDraftFlush, input),
    save: (input: {
      threadId: string;
      text: string;
    }): Promise<VoiceDraftResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceDraftSave, input),
    discard: (threadId: string): Promise<VoiceDraftResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceDraftDiscard, { threadId }),
    send: (input: {
      threadId: string;
      branchAnchor: string | null;
    }): Promise<VoiceDraftResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceDraftSend, input),
  },
  attachments: {
    add: (input: {
      threadId: string;
      name: string;
      mediaType: string;
      bytesBase64: string;
    }): Promise<AttachmentAddResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.attachmentsAdd, input),
    remove: (input: {
      threadId: string;
      id: string;
    }): Promise<{ ok: true } | { ok: false; summary: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.attachmentsRemove, input),
    preview: (id: string): Promise<AttachmentPreview> =>
      ipcRenderer.invoke(IPC_CHANNELS.attachmentsPreview, { id }),
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("assistantAI", assistantAI);
  contextBridge.exposeInMainWorld("verbo", verbo);
} else {
  throw new Error("contextIsolation must be enabled");
}
