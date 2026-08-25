import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { closeDb, getDb, setDataDir } from './db/connection.js'
import { registerHandlers } from './ipc/handlers.js'
import { setAppVersion } from './services/backup.js'
import { logInfo, parseDebugFlag, setVerboseLogging } from './services/log.js'
import { checkForUpdates } from './services/updates.js'
import { getSettings } from './db/repos/settings.js'
import { broadcastProgress } from './ipc/handlers.js'
import { adoptOldData } from './services/adoptOldData.js'
import { registerImageProtocol, registerImageScheme } from './services/imageCache.js'

// Must run before the app is ready, or the custom scheme is not treated as secure.
registerImageScheme()

let mainWindow: BrowserWindow | null = null

function createWindow(debugging = false): void {
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
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (debugging) mainWindow?.webContents.openDevTools({ mode: 'bottom' })
  })

  /*
    DevTools on Ctrl+Shift+I, registered rather than assumed.

    Nothing here sets an application menu, so the app inherits Electron's default one --
    which does carry a Toggle Developer Tools item, but sits behind `autoHideMenuBar` and
    is not something to rely on in a packaged build. Binding it explicitly means the one
    tool for looking at a renderer problem is reachable whatever the menu is doing.
  */
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    const combo = input.control && input.shift && input.key.toLowerCase() === 'i'
    if (input.type === 'keyDown' && combo) mainWindow?.webContents.toggleDevTools()
  })

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

  /*
    `--verbose` raises the log level and opens DevTools. A flag rather than a setting,
    because it has to work on a build that will not start far enough to reach Settings.

    Not `--debug`: Node claims that name and Electron refuses to launch at all with it,
    which was discovered the only way it can be — by trying. See RESERVED_FLAGS.
  */
  const debugging = parseDebugFlag(process.argv)
  setVerboseLogging(debugging)

  void app.whenReady().then(() => {
    // Point the data layer at the user app-data folder, then open the DB so
    // migrations run before any window can query it.
    const dataDir = app.getPath('userData')
    // Before the database is opened: the rename from BulkOS moved this folder,
    // so bring a former collection across if one is sitting in the old one.
    adoptOldData(dataDir, (message) => console.log(`[data] ${message}`))
    setDataDir(dataDir)
    getDb()
    // Handed in rather than imported, so the backup service stays free of Electron
    // and `scripts/verify.ts` can drive it in plain Node.
    setAppVersion(app.getVersion())
    // One line of context at the top of every log, so a pasted excerpt says which build
    // and which machine produced it without anyone having to be asked.
    logInfo(
      'startup',
      `Matomeru ${app.getVersion()} · electron ${process.versions.electron} · ` +
        `node ${process.versions.node} · packaged ${app.isPackaged}` +
        `${process.env.PORTABLE_EXECUTABLE_DIR ? ' · portable' : ''}` +
        `${debugging ? ' · debug' : ''} · data ${dataDir}`
    )
    registerImageProtocol()
    registerHandlers()
    createWindow(debugging)

    /*
      One quiet look for a new release, a few seconds after the window exists.

      Delayed because startup already has migrations, a window and the first queries
      to get through, and an update check is the least urgent thing the app does. It
      is silent by design: `silent` suppresses the error, so an unreachable GitHub or
      a repository with no releases yet leaves no trace in the UI. Nobody asked, and
      there would be nothing for them to do about it.
    */
    if (getSettings().checkUpdatesOnLaunch) {
      setTimeout(() => {
        void checkForUpdates(broadcastProgress, { silent: true })
      }, 4000)
    }

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
