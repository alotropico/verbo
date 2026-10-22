import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { approvalDecisionSchema, approvalReviewSchema } from "../../shared/action-contract";
import { agsHostAddSchema } from "../../shared/ags";
import { commandReceiptRequestSchema } from "../../shared/command-receipts";
import { commandPathSchema } from "../../shared/commands";
import { fileUiQuerySchema } from "../../shared/file-query";
import { fileSurfaceSchema } from "../../shared/file-surface";
import { displayFinalPath, scopeCommitSchema, splitScopeAliases } from "../../shared/files";
import { parseLocalCommand, routeUtterance } from "../../shared/local-commands";
import {
  contextEstimateSchema,
  memoryAddArgsSchema,
  memoryBrowserSchema,
  memoryCommandSchema,
  memoryRemoveArgsSchema,
  memoryUpdateArgsSchema,
  type MemorySnapshot,
  type MemoryUsage,
} from "../../shared/memory";
import { projectAddSchema, registeredRootRemoveSchema } from "../../shared/projects";
import {
  chatSettingsSchema,
  generateTitleSchema,
  IPC_CHANNELS,
  messageAppendSchema,
  threadIdSchema,
  titleSchema,
  welcomeLineSchema,
} from "../../shared/storage-ipc";
import { registryForDatabase } from "../capabilities/catalog";
import { aloDataAsync } from "../alo/data-client";
import { readCommandSettings } from "../alo/settings";
import { buildActionsOverview } from "../capabilities/overview";
import { recordActionAudit } from "../db/action-audit";
import { clearAgsCheck, saveAgsCheck } from "../db/ags-check";
import { removeApplicationRegistration, saveApplicationRegistration, saveProjectPreferences } from "../db/application-registration";
import { readCommandReceipt } from "../db/command-receipts";
import { getDatabase } from "../db/database";
import { createMemoryStore } from "../db/memory";
import { saveProjectImportSettings } from "../db/project-import-settings";
import { createRootStore } from "../db/registered-roots";
import { createScopeStore, type ScopeAddition } from "../db/scopes";
import { DEFAULT_SCOPE_ALIAS, ensureProposedDefaultDirectory } from "../files/default-scope";
import { performFileSurface } from "../files/file-surface";
import { analyzeFolder, applyImportedProjectPreferences, importFolderProjects, updateFolderSettings } from "../files/folder-import";
import { decideOperation, reviewOperation } from "../files/mutation-plan";
import { operationSession } from "../files/mutation-ports";
import { aliasFromFolderName, isProtectedLocation } from "../files/path-policy";
import { consumePick, rememberPick } from "../files/picked-folders";
import { routingInventoryForDatabase } from "../files/routing-inventory";
import { describeExistingPath } from "../files/windows-containment";
import { resolveApproval } from "../runtime/approval-wait";
import { estimateContextMeters } from "../runtime/context-estimate";
import { turnController } from "../runtime/controller-service";
import { executeLocalCommand } from "../runtime/local-command";
import { executeMemorySettingsAction } from "../runtime/memory-settings";
import { refreshModelVision } from "../runtime/model-vision";
import { inferenceMeasurements } from "../runtime/prompt-eval";
import { turnDispatcher } from "../runtime/queue-service";
import { liveTurnForThread } from "../runtime/turn-session";
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
import { loadSettings, loadSettingsReport, saveSettings } from "../services/settings-store";
import { generateThreadTitle } from "../services/thread-title";
import { generateWelcomeLine } from "../services/welcome-line";
import { discoverApplications } from "../software/application-discovery";
import { registerAttachmentIpc } from "./attachment-ipc";
import { registerAssistantStreamIpc } from "./chat-stream";
import { registerQueueIpc } from "./queue-ipc";
import { registerServiceIpc } from "./service-ipc";
import { registerVoiceIpc } from "./voice-ipc";
import { registerWebIpc } from "./web-ipc";
import { registerWindowIpc } from "./window-ipc";

function assertTrustedWindow(event: IpcMainInvokeEvent, mainWindow: BrowserWindow): void {
  if (event.sender !== mainWindow.webContents) {
    throw new Error("Untrusted IPC sender");
  }
  if (event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC frame");
  }
}

