import { contextBridge, ipcRenderer } from "electron";
import {
  ASSISTANT_STREAM_CHANNEL,
  type AssistantAI,
  type ChatEvent,
  type ChatRequest,
} from "../shared/chat-ipc";
import { IPC_CHANNELS } from "../shared/ipc-channels";
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
    get: (): Promise<SettingsRecovery> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (settings: ChatSettings): Promise<ChatSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsSet, settings),
  },
  memory: {
    list: (query?: {
      scope?: MemoryScope;
      threadId?: string;
    }): Promise<{
      entries: MemoryRecord[];
      usage: MemoryUsage;
      changes: MemoryChange[];
    }> => ipcRenderer.invoke(IPC_CHANNELS.memoryList, query ?? {}),
    add: (input: {
      text: string;
      scope: MemoryScope;
      inclusion: MemoryInclusion;
      threadId?: string;
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
    run: (input: {
      text: string;
      threadId?: string;
    }): Promise<LocalCommandResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.commandsRun, input),
  },
  context: {
    estimate: (input?: { threadId?: string }): Promise<ContextMeters> =>
      ipcRenderer.invoke(IPC_CHANNELS.contextEstimate, input ?? {}),
  },
  files: {
    list: (): Promise<{
      scopes: FileScopeRecord[];
      proposal: FileScopeProposal;
    }> => ipcRenderer.invoke(IPC_CHANNELS.filesList),
    pick: (): Promise<
      | { ok: true; pickId: string; path: string; suggestedAlias: string }
      | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.filesPick),
    commit: (
      input: ScopeCommit,
    ): Promise<
      | { ok: true; summary: string; scopes: FileScopeRecord[] }
      | { ok: false; code: string; summary: string }
    > => ipcRenderer.invoke(IPC_CHANNELS.filesCommit, input),
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("assistantAI", assistantAI);
  contextBridge.exposeInMainWorld("verbo", verbo);
} else {
  throw new Error("contextIsolation must be enabled");
}
