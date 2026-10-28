// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron main bootstrap composes filesystem paths outside any Effect (createWindow, whenReady).
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { HostInit } from '@shared/ipc/host-process'
import { Config, Effect, Layer, Option, References } from 'effect'
import { app, BrowserWindow, nativeTheme, net, protocol, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { resolveEsbuildBinaryPath, startHostProcess } from './host-process'
import {
  TITLE_BAR_OVERLAY_COLOR,
  wireChooseDirectory,
  wireGetAppVersion,
  wireGetHostConnection,
  wireGetUpdateStatus,
  wireRevealPath,
  wireTitleBarOverlay,
  wireToggleDevTools,
  wireUpdaterCommands
} from './ipc/window-ipc'
import { DEFAULT_LOG_RETENTION, makeLoggerLive, pruneOldLogEntries } from './logger'
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

const RENDERER_SCHEME = 'dia'
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://app`

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

const rendererRoot = resolve(import.meta.dirname, '../renderer')

const serveRenderer = (request: Request): Promise<Response> | Response => {
  const { pathname } = new URL(request.url)
  const relative =
    pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const target = resolve(rendererRoot, relative)
  if (!target.startsWith(`${rendererRoot}${sep}`)) {
    return new Response('forbidden', { status: 403 })
  }
  return net.fetch(pathToFileURL(target).toString())
}

const rendererDevUrl = Effect.runSync(Config.String('ELECTRON_RENDERER_URL').pipe(Config.option))

const { autoUpdater } = electronUpdater

// Kicks a GitHub Releases check; electron-updater downloads any newer build in the background
// (autoDownload) and installs it on next quit (autoInstallOnAppQuit). Progress and readiness are
// reported to the renderer via the updater bridge's event listeners, not here. A
// no-op-with-warning if the feed can't be reached, so a transient network failure never blocks.
const runUpdateCheck = Effect.tryPromise(() => autoUpdater.checkForUpdates()).pipe(
  Effect.tapCause((cause) => Effect.logWarning('Update check failed', { cause })),
  Effect.ignore
)

// The overlay is transparent and 48px tall: the inset margin (8px), the h-8 header row and 8px
// centre the controls on that row.
// These pre-mount glyph colours are a rough default; the renderer pushes the exact one on mount.
const TITLE_BAR_HEIGHT = 48
const initialOverlay = {
  color: TITLE_BAR_OVERLAY_COLOR,
  symbolColor: nativeTheme.shouldUseDarkColors ? '#ededef' : '#3b3f45',
  height: TITLE_BAR_HEIGHT
}

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
    mainWindow.loadURL(`${RENDERER_ORIGIN}/index.html`)
  }

  return mainWindow
}

// @effect-diagnostics-next-line asyncFunction:off -- Electron's app.whenReady() imperative callback boundary; Effect programs run within it via runPromise/runFork.
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return

  protocol.handle(RENDERER_SCHEME, serveRenderer)

  const mainWindow = createWindow()

  const repoLocalLogFilePath = join(process.cwd(), 'dia.log')
  const osDefaultLogFilePath = join(app.getPath('logs'), 'main.log')
  const logFilePath = isDev ? repoLocalLogFilePath : osDefaultLogFilePath

  await Effect.runPromise(
    pruneOldLogEntries(logFilePath, DEFAULT_LOG_RETENTION).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.ignore
    )
  )

  const LoggerLive = makeLoggerLive(isDev, logFilePath)

  const allowedOrigins = [
    RENDERER_ORIGIN,
    ...(isDev && Option.isSome(rendererDevUrl) ? [new URL(rendererDevUrl.value).origin] : [])
  ]

  let shuttingDown = false

  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Effect.context<never>()
        const host = yield* startHostProcess({
          hostEntry: join(import.meta.dirname, 'host.js'),
          init: HostInit.make({
            userDataPath: app.getPath('userData'),
            worktreesRoot: join(app.getPath('userData'), 'worktrees'),
            pluginsRoot: join(app.getAppPath(), 'plugins'),
            pluginApiPath: join(app.getAppPath(), 'out', 'main', 'plugin-api.js'),
            logFilePath,
            isDev,
            allowedOrigins
          }),
          esbuildBinaryPath: resolveEsbuildBinaryPath(app.isPackaged),
          onRestarted: Effect.sync(() => mainWindow.webContents.reload())
        })

        wireGetHostConnection(host.connection)
        wireChooseDirectory(mainWindow)
        wireRevealPath()

        const updaterBridge = yield* makeUpdaterBridge(mainWindow.webContents)
        const reportSignal = (signal: UpdaterSignal): void =>
          void Effect.runForkWith(services)(updaterBridge.report(signal))
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
          Effect.runPromiseWith(services)(host.shutdown).finally(() => app.quit())
        })

        if (!isDev) yield* Effect.forkScoped(runUpdateCheck)

        return yield* Effect.never
      })
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          LoggerLive,
          Layer.succeed(References.MinimumLogLevel, isDev ? 'Debug' : 'Info')
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
