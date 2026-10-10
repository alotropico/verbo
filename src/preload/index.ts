import { contextBridge, ipcRenderer } from "electron";
import {
  ASSISTANT_STREAM_CHANNEL,
  type AssistantAI,
  type ChatEvent,
  type ChatRequest,
} from "../shared/chat-ipc";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { ChatSettings } from "../shared/config";
import type { SettingsRecovery } from "../shared/settings-recovery";

const assistantAI: AssistantAI = {
  streamChat(request: ChatRequest, onEvent: (event: ChatEvent) => void) {
    const { port1, port2 } = new MessageChannel();
    const onMessage = (event: MessageEvent<ChatEvent>) => onEvent(event.data);

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
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("assistantAI", assistantAI);
  contextBridge.exposeInMainWorld("verbo", verbo);
} else {
  throw new Error("contextIsolation must be enabled");
}
