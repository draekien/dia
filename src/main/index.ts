import { join } from 'node:path'
import { Config, Effect, Logger, LogLevel, Option } from 'effect'
import { app, BrowserWindow, shell } from 'electron'
import type { PaneConfig } from './domain/pane'
import { wireCommands, wireEvents } from './ipc/gateway'
import { start } from './services/pane-supervisor'

const isDev = !app.isPackaged
const rendererDevUrl = Effect.runSync(Config.string('ELECTRON_RENDERER_URL').pipe(Config.option))

// Bullet 01 has exactly one pane and no split/create UI yet (that's Bullet 02) —
// this paneId is a fixed placeholder matching the renderer's hardcoded pane view.
const DEV_PANE_CONFIG: PaneConfig = {
  paneId: '00000000-0000-0000-0000-000000000001',
  cwd: process.cwd(),
  model: 'claude-sonnet-5'
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && Option.isSome(rendererDevUrl)) {
    mainWindow.loadURL(rendererDevUrl.value)
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  const mainWindow = createWindow()

  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* start(DEV_PANE_CONFIG)
        wireCommands(handle)
        yield* wireEvents(mainWindow.webContents, handle)
      })
    ).pipe(Effect.provide(Logger.minimumLogLevel(isDev ? LogLevel.Debug : LogLevel.Info)))
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
