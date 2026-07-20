// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron main bootstrap composes filesystem paths outside any Effect (createWindow, whenReady).
import { join } from 'node:path'
import { NodeContext, NodeFileSystem, NodePath } from '@effect/platform-node'
import type { PaneId } from '@shared/domain/pane-tree'
import { Config, Effect, Layer, Logger, LogLevel, Option, Runtime } from 'effect'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import electronUpdater from 'electron-updater'
import {
  wireChooseDirectory,
  wireCommands,
  wireGetAppVersion,
  wireGetInitialLayout,
  wireGetPaneHistory,
  wireGetUpdateStatus,
  wireTheme,
  wireTitleBarOverlay,
  wireToggleDevTools,
  wireUpdaterCommands
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
import { makeUpdaterBridge, type UpdaterSignal } from './services/updater'

const isDev = !app.isPackaged

// The dev build must be able to run alongside an installed production dia for dogfooding.
// Both derive every on-disk path (workspace.json, settings.json, worktrees, and Chromium's
// own profile/lock files) from userData, which is keyed off the app name -- identical for
// both by default, so they collide. Giving dev its own name and userData isolates it to
// %APPDATA%/dia-dev, leaving production's %APPDATA%/dia untouched.
if (isDev) {
  app.setName('dia-dev')
  app.setPath('userData', join(app.getPath('appData'), 'dia-dev'))
}

// The single-instance lock is keyed to userData, so dev (dia-dev) and production (dia) hold
// separate locks and coexist; a second launch of the *same* build fails to acquire the lock,
// quits, and hands focus to the window already running.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows()
  if (existing === undefined) return
  if (existing.isMinimized()) existing.restore()
  existing.focus()
})

const rendererDevUrl = Effect.runSync(Config.string('ELECTRON_RENDERER_URL').pipe(Config.option))

const { autoUpdater } = electronUpdater

// Kicks a GitHub Releases check; electron-updater downloads any newer build in the background
// (autoDownload) and installs it on next quit (autoInstallOnAppQuit). Progress and readiness are
// reported to the renderer via the updater bridge's event listeners, not here. A
// no-op-with-warning if the feed can't be reached, so a transient network failure never blocks.
const runUpdateCheck = Effect.tryPromise(() => autoUpdater.checkForUpdates()).pipe(
  Effect.tapErrorCause((cause) => Effect.logWarning('Update check failed', { cause })),
  Effect.ignore
)

// Seeds the workspace's initial (and initially only) pane; splitting from it creates the rest.
// It starts pending, same as any freshly-split pane -- the user picks its working directory
// through the same onboarding form rather than the app assuming one for them.
const INITIAL_PANE_ID: PaneId = '00000000-0000-0000-0000-000000000001'

// The dia app header is 40px tall; the native window-control overlay must match so the
// OS-drawn buttons sit flush in it. These pre-mount overlay colours are a rough default
// (resolved from the OS scheme); the renderer pushes exact theme-matched colours on mount.
const TITLE_BAR_HEIGHT = 40
const initialOverlay = nativeTheme.shouldUseDarkColors
  ? { color: '#0b0d11', symbolColor: '#ededef', height: TITLE_BAR_HEIGHT }
  : { color: '#f3f5f8', symbolColor: '#3b3f45', height: TITLE_BAR_HEIGHT }

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: initialOverlay,
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

// @effect-diagnostics-next-line asyncFunction:off -- Electron's app.whenReady() imperative callback boundary; Effect programs run within it via runPromise/runFork.
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return

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

  // @effect-diagnostics-next-line processEnv:off -- deliberate cross-process config channel handed to forked pane processes (read in agent-session.ts).
  process.env.DIA_LOG_FILE = logFilePath
  // @effect-diagnostics-next-line processEnv:off -- deliberate cross-process config channel handed to forked pane processes (read in agent-session.ts).
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
    Layer.mergeAll(
      supervisorLayer,
      persistenceLayer,
      TranscriptReaderLive,
      NodeFileSystem.layer,
      NodePath.layer
    )
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
        const runtime = yield* Effect.runtime()
        wireGetInitialLayout(paneWorkspace)
        wireGetPaneHistory(paneWorkspace)
        wireChooseDirectory(settingsStore, mainWindow)
        wireTheme(settingsStore)

        const updaterBridge = yield* makeUpdaterBridge(mainWindow.webContents)
        const reportSignal = (signal: UpdaterSignal): void =>
          void Runtime.runFork(runtime)(updaterBridge.report(signal))
        autoUpdater.autoDownload = true
        autoUpdater.autoInstallOnAppQuit = true
        autoUpdater.on('checking-for-update', () => reportSignal({ _tag: 'Checking' }))
        autoUpdater.on('update-available', () => reportSignal({ _tag: 'Progress', percent: 0 }))
        autoUpdater.on('update-not-available', () => reportSignal({ _tag: 'NotAvailable' }))
        autoUpdater.on('download-progress', (progress) =>
          reportSignal({ _tag: 'Progress', percent: progress.percent })
        )
        autoUpdater.on('update-downloaded', (info) =>
          reportSignal({ _tag: 'Downloaded', version: info.version })
        )
        autoUpdater.on('error', (error) => reportSignal({ _tag: 'Failed', message: error.message }))

        wireGetAppVersion(app.getVersion())
        wireGetUpdateStatus(updaterBridge.current)
        wireTitleBarOverlay(mainWindow)
        wireToggleDevTools(mainWindow)
        wireUpdaterCommands({
          checkForUpdates: runUpdateCheck,
          installUpdate: Effect.sync(() => autoUpdater.quitAndInstall())
        })

        app.on('before-quit', (event) => {
          if (shuttingDown) return
          shuttingDown = true
          event.preventDefault()
          Runtime.runPromise(runtime)(paneSupervisor.closeAll()).finally(() => app.quit())
        })

        if (!isDev) yield* Effect.forkScoped(runUpdateCheck)

        yield* wireCommands({ paneWorkspace, paneSupervisor, webContents: mainWindow.webContents })
      })
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          appLayer,
          LoggerLive,
          Logger.minimumLogLevel(isDev ? LogLevel.Debug : LogLevel.Info)
        )
      )
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