export function registerIpc(mainWindow: BrowserWindow, replies?: { forgetThread: (threadId: string) => void }): void {
  registerWindowIpc(mainWindow);
  registerQueueIpc(mainWindow);
  registerVoiceIpc(mainWindow);
  registerServiceIpc(mainWindow);
  registerWebIpc(mainWindow);
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

  ipcMain.handle(IPC_CHANNELS.threadsRename, (event, remoteId: unknown, title: unknown) => {
    assertTrustedWindow(event, mainWindow);
    renameThread(threadIdSchema.parse(remoteId), titleSchema.parse(title));
  });

  ipcMain.handle(IPC_CHANNELS.threadsArchive, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const id = threadIdSchema.parse(remoteId);
    archiveThread(id);
    replies?.forgetThread(id);
  });

  ipcMain.handle(IPC_CHANNELS.threadsUnarchive, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    unarchiveThread(threadIdSchema.parse(remoteId));
  });

  ipcMain.handle(IPC_CHANNELS.threadsDelete, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const id = threadIdSchema.parse(remoteId);
    deleteThread(id);
    replies?.forgetThread(id);
  });

  ipcMain.handle(IPC_CHANNELS.threadsFetch, (event, remoteId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return fetchThread(threadIdSchema.parse(remoteId));
  });

  ipcMain.handle(IPC_CHANNELS.threadsGenerateTitle, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = generateTitleSchema.parse(payload);
    const title = titleSchema.parse(await generateThreadTitle(data.threadId, data.messages, loadSettings()));
    // The runtime shows the streamed title immediately and calls rename only to
    // settle a race. The generated title has to be stored here to survive reload.
    renameThread(data.threadId, title);
    return title;
  });

  ipcMain.handle(IPC_CHANNELS.messagesLoad, (event, threadId: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const id = threadIdSchema.parse(threadId);
    return loadHistory(id);
  });

  ipcMain.handle(IPC_CHANNELS.messagesAppend, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = messageAppendSchema.parse(payload);
    if (
      typeof data.message === "object" &&
      data.message !== null &&
      "role" in data.message &&
      data.message.role === "assistant" &&
      "id" in data.message
    ) {
      const live = liveTurnForThread(data.threadId);
      const managed = getDatabase()
        .prepare("SELECT 1 FROM turn_events WHERE thread_id=? AND message_id=? LIMIT 1")
        .get(data.threadId, String(data.message.id));
      if (managed || live?.assistantMessageId === data.message.id) return;
    }
    appendMessage(data.threadId, data.parentId, data.message);
    turnDispatcher().reconcileBranches();
  });

  ipcMain.handle(IPC_CHANNELS.ollamaWelcomeLine, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = welcomeLineSchema.parse(payload);
    return generateWelcomeLine(data, loadSettings());
  });

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
  ipcMain.handle(IPC_CHANNELS.settingsPatch, (event, input: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const patch = chatSettingsSchema.partial().strict().parse(input);
    return saveSettings(chatSettingsSchema.parse({ ...loadSettings(), ...patch }));
  });

  ipcMain.handle(IPC_CHANNELS.memoryList, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const query = memoryBrowserSchema.parse(payload ?? {});
    return aloDataAsync("memory.settings.read", query);
  });

  ipcMain.handle(IPC_CHANNELS.memoryAdd, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = memoryAddArgsSchema.parse(payload);
    return executeMemorySettingsAction(getDatabase(), "memory.add", data);
  });

  ipcMain.handle(IPC_CHANNELS.memoryUpdate, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = memoryUpdateArgsSchema.parse(payload);
    return executeMemorySettingsAction(getDatabase(), "memory.update", data);
  });

  ipcMain.handle(IPC_CHANNELS.memoryRemove, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = memoryRemoveArgsSchema.parse(payload);
    return executeMemorySettingsAction(getDatabase(), "memory.remove", data);
  });

  ipcMain.handle(IPC_CHANNELS.commandsRun, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = memoryCommandSchema.parse(payload);
    const database = getDatabase();
    const parsed = parseLocalCommand(data.text);
    if (!(routeUtterance(data.text, data.source).kind === "new-chat" || (parsed.handled && parsed.name === "memories"))) {
      if (!data.threadId)
        return {
          status: "error",
          summary: "That command needs an open conversation.",
        };
      const threadId = data.threadId;
      const head = loadHistory(threadId).headId;
      const queued = turnDispatcher().enqueue({
        threadId,
        text: data.text,
        source: data.source ?? "typed",
        branchAnchor: head,
      });
      if (!queued.ok) return { status: "error", summary: queued.summary };
      if (queued.start) {
        const turnId = randomUUID();
        const send = (chatEvent?: import("../../shared/chat-ipc").ChatEvent): void => {
          if (!mainWindow.isDestroyed())
            mainWindow.webContents.send(IPC_CHANNELS.turnStarted, {
              turnId,
              threadId,
              queueItemId: queued.item.id,
              text: data.text,
              attachmentRefs: [],
              ...(chatEvent ? { event: chatEvent } : {}),
            });
        };
        send();
        turnController().admitTurn(
          {
            turnId,
            threadId,
            userMessageId: queued.item.id,
            assistantMessageId: randomUUID(),
            queueItemId: queued.item.id,
            source: data.source ?? "typed",
            admission: "immediate",
            text: data.text,
            ...(head ? { branchAnchor: head } : {}),
            attachmentIds: [],
            userSentAt: queued.item.createdAt,
          },
          send,
        );
      }
      return { status: "success", summary: "Command queued." };
    }
    return executeLocalCommand({
      text: data.text,
      ...(data.threadId ? { threadId: data.threadId } : {}),
      ...(data.source ? { source: data.source } : {}),
      store: createMemoryStore(database),
      registry: registryForDatabase(database),
    });
  });

  ipcMain.handle(IPC_CHANNELS.commandsReceipt, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = commandReceiptRequestSchema.parse(payload);
    return await readCommandReceipt(getDatabase(), data.receiptId, data.threadId, data.offset);
  });
  ipcMain.handle(IPC_CHANNELS.commandsSettings, (event) => {
    assertTrustedWindow(event, mainWindow);
    return readCommandSettings();
  });
  ipcMain.handle(IPC_CHANNELS.entitiesSettings, (event) => {
    assertTrustedWindow(event, mainWindow);
    return aloDataAsync("settings.entities.read");
  });
  ipcMain.handle(IPC_CHANNELS.applicationsSave, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return await saveApplicationRegistration(getDatabase(), payload);
  });
  ipcMain.handle(IPC_CHANNELS.projectsPreferencesSave, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return await saveProjectPreferences(getDatabase(), payload);
  });
  ipcMain.handle(IPC_CHANNELS.applicationsRemove, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = registeredRootRemoveSchema.parse(payload);
    return await removeApplicationRegistration(getDatabase(), data.id);
  });
  ipcMain.handle(IPC_CHANNELS.applicationsDiscover, (event) => {
    assertTrustedWindow(event, mainWindow);
    return discoverApplications();
  });
  ipcMain.handle(IPC_CHANNELS.projectImportSave, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return await saveProjectImportSettings(getDatabase(), payload);
  });
  ipcMain.handle(IPC_CHANNELS.commandsSave, (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return aloDataAsync("settings.save", payload);
  });
  ipcMain.handle(IPC_CHANNELS.commandsReset, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = z.object({ nodeId: commandPathSchema }).strict().parse(payload);
    await aloDataAsync("settings.reset", { nodeId: data.nodeId });
  });

  ipcMain.handle(IPC_CHANNELS.contextEstimate, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = contextEstimateSchema.parse(payload ?? {});
    const [usage, snapshot] = await Promise.all([
      aloDataAsync<MemoryUsage>("memory.store", { operation: "usage", args: { audience: data.audience ?? "conversational" } }),
      aloDataAsync<MemorySnapshot>("memory.snapshot", {
        ...(data.threadId ? { threadId: data.threadId } : {}),
        audience: data.audience ?? "conversational",
      }),
    ]);
    return await estimateContextMeters({
      database: getDatabase(),
      audience: data.audience,
      memory: { usage, snapshot },
      ...(data.threadId ? { threadId: data.threadId } : {}),
      numCtx: loadSettings().numCtx,
      lastInference: inferenceMeasurements.latest(data.threadId, data.audience ?? "conversational"),
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
      scopes: await store.list(),
      grants: await store.activeGrants(),
      openPath: (absolute) => shell.openPath(absolute),
      showItemInFolder: (absolute) => {
        shell.showItemInFolder(absolute);
      },
      writeClipboard: (text) => {
        clipboard.writeText(text);
      },
    });
  });

  ipcMain.handle(IPC_CHANNELS.filesList, async (event) => {
    assertTrustedWindow(event, mainWindow);
    const { scopes } = await aloDataAsync<{ scopes: Awaited<ReturnType<ReturnType<typeof createScopeStore>["list"]>> }>(
      "settings.scopes.read",
    );
    const path = join(app.getAppPath(), ".tmp");
    return {
      scopes,
      proposal: {
        alias: "tmp",
        path,
        saved: scopes.some((scope) => scope.aliases.includes("tmp") || scope.path.toLowerCase() === path.toLowerCase()),
      },
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
      kind: analyzeFolder(path).kind,
    };
  });

  ipcMain.handle(IPC_CHANNELS.filesCommit, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = scopeCommitSchema.parse(payload);
    const store = createScopeStore(getDatabase());
    const previous = new Map((await store.list()).map((scope) => [scope.id, scope.kind ?? "none"]));
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
        kind: pick.kind ?? analyzeFolder(path).kind,
      });
    }
    const removed = new Set(data.removeIds);
    const aliases = new Set(
      (await store.list())
        .filter((scope) => !removed.has(scope.id))
        .flatMap((scope) => {
          const update = data.updates.find((item) => item.id === scope.id);
          return splitScopeAliases(update?.alias ?? scope.aliases.join(", "));
        }),
    );
    if (
      data.acceptDefault &&
      !aliases.has(DEFAULT_SCOPE_ALIAS) &&
      !additions.some((item) => splitScopeAliases(item.alias).includes(DEFAULT_SCOPE_ALIAS))
    ) {
      additions.push({
        alias: DEFAULT_SCOPE_ALIAS,
        path: ensureProposedDefaultDirectory(app.getAppPath()),
        read: true,
        write: true,
        defaultSave: true,
      });
    }
    const result = await store.apply({
      removeIds: data.removeIds,
      updates: data.updates,
      additions,
    });
    if (!result.ok) return result;
    let imported = 0;
    const warnings: string[] = [];
    for (const scope of result.scopes) {
      if (scope.kind !== "projects" || previous.get(scope.id) === "projects") continue;
      const discovery = await importFolderProjects(getDatabase(), scope.path);
      imported += discovery.imported;
      warnings.push(...discovery.warnings);
    }
    return {
      ...result,
      summary: `${result.summary}${imported ? ` Imported ${imported} projects.` : ""}${warnings.length ? ` ${[...new Set(warnings)].join(" ")}` : ""}`,
    };
  });
  ipcMain.handle(IPC_CHANNELS.filesUpdate, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    return await updateFolderSettings(getDatabase(), payload);
  });
  ipcMain.handle(IPC_CHANNELS.filesRoutingRefresh, (event) => {
    assertTrustedWindow(event, mainWindow);
    return routingInventoryForDatabase(getDatabase()).refresh();
  });

  ipcMain.handle(IPC_CHANNELS.operationsReview, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = approvalReviewSchema.parse(payload);
    const database = getDatabase();
    return await reviewOperation({
      database,
      scopes: createScopeStore(database),
      operationId: data.operationId,
      threadId: data.threadId,
      sessionId: operationSession(),
    });
  });

  ipcMain.handle(IPC_CHANNELS.operationsConfirm, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = approvalDecisionSchema.parse(payload);
    const database = getDatabase();
    const scopes = createScopeStore(database);
    const review = await reviewOperation({
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
    const decision = await decideOperation({
      database,
      scopes,
      operationId: data.operationId,
      threadId: data.threadId,
      sessionId: operationSession(),
      decision: data.decision,
      signal: liveTurnForThread(data.threadId)?.abort.signal,
    });
    if (decision.operationId) resolveApproval(decision.operationId, decision);
    return decision;
  });

  ipcMain.handle(IPC_CHANNELS.actionsOverview, (event) => {
    assertTrustedWindow(event, mainWindow);
    return buildActionsOverview();
  });

  ipcMain.handle(IPC_CHANNELS.projectsAdd, async (event, payload: unknown) => {
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
    const saved = await createRootStore(database, "registered_projects", "project").add(data.alias, path);
    if (saved.ok) {
      await applyImportedProjectPreferences(database, saved.root.id);
      await recordActionAudit(database, {
        actor: "ui",
        actionId: "projects.register",
        request: saved.root.alias,
        summary: saved.summary,
        status: "success",
      });
    }
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.projectsRemove, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = registeredRootRemoveSchema.parse(payload);
    const database = getDatabase();
    const removed = await createRootStore(database, "registered_projects", "project").remove(data.id);
    if (removed.ok) {
      await recordActionAudit(database, {
        actor: "ui",
        actionId: "projects.remove",
        request: data.id,
        summary: removed.summary,
        status: "success",
      });
    }
    return removed;
  });

  ipcMain.handle(IPC_CHANNELS.agsHostAdd, async (event, payload: unknown) => {
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
    const saved = await createRootStore(database, "ags_hosts", "AGS host").add(data.alias, path);
    if (saved.ok) {
      await recordActionAudit(database, {
        actor: "ui",
        actionId: "ags.register",
        request: saved.root.alias,
        summary: saved.summary,
        status: "success",
      });
    }
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.agsHostRemove, async (event, payload: unknown) => {
    assertTrustedWindow(event, mainWindow);
    const data = registeredRootRemoveSchema.parse(payload);
    const database = getDatabase();
    const removed = await createRootStore(database, "ags_hosts", "AGS host").remove(data.id);
    if (removed.ok) {
      await recordActionAudit(database, {
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
    const saved = await saveAgsCheck(database, selected);
    if (saved.ok) {
      await recordActionAudit(database, {
        actor: "ui",
        actionId: "ags.check.configure",
        request: "allowlisted executable",
        summary: "Configured the fixed ags check command.",
        status: "success",
      });
    }
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.agsCheckClear, async (event) => {
    assertTrustedWindow(event, mainWindow);
    const database = getDatabase();
    await clearAgsCheck(database);
    await recordActionAudit(database, {
      actor: "ui",
      actionId: "ags.check.configure",
      request: "clear",
      summary: "Cleared the ags check command.",
      status: "success",
    });
    return { ok: true as const, summary: "Cleared the ags check command." };
  });
}
