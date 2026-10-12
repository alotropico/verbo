import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import {
  voiceSynthesizeSchema,
  voiceTranscribeSchema,
  type VoiceAudioResult,
  type VoiceStatus,
  type VoiceTextResult,
} from "../../shared/voice";
import { getDatabase } from "../db/database";
import { turnDispatcher } from "../runtime/queue-service";
import { createVoiceDraftService } from "../voice/draft-service";
import { voiceBridge } from "../voice/client";
import { loadVoiceSettings, saveVoiceSettings } from "../voice/settings-store";
import {
  voiceSettingsSchema,
  type VoiceSettings,
} from "../../shared/voice-settings";
import {
  voiceDraftCommitSchema,
  voiceDraftReadSchema,
  voiceDraftSaveSchema,
  voiceDraftSendSchema,
  type VoiceDraftResult,
} from "../../shared/voice-draft";

function assertTrustedWindow(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
): void {
  if (event.sender !== mainWindow.webContents) {
    throw new Error("Untrusted IPC sender");
  }
  if (event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC frame");
  }
}

export function registerVoiceIpc(mainWindow: BrowserWindow): void {
  const status = (event: IpcMainInvokeEvent): Promise<VoiceStatus> => {
    assertTrustedWindow(event, mainWindow);
    return voiceBridge().status();
  };
  const transcribe = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<VoiceTextResult> => {
    assertTrustedWindow(event, mainWindow);
    const data = voiceTranscribeSchema.parse(payload);
    return voiceBridge().transcribe(data.audio, {
      ...(data.language ? { language: data.language } : {}),
    });
  };
  const synthesize = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<VoiceAudioResult> => {
    assertTrustedWindow(event, mainWindow);
    const data = voiceSynthesizeSchema.parse(payload);
    return voiceBridge().synthesize(data);
  };
  const cancel = (event: IpcMainInvokeEvent): { ok: true } => {
    assertTrustedWindow(event, mainWindow);
    voiceBridge().cancel();
    return { ok: true };
  };

  const drafts = createVoiceDraftService(getDatabase(), turnDispatcher());
  const readDraft = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): VoiceDraftResult => {
    assertTrustedWindow(event, mainWindow);
    return drafts.read(voiceDraftReadSchema.parse(payload).threadId);
  };
  const commitDraft = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): VoiceDraftResult => {
    assertTrustedWindow(event, mainWindow);
    return drafts.commit(voiceDraftCommitSchema.parse(payload));
  };
  const flushDraft = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): VoiceDraftResult => {
    assertTrustedWindow(event, mainWindow);
    return drafts.flush(voiceDraftSendSchema.parse(payload));
  };
  const saveDraft = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): VoiceDraftResult => {
    assertTrustedWindow(event, mainWindow);
    return drafts.save(voiceDraftSaveSchema.parse(payload));
  };
  const discardDraft = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): VoiceDraftResult => {
    assertTrustedWindow(event, mainWindow);
    return drafts.discard(voiceDraftReadSchema.parse(payload).threadId);
  };
  const sendDraft = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): VoiceDraftResult => {
    assertTrustedWindow(event, mainWindow);
    return drafts.send(voiceDraftSendSchema.parse(payload));
  };

  const readSettings = (event: IpcMainInvokeEvent): VoiceSettings => {
    assertTrustedWindow(event, mainWindow);
    return loadVoiceSettings();
  };
  const writeSettings = (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): VoiceSettings => {
    assertTrustedWindow(event, mainWindow);
    return saveVoiceSettings(voiceSettingsSchema.parse(payload));
  };

  ipcMain.handle(IPC_CHANNELS.voiceSettingsGet, readSettings);
  ipcMain.handle(IPC_CHANNELS.voiceSettingsSet, writeSettings);
  ipcMain.handle(IPC_CHANNELS.voiceStatus, status);
  ipcMain.handle(IPC_CHANNELS.voiceTranscribe, transcribe);
  ipcMain.handle(IPC_CHANNELS.voiceSynthesize, synthesize);
  ipcMain.handle(IPC_CHANNELS.voiceCancel, cancel);
  ipcMain.handle(IPC_CHANNELS.voiceDraftGet, readDraft);
  ipcMain.handle(IPC_CHANNELS.voiceDraftCommit, commitDraft);
  ipcMain.handle(IPC_CHANNELS.voiceDraftFlush, flushDraft);
  ipcMain.handle(IPC_CHANNELS.voiceDraftSave, saveDraft);
  ipcMain.handle(IPC_CHANNELS.voiceDraftDiscard, discardDraft);
  ipcMain.handle(IPC_CHANNELS.voiceDraftSend, sendDraft);
}
