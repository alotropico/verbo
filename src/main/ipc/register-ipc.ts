import {
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { registerWindowIpc } from "./window-ipc";
import {
  IPC_CHANNELS,
  messageAppendSchema,
  threadIdSchema,
  titleSchema,
  chatSettingsSchema,
  generateTitleSchema,
  welcomeLineSchema,
} from "../../shared/storage-ipc";
import {
  contextEstimateSchema,
  memoryAddArgsSchema,
  memoryBrowserSchema,
  memoryCommandSchema,
  memoryRemoveArgsSchema,
  memoryUpdateArgsSchema,
} from "../../shared/memory";
import {
  approvalDecisionSchema,
  approvalReviewSchema,
} from "../../shared/action-contract";
import { fileSurfaceSchema } from "../../shared/file-surface";
import { fileUiQuerySchema } from "../../shared/file-query";
import { refreshModelVision } from "../runtime/model-vision";
import {
  displayFinalPath,
  scopeCommitSchema,
  splitScopeAliases,
} from "../../shared/files";
import { resolveApproval } from "../runtime/approval-wait";
import {
  appendMessage,
  archiveThread,
  deleteThread,
  fetchThread,
  initializeThread,
  listThreads,
  loadHistory,
  renameThread,
  unarchiveThread,
} from "../services/conversations";
import { fetchOllamaStatus } from "../services/ollama";
import {
  loadSettings,
  loadSettingsReport,
  saveSettings,
} from "../services/settings-store";
import { generateThreadTitle } from "../services/thread-title";
import { generateWelcomeLine } from "../services/welcome-line";
import { agsHostAddSchema } from "../../shared/ags";
import {
  projectAddSchema,
  registeredRootRemoveSchema,
} from "../../shared/projects";
import { buildActionsOverview } from "../capabilities/overview";
import { registryForDatabase } from "../capabilities/catalog";
import { clearAgsCheck, saveAgsCheck } from "../db/ags-check";
import { recordActionAudit } from "../db/action-audit";
import { createRootStore } from "../db/registered-roots";
import { createScopeStore, type ScopeAddition } from "../db/scopes";
import { getDatabase } from "../db/database";
import { createMemoryStore } from "../db/memory";
import {
  DEFAULT_SCOPE_ALIAS,
  ensureProposedDefaultDirectory,
} from "../files/default-scope";
import { performFileSurface } from "../files/file-surface";
import { operationSession } from "../files/mutation-ports";
import { decideOperation, reviewOperation } from "../files/mutation-plan";
import { aliasFromFolderName, isProtectedLocation } from "../files/path-policy";
import { consumePick, rememberPick } from "../files/picked-folders";
import { describeExistingPath } from "../files/windows-containment";
import { estimateContextMeters } from "../runtime/context-estimate";
import { executeLocalCommand } from "../runtime/local-command";
import { readPromptEval } from "../runtime/prompt-eval";
import { registerAssistantStreamIpc } from "./chat-stream";
import { registerAttachmentIpc } from "./attachment-ipc";
import { registerQueueIpc } from "./queue-ipc";
import { registerServiceIpc } from "./service-ipc";
import { registerVoiceIpc } from "./voice-ipc";

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

export function registerIpc(mainWindow: BrowserWindow): void {
  registerWindowIpc(mainWindow);
  registerQueueIpc(mainWindow);
  registerVoiceIpc(mainWindow);
  registerServiceIpc(mainWindow);
  registerAttachmentIpc(mainWindow);
  registerAssistantStreamIpc(mainWindow);

  ipcMain.handle(IPC_CHANNELS.threadsList, (event) => {
    assertTrustedWindow(event, mainWindow);
    return { threads: listThreads() };
  });

  ipcMain.handle(IPC_CHANNELS.threadsInitialize, (event, localId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const id = threadIdSchema.parse(localId);
    return initializeThread(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.threadsRename,
    (event, remoteId: unknown, title: unknown) => {
      assertTrustedWindow(event, mainWindow);
      renameThread(threadIdSchema.parse(remoteId), titleSchema.parse(title));
    },
  );

  ipcMain.handle(IPC_CHANNELS.threadsArchive, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    archiveThread(threadIdSchema.parse(remoteId));
  });

  ipcMain.handle(IPC_CHANNELS.threadsUnarchive, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    unarchiveThread(threadIdSchema.parse(remoteId));
  });

  ipcMain.handle(IPC_CHANNELS.threadsDelete, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    deleteThread(threadIdSchema.parse(remoteId));
  });

  ipcMain.handle(IPC_CHANNELS.threadsFetch, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return fetchThread(threadIdSchema.parse(remoteId));
  });

  ipcMain.handle(
    IPC_CHANNELS.threadsGenerateTitle,
    async (event, payload: unknown) => {
      assertTrustedWindow(event, mainWindow);
      const data = generateTitleSchema.parse(payload);
      const title = titleSchema.parse(
        await generateThreadTitle(data.threadId, data.messages, loadSettings()),
      );
      // The runtime shows the streamed title immediately and calls rename only to
      // settle a race. The generated title has to be stored here to survive reload.
      renameThread(data.threadId, title);
      return title;
    },
  );

  ipcMain.handle(IPC_CHANNELS.messagesLoad, (event, threadId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const id = threadIdSchema.parse(threadId);
    return loadHistory(id);
  });

  ipcMain.handle(IPC_CHANNELS.messagesAppend, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = messageAppendSchema.parse(payload);
    appendMessage(data.threadId, data.parentId, data.message);
  });

  ipcMain.handle(
    IPC_CHANNELS.ollamaWelcomeLine,
    async (event, payload: unknown) => {
      assertTrustedWindow(event, mainWindow);
      const data = welcomeLineSchema.parse(payload);
      return generateWelcomeLine(data, loadSettings());
    },
  );

  ipcMain.handle(IPC_CHANNELS.ollamaStatus, async (event) => {
    assertTrustedWindow(event, mainWindow);
    const settings = loadSettings();
    const status = await fetchOllamaStatus();
    if (!status.ok) return status;
    const hasModel = status.models.includes(settings.model);
    return {
      ...status,
      configuredModel: settings.model,
      modelInstalled: hasModel,
    };
  });

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedWindow(event, mainWindow);
    return loadSettingsReport();
  });

  ipcMain.handle(IPC_CHANNELS.settingsSet, (event, settings: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return saveSettings(chatSettingsSchema.parse(settings));
  });

  ipcMain.handle(IPC_CHANNELS.memoryList, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const query = memoryBrowserSchema.parse(payload ?? {});
    const store = createMemoryStore(getDatabase());
    return {
      entries: store.list({ ...query, limit: 100 }).entries,
      usage: store.usage(),
      changes: store.recentChanges(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.memoryAdd, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = memoryAddArgsSchema.parse(payload);
    const store = createMemoryStore(getDatabase());
    const result = store.add({
      text: data.text,
      scope: data.scope,
      inclusion: data.inclusion,
      ...(data.threadId ? { threadId: data.threadId } : {}),
      actor: "ui",
    });
    return { ...result, usage: store.usage() };
  });

  ipcMain.handle(IPC_CHANNELS.memoryUpdate, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = memoryUpdateArgsSchema.parse(payload);
    const store = createMemoryStore(getDatabase());
    const result = store.update({
      id: data.id,
      ...(data.text !== undefined ? { text: data.text } : {}),
      ...(data.inclusion !== undefined ? { inclusion: data.inclusion } : {}),
      actor: "ui",
    });
    return { ...result, usage: store.usage() };
  });

  ipcMain.handle(IPC_CHANNELS.memoryRemove, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = memoryRemoveArgsSchema.parse(payload);
    const store = createMemoryStore(getDatabase());
    const result = store.remove(data.id, "ui");
    return { ...result, usage: store.usage() };
  });

  ipcMain.handle(IPC_CHANNELS.commandsRun, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = memoryCommandSchema.parse(payload);
    const database = getDatabase();
    return executeLocalCommand({
      text: data.text,
      ...(data.threadId ? { threadId: data.threadId } : {}),
      ...(data.source ? { source: data.source } : {}),
      store: createMemoryStore(database),
      registry: registryForDatabase(database),
    });
  });

  ipcMain.handle(IPC_CHANNELS.contextEstimate, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = contextEstimateSchema.parse(payload ?? {});
    return estimateContextMeters({
      database: getDatabase(),
      ...(data.threadId ? { threadId: data.threadId } : {}),
      numCtx: loadSettings().numCtx,
      lastPromptEval: readPromptEval(),
    });
  });

  ipcMain.handle(IPC_CHANNELS.filesQuery, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = fileUiQuerySchema.parse(payload);
    if (data.actionId === "files.inspect_image") {
      await refreshModelVision(loadSettings().model);
    }
    return registryForDatabase(getDatabase()).invoke(data.actionId, data.args, {
      actor: "ui",
      threadId: data.threadId,
    });
  });

  ipcMain.handle(IPC_CHANNELS.filesSurface, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = fileSurfaceSchema.parse(payload);
    const store = createScopeStore(getDatabase());
    return performFileSurface({
      reference: data.path,
      intent: data.intent,
      scopes: store.list(),
      grants: store.activeGrants(),
      openPath: (absolute) => shell.openPath(absolute),
      showItemInFolder: (absolute) => {
        shell.showItemInFolder(absolute);
      },
      writeClipboard: (text) => {
        clipboard.writeText(text);
      },
    });
  });

  ipcMain.handle(IPC_CHANNELS.filesList, (event) => {
    assertTrustedWindow(event, mainWindow);
    const store = createScopeStore(getDatabase());
    return {
      scopes: store.list(),
      proposal: store.proposal(app.getAppPath()),
    };
  });

  ipcMain.handle(IPC_CHANNELS.filesPick, async (event) => {
    assertTrustedWindow(event, mainWindow);
    const chosen = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder Verbo may use",
      properties: ["openDirectory"],
    });
    const selected = chosen.filePaths[0];
    if (chosen.canceled || !selected) {
      return {
        ok: false as const,
        code: "cancelled",
        summary: "No folder selected.",
      };
    }
    const described = describeExistingPath(selected);
    if (!described.ok || !described.directory) {
      return {
        ok: false as const,
        code: described.ok ? "not_directory" : described.code,
        summary: "Choose a folder.",
      };
    }
    if (isProtectedLocation(described.finalPath)) {
      return {
        ok: false as const,
        code: "protected",
        summary: "That location is protected.",
      };
    }
    const path = displayFinalPath(described.finalPath);
    return {
      ok: true as const,
      pickId: rememberPick(path),
      path,
      suggestedAlias: aliasFromFolderName(path),
    };
  });

  ipcMain.handle(IPC_CHANNELS.filesCommit, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = scopeCommitSchema.parse(payload);
    const store = createScopeStore(getDatabase());
    const additions: ScopeAddition[] = [];
    for (const pick of data.picks) {
      const path = consumePick(pick.pickId);
      if (!path) {
        return {
          ok: false as const,
          code: "pick_expired",
          summary: "Choose the folder again.",
        };
      }
      additions.push({
        alias: pick.alias,
        path,
        read: pick.read,
        write: pick.write,
        defaultSave: pick.defaultSave,
      });
    }
    const removed = new Set(data.removeIds);
    const aliases = new Set(
      store
        .list()
        .filter((scope) => !removed.has(scope.id))
        .flatMap((scope) => {
          const update = data.updates.find((item) => item.id === scope.id);
          return splitScopeAliases(update?.alias ?? scope.aliases.join(", "));
        }),
    );
    if (
      data.acceptDefault &&
      !aliases.has(DEFAULT_SCOPE_ALIAS) &&
      !additions.some((item) =>
        splitScopeAliases(item.alias).includes(DEFAULT_SCOPE_ALIAS),
      )
    ) {
      additions.push({
        alias: DEFAULT_SCOPE_ALIAS,
        path: ensureProposedDefaultDirectory(app.getAppPath()),
        read: true,
        write: true,
        defaultSave: true,
      });
    }
    return store.apply({
      removeIds: data.removeIds,
      updates: data.updates,
      additions,
    });
  });

  ipcMain.handle(IPC_CHANNELS.operationsReview, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = approvalReviewSchema.parse(payload);
    const database = getDatabase();
    return reviewOperation({
      database,
      scopes: createScopeStore(database),
      operationId: data.operationId,
      threadId: data.threadId,
      sessionId: operationSession(),
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.operationsConfirm,
    async (event, payload: unknown) => {
      assertTrustedWindow(event, mainWindow);
      const data = approvalDecisionSchema.parse(payload);
      const database = getDatabase();
      const scopes = createScopeStore(database);
      const review = reviewOperation({
        database,
        scopes,
        operationId: data.operationId,
        threadId: data.threadId,
        sessionId: operationSession(),
      });
      if (!review.ok) return review;
      if (review.status !== "pending") {
        return {
          ok: false,
          code: "replayed",
          summary: "That operation is no longer waiting.",
        };
      }
      const decision = decideOperation({
        database,
        scopes,
        operationId: data.operationId,
        threadId: data.threadId,
        sessionId: operationSession(),
        decision: data.decision,
      });
      if (decision.operationId) resolveApproval(decision.operationId, decision);
      return decision;
    },
  );

  ipcMain.handle(IPC_CHANNELS.actionsOverview, (event) => {
    assertTrustedWindow(event, mainWindow);
    return buildActionsOverview(getDatabase());
  });

  ipcMain.handle(IPC_CHANNELS.projectsAdd, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = projectAddSchema.parse(payload);
    const path = consumePick(data.pickId);
    if (!path) {
      return {
        ok: false as const,
        code: "pick_expired",
        summary: "Choose the folder again.",
      };
    }
    const database = getDatabase();
    const saved = createRootStore(
      database,
      "registered_projects",
      "project",
    ).add(data.alias, path);
    if (saved.ok) {
      recordActionAudit(database, {
        actor: "ui",
        actionId: "projects.register",
        request: saved.root.alias,
        summary: saved.summary,
        status: "success",
      });
    }
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.projectsRemove, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = registeredRootRemoveSchema.parse(payload);
    const database = getDatabase();
    const removed = createRootStore(
      database,
      "registered_projects",
      "project",
    ).remove(data.id);
    if (removed.ok) {
      recordActionAudit(database, {
        actor: "ui",
        actionId: "projects.remove",
        request: data.id,
        summary: removed.summary,
        status: "success",
      });
    }
    return removed;
  });

  ipcMain.handle(IPC_CHANNELS.agsHostAdd, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = agsHostAddSchema.parse(payload);
    const path = consumePick(data.pickId);
    if (!path) {
      return {
        ok: false as const,
        code: "pick_expired",
        summary: "Choose the folder again.",
      };
    }
    const database = getDatabase();
    const saved = createRootStore(database, "ags_hosts", "AGS host").add(
      data.alias,
      path,
    );
    if (saved.ok) {
      recordActionAudit(database, {
        actor: "ui",
        actionId: "ags.register",
        request: saved.root.alias,
        summary: saved.summary,
        status: "success",
      });
    }
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.agsHostRemove, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = registeredRootRemoveSchema.parse(payload);
    const database = getDatabase();
    const removed = createRootStore(database, "ags_hosts", "AGS host").remove(
      data.id,
    );
    if (removed.ok) {
      recordActionAudit(database, {
        actor: "ui",
        actionId: "ags.remove",
        request: data.id,
        summary: removed.summary,
        status: "success",
      });
    }
    return removed;
  });

  ipcMain.handle(IPC_CHANNELS.agsCheckChoose, async (event) => {
    assertTrustedWindow(event, mainWindow);
    const chosen = await dialog.showOpenDialog(mainWindow, {
      title: "Choose the ags executable",
      properties: ["openFile"],
      filters: [{ name: "ags", extensions: ["exe", "cmd"] }],
    });
    const selected = chosen.filePaths[0];
    if (chosen.canceled || !selected) {
      return {
        ok: false as const,
        code: "cancelled",
        summary: "No ags executable selected.",
      };
    }
    const database = getDatabase();
    const saved = saveAgsCheck(database, selected);
    if (saved.ok) {
      recordActionAudit(database, {
        actor: "ui",
        actionId: "ags.check.configure",
        request: "allowlisted executable",
        summary: "Configured the fixed ags check command.",
        status: "success",
      });
    }
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.agsCheckClear, (event) => {
    assertTrustedWindow(event, mainWindow);
    const database = getDatabase();
    clearAgsCheck(database);
    recordActionAudit(database, {
      actor: "ui",
      actionId: "ags.check.configure",
      request: "clear",
      summary: "Cleared the ags check command.",
      status: "success",
    });
    return { ok: true as const, summary: "Cleared the ags check command." };
  });
}
