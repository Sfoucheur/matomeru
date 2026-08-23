import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { closeDb, getDb, setDataDir } from './db/connection.js'
import { registerHandlers } from './ipc/handlers.js'
import { adoptOldData } from './services/adoptOldData.js'
import { registerImageProtocol, registerImageScheme } from './services/imageCache.js'

// Must run before the app is ready, or the custom scheme is not treated as secure.
registerImageScheme()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Matomeru',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // The renderer gets no Node access; everything goes through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Avoid the white flash before the first paint.
  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Anything trying to open a new window goes to the real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// One instance only — two processes writing the same SQLite file is asking for trouble.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    // Point the data layer at the user app-data folder, then open the DB so
    // migrations run before any window can query it.
    const dataDir = app.getPath('userData')
    // Before the database is opened: the rename from BulkOS moved this folder,
    // so bring a former collection across if one is sitting in the old one.
    adoptOldData(dataDir, (message) => console.log(`[data] ${message}`))
    setDataDir(dataDir)
    getDb()
    registerImageProtocol()
    registerHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    closeDb()
  })
}
