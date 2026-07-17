import { join } from 'node:path'
import { NodeContext, NodeFileSystem } from '@effect/platform-node'
import { Config, Effect, Layer, Logger, LogLevel, Option } from 'effect'
import { app, BrowserWindow, shell } from 'electron'
import type { PaneId } from './domain/pane-tree'
import {
  wireChooseDirectory,
  wireCommands,
  wireGetInitialLayout,
  wireGetPaneHistory
} from './ipc/gateway'
import { DEFAULT_LOG_RETENTION, makeLoggerLive, pruneOldLogEntries } from './logger'
import { GitOpsServiceLive } from './services/git-ops-service'
import {
  PaneProcessSpawnerLive,
  PaneSupervisor,
  PaneSupervisorLive
} from './services/pane-supervisor'
import { makePaneWorkspaceLive, PaneWorkspace } from './services/pane-workspace'
import { makePersistenceServiceLive } from './services/persistence'
import { makeSettingsStoreLive, SettingsStore } from './services/settings-store'
import { TranscriptReaderLive } from './services/transcript-reader'

const isDev = !app.isPackaged
const rendererDevUrl = Effect.runSync(Config.string('ELECTRON_RENDERER_URL').pipe(Config.option))

// Seeds the workspace's initial (and initially only) pane; splitting from it creates the rest.
// It starts pending, same as any freshly-split pane -- the user picks its working directory
// through the same onboarding form rather than the app assuming one for them.
const INITIAL_PANE_ID: PaneId = '00000000-0000-0000-0000-000000000001'

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

app.whenReady().then(async () => {
  const mainWindow = createWindow()

  const repoLocalLogFilePath = join(process.cwd(), 'dia.log')
  const osDefaultLogFilePath = join(app.getPath('logs'), 'main.log')
  const logFilePath = isDev ? repoLocalLogFilePath : osDefaultLogFilePath

  await Effect.runPromise(
    pruneOldLogEntries(logFilePath, DEFAULT_LOG_RETENTION).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.catchAll(() => Effect.void)
    )
  )

  const LoggerLive = makeLoggerLive(isDev, logFilePath)

  process.env.DIA_LOG_FILE = logFilePath
  process.env.DIA_IS_DEV = isDev ? '1' : '0'

  const gitOpsLayer = Layer.provide(GitOpsServiceLive, NodeContext.layer)
  const supervisorLayer = Layer.provide(
    PaneSupervisorLive,
    Layer.merge(PaneProcessSpawnerLive, gitOpsLayer)
  )
  const worktreesRoot = join(app.getPath('userData'), 'worktrees')
  const persistenceLayer = Layer.provide(
    makePersistenceServiceLive(app.getPath('userData')),
    NodeContext.layer
  )
  const workspaceLayer = Layer.provide(
    makePaneWorkspaceLive(INITIAL_PANE_ID, worktreesRoot),
    Layer.mergeAll(supervisorLayer, persistenceLayer, TranscriptReaderLive, NodeFileSystem.layer)
  )
  const settingsStoreLayer = Layer.provide(
    makeSettingsStoreLive(app.getPath('userData')),
    NodeContext.layer
  )
  const appLayer = Layer.mergeAll(supervisorLayer, workspaceLayer, settingsStoreLayer)

  let shuttingDown = false

  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const paneWorkspace = yield* PaneWorkspace
        const paneSupervisor = yield* PaneSupervisor
        const settingsStore = yield* SettingsStore
        wireGetInitialLayout(paneWorkspace)
        wireGetPaneHistory(paneWorkspace)
        wireChooseDirectory(settingsStore, mainWindow)

        app.on('before-quit', (event) => {
          if (shuttingDown) return
          shuttingDown = true
          event.preventDefault()
          Effect.runPromise(paneSupervisor.closeAll()).finally(() => app.quit())
        })

        yield* wireCommands({ paneWorkspace, paneSupervisor, webContents: mainWindow.webContents })
      })
    ).pipe(
      Effect.provide(appLayer),
      Effect.provide(LoggerLive),
      Effect.provide(Logger.minimumLogLevel(isDev ? LogLevel.Debug : LogLevel.Info))
    )
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
