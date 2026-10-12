import { app, dialog, nativeTheme, shell, BrowserWindow, session } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { registerIpc } from "./ipc/register-ipc";
import {
  allowsMicrophoneCheck,
  allowsMicrophoneRequest,
} from "./voice/microphone";
import { closeDatabase, getDatabase } from "./db/database";
import { turnDispatcher } from "./runtime/queue-service";
import { voiceBridge } from "./voice/client";
import { attachVoiceService } from "./voice/lifecycle";
import { createScopeStore } from "./db/scopes";
import { createAssetStore } from "./files/asset-store";
import { ensureInstalledFileScopes } from "./files/installed-scopes";
import { reconcileOperations } from "./files/mutation-plan";

nativeTheme.themeSource = "dark";

let mainWindow: BrowserWindow | null = null;
let stopVoiceService = (): void => {};

app.on("will-quit", () => {
  stopVoiceService();
});

function createWindow(): void {
  const icon = join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    app.isPackaged ? "icons" : "build",
    process.platform === "win32" ? "icon.ico" : "icon.png",
  );
  if (process.platform === "darwin") app.dock?.setIcon(icon);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon,
    backgroundColor: "#16151a",
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin" ? { height: 48 } : false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  registerIpc(mainWindow);

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.alotropico.verbo");

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes =
        "mediaTypes" in details ? details.mediaTypes : undefined;
      callback(
        webContents.id === mainWindow?.webContents.id &&
          allowsMicrophoneRequest(permission, mediaTypes),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) => {
      return (
        webContents?.id === mainWindow?.webContents.id &&
        allowsMicrophoneCheck(permission, details.mediaType)
      );
    },
  );

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const devExtras = is.dev
      ? " script-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:11434 http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*"
      : " script-src 'self'; connect-src 'self' http://127.0.0.1:11434";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self';${devExtras}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; frame-src 'none';`,
        ],
      },
    });
  });

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  try {
    const database = getDatabase();
    reconcileOperations(database);
    createAssetStore(
      database,
      join(app.getPath("userData"), "attachments"),
    ).sweep(Date.now());
    turnDispatcher();
    const scopeRoot = app.isPackaged
      ? app.getPath("userData")
      : app.getAppPath();
    ensureInstalledFileScopes(createScopeStore(database), scopeRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Startup failed.";
    dialog.showErrorBox("Verbo failed to start", message);
  }
  await attachVoiceService(app.getAppPath(), (stop) => {
    stopVoiceService = stop;
  });
  void voiceBridge()
    .status()
    .then((status) => {
      if (status.ok) {
        console.log("Voice service reachable.");
        return;
      }
      console.log(`${status.detail}`);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Voice status failed.";
      console.log(`${message} Typed chat still works.`);
    });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  closeDatabase();
});
