import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC_CHANNELS,
  messageAppendSchema,
  threadIdSchema,
  titleSchema,
  chatSettingsSchema,
  generateTitleSchema,
  welcomeLineSchema
} from '../../shared/storage-ipc'
import {
  appendMessage,
  archiveThread,
  deleteThread,
  fetchThread,
  initializeThread,
  listThreads,
  loadMessageRows,
  renameThread,
  unarchiveThread
} from '../services/conversations'
import { fetchOllamaStatus } from '../services/ollama'
import { loadSettings, saveSettings } from '../services/settings-store'
import { generateThreadTitle } from '../services/thread-title'
import { generateWelcomeLine } from '../services/welcome-line'
import { registerAssistantStreamIpc } from './chat-stream'

function assertTrustedWindow(event: IpcMainInvokeEvent, mainWindow: BrowserWindow): void {
  if (event.sender !== mainWindow.webContents) {
    throw new Error('Untrusted IPC sender')
  }
  if (event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted IPC frame')
  }
}

export function registerIpc(mainWindow: BrowserWindow): void {
  registerAssistantStreamIpc(mainWindow)

  ipcMain.handle(IPC_CHANNELS.threadsList, (event) => {
    assertTrustedWindow(event, mainWindow)
    return { threads: listThreads() }
  })

  ipcMain.handle(IPC_CHANNELS.threadsInitialize, (event, localId: unknown) => {
    assertTrustedWindow(event, mainWindow)
    const id = threadIdSchema.parse(localId)
    return initializeThread(id)
  })

  ipcMain.handle(IPC_CHANNELS.threadsRename, (event, remoteId: unknown, title: unknown) => {
    assertTrustedWindow(event, mainWindow)
    renameThread(threadIdSchema.parse(remoteId), titleSchema.parse(title))
  })

  ipcMain.handle(IPC_CHANNELS.threadsArchive, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow)
    archiveThread(threadIdSchema.parse(remoteId))
  })

  ipcMain.handle(IPC_CHANNELS.threadsUnarchive, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow)
    unarchiveThread(threadIdSchema.parse(remoteId))
  })

  ipcMain.handle(IPC_CHANNELS.threadsDelete, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow)
    deleteThread(threadIdSchema.parse(remoteId))
  })

  ipcMain.handle(IPC_CHANNELS.threadsFetch, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow)
    return fetchThread(threadIdSchema.parse(remoteId))
  })

  ipcMain.handle(IPC_CHANNELS.threadsGenerateTitle, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow)
    const data = generateTitleSchema.parse(payload)
    const title = titleSchema.parse(
      await generateThreadTitle(data.threadId, data.messages, loadSettings())
    )
    // The runtime shows the streamed title immediately and calls rename only to
    // settle a race. The generated title has to be stored here to survive reload.
    renameThread(data.threadId, title)
    return title
  })

  ipcMain.handle(IPC_CHANNELS.messagesLoad, (event, threadId: unknown) => {
    assertTrustedWindow(event, mainWindow)
    const id = threadIdSchema.parse(threadId)
    const rows = loadMessageRows(id)
    const messages = rows.map((row) => JSON.parse(row.content_json))
    return { messages, headId: rows.at(-1)?.id ?? null }
  })

  ipcMain.handle(IPC_CHANNELS.messagesAppend, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow)
    const data = messageAppendSchema.parse(payload)
    appendMessage(data.threadId, data.parentId, data.message)
  })

  ipcMain.handle(IPC_CHANNELS.ollamaWelcomeLine, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow)
    const data = welcomeLineSchema.parse(payload)
    return generateWelcomeLine(data.phrase, loadSettings())
  })

  ipcMain.handle(IPC_CHANNELS.ollamaStatus, async (event) => {
    assertTrustedWindow(event, mainWindow)
    const settings = loadSettings()
    const status = await fetchOllamaStatus()
    if (!status.ok) return status
    const hasModel = status.models.includes(settings.model)
    return {
      ...status,
      configuredModel: settings.model,
      modelInstalled: hasModel
    }
  })

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedWindow(event, mainWindow)
    return loadSettings()
  })

  ipcMain.handle(IPC_CHANNELS.settingsSet, (event, settings: unknown) => {
    assertTrustedWindow(event, mainWindow)
    return saveSettings(chatSettingsSchema.parse(settings))
  })
}
