import { app, nativeTheme, shell, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc/register-ipc'
import { closeDatabase, getDatabase } from './db/database'
import { createScopeStore } from './db/scopes'
import { ensureInstalledFileScopes } from './files/installed-scopes'

nativeTheme.themeSource = 'dark'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16151a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  registerIpc(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.alotropico.verbo')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const devExtras = is.dev
      ? " script-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:11434 http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*"
      : " script-src 'self'; connect-src 'self' http://127.0.0.1:11434"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self';${devExtras}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'none';`
        ]
      }
    })
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const database = getDatabase()
  ensureInstalledFileScopes(createScopeStore(database), app.getAppPath())
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDatabase()
})
