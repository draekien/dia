import { join } from 'node:path'
import { NodeContext } from '@effect/platform-node'
import { Config, Effect, Layer, Logger, LogLevel, Option, Schema } from 'effect'
import { app, BrowserWindow, shell } from 'electron'
import type { PaneConfig } from './domain/pane'
import { CHANNEL, IpcEvent } from './ipc/contract'
import { wireChooseDirectory, wireCommands, wireGetInitialLayout } from './ipc/gateway'
import { GitOpsServiceLive } from './services/git-ops-service'
import {
  PaneProcessSpawnerLive,
  PaneSupervisor,
  PaneSupervisorLive
} from './services/pane-supervisor'
import { makePaneWorkspaceLive, PaneWorkspace } from './services/pane-workspace'

const encodeEvent = Schema.encodeSync(IpcEvent)

const isDev = !app.isPackaged
const rendererDevUrl = Effect.runSync(Config.string('ELECTRON_RENDERER_URL').pipe(Config.option))

// Seeds the workspace's initial (and initially only) pane; splitting from it creates the rest.
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

  const onEvent = (event: IpcEvent): Effect.Effect<void> =>
    Effect.sync(() => mainWindow.webContents.send(CHANNEL.event, encodeEvent(event)))

  const gitOpsLayer = Layer.provide(GitOpsServiceLive, NodeContext.layer)
  const supervisorLayer = Layer.provide(
    PaneSupervisorLive,
    Layer.merge(PaneProcessSpawnerLive, gitOpsLayer)
  )
  const worktreesRoot = join(app.getPath('userData'), 'worktrees')
  const workspaceLayer = Layer.provide(
    makePaneWorkspaceLive(DEV_PANE_CONFIG, worktreesRoot, onEvent),
    supervisorLayer
  )
  const appLayer = Layer.merge(supervisorLayer, workspaceLayer)

  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const paneWorkspace = yield* PaneWorkspace
        const paneSupervisor = yield* PaneSupervisor
        wireGetInitialLayout(paneWorkspace)
        wireChooseDirectory()
        yield* wireCommands({ paneWorkspace, paneSupervisor, webContents: mainWindow.webContents })
      })
    ).pipe(
      Effect.provide(appLayer),
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
