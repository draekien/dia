import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { UpdateStatus } from '@shared/domain/update'
import { CHANNEL, HostConnection, TitleBarOverlayColors } from '@shared/ipc/contract'
import { Effect, FileSystem, Option, Result, Schema } from 'effect'
import { type BrowserWindow, dialog, ipcMain, shell } from 'electron'

const decodeTitleBarOverlay = Schema.decodeUnknownResult(TitleBarOverlayColors)
const encodeUpdateStatus = Schema.encodeSync(UpdateStatus)
const encodeHostConnection = Schema.encodeSync(HostConnection)

/**
 * Registers the IPC handler that returns the Host's {@link HostConnection} to the preload.
 * `connection` completes once the Host is listening; the handler waits for it, so a renderer that
 * loads before the Host is ready still receives the connection. Call once during main-process
 * startup.
 */
export function wireGetHostConnection(connection: Effect.Effect<HostConnection>): void {
  ipcMain.handle(CHANNEL.getHostConnection, () =>
    Effect.runPromise(connection.pipe(Effect.map(encodeHostConnection)))
  )
}

/**
 * Registers the IPC handlers that open a native directory picker (`chooseDirectory`) or file
 * picker (`chooseFile`) and return the chosen path, or `null` when the user cancels. The renderer
 * passes the directory to start in (`null` for the OS default). Only one picker is open at a
 * time; a request while one is open receives that picker's result. Call once during main-process
 * startup with the window that should own the dialog.
 */
export function wireChooseDirectory(ownerWindow: BrowserWindow): void {
  // Native dialogs are per-call, not deduplicated by Electron itself -- without this guard,
  // rapid double-invokes (or an unresponsive first click) can stack multiple pickers.
  let pending: Promise<string | null> | null = null

  const choose = (
    property: 'openDirectory' | 'openFile',
    defaultPath: unknown
  ): Promise<string | null> => {
    if (pending !== null) return pending

    pending = Effect.runPromise(
      Effect.gen(function* () {
        // Passing the owner window makes this an app-modal dialog: the window can't be
        // interacted with again until the picker closes, reinforcing the single-picker guard.
        const result = yield* Effect.tryPromise(() =>
          dialog.showOpenDialog(ownerWindow, {
            properties: [property],
            defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined
          })
        )
        if (result.canceled || result.filePaths.length === 0) return null
        return Option.getOrNull(Option.fromNullishOr(result.filePaths[0]))
      })
    ).finally(() => {
      pending = null
    })

    return pending
  }

  ipcMain.handle(CHANNEL.chooseDirectory, (_event, defaultPath: unknown) =>
    choose('openDirectory', defaultPath)
  )
  ipcMain.handle(CHANNEL.chooseFile, (_event, defaultPath: unknown) =>
    choose('openFile', defaultPath)
  )
}

/**
 * Registers the IPC handler that shows a directory in the system file manager. The handler does
 * nothing when the path the renderer sends is not an existing directory. Call once during
 * main-process startup.
 */
export function wireRevealPath(): void {
  ipcMain.handle(CHANNEL.revealPath, (_event, directory: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (typeof directory !== 'string') return
        const fs = yield* FileSystem.FileSystem
        const info = yield* fs.stat(directory).pipe(Effect.option)
        if (Option.isNone(info) || info.value.type !== 'Directory') {
          yield* Effect.logWarning('Did not reveal a path that is not a directory', { directory })
          return
        }
        shell.showItemInFolder(directory)
      }).pipe(Effect.provide(NodeFileSystem.layer))
    )
  )
}

/**
 * Registers the IPC handler that returns the running application version to the
 * renderer (for the About dialog). Call once during main-process startup with
 * `app.getVersion()`.
 */
export function wireGetAppVersion(version: string): void {
  ipcMain.handle(CHANNEL.getAppVersion, (): string => version)
}

/**
 * Registers the IPC handler that returns the current self-update status, so a
 * renderer mounting after the first updater events can seed itself. Back it with
 * an updater bridge's `current` effect. Call once during main-process startup.
 */
export function wireGetUpdateStatus(current: Effect.Effect<UpdateStatus>): void {
  ipcMain.handle(CHANNEL.getUpdateStatus, () =>
    Effect.runPromise(current.pipe(Effect.map(encodeUpdateStatus)))
  )
}

/**
 * Registers the listener that recolours the OS-drawn window-control overlay to
 * match the renderer's active theme. The renderer pushes {@link
 * TitleBarOverlayColors} whenever the resolved theme changes; invalid payloads
 * are dropped with a warning. Call once during main-process startup with the
 * window whose overlay should track the theme.
 */
export function wireTitleBarOverlay(window: BrowserWindow): void {
  ipcMain.on(CHANNEL.setTitleBarOverlay, (_event, raw: unknown) => {
    const decoded = decodeTitleBarOverlay(raw)
    if (Result.isFailure(decoded)) {
      Effect.runFork(Effect.logWarning('Dropped invalid setTitleBarOverlay value'))
      return
    }
    window.setTitleBarOverlay({
      color: decoded.success.color,
      symbolColor: decoded.success.symbolColor
    })
  })
}

/**
 * Registers the listener that opens or closes the renderer's Chrome DevTools when
 * the renderer requests it (from the command palette). dia uses a custom title bar
 * with no native menu, so this is the only in-app way to reach DevTools in a
 * packaged build. Call once during main-process startup with the window whose web
 * contents' DevTools should toggle.
 */
export function wireToggleDevTools(window: BrowserWindow): void {
  ipcMain.on(CHANNEL.toggleDevTools, () => {
    Effect.runFork(Effect.logDebug('Toggling renderer DevTools'))
    window.webContents.toggleDevTools()
  })
}

/**
 * Registers the listeners that drive the self-updater from the renderer:
 * `checkForUpdates` runs an on-demand update check (from the About dialog) and
 * `installUpdate` quits and installs a downloaded update. Both are supplied as
 * effects by the composition root (which owns electron-updater). Call once
 * during main-process startup.
 */
export function wireUpdaterCommands(deps: {
  readonly checkForUpdates: Effect.Effect<void>
  readonly installUpdate: Effect.Effect<void>
}): void {
  ipcMain.on(CHANNEL.checkForUpdates, () => void Effect.runPromise(deps.checkForUpdates))
  ipcMain.on(CHANNEL.installUpdate, () => void Effect.runPromise(deps.installUpdate))
}
