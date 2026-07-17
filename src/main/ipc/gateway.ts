import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'effect'
import { Effect, Either, Option, Schema, Stream } from 'effect'
import { type BrowserWindow, dialog, ipcMain } from 'electron'
import type { PermissionResponse } from '../domain/attention'
import { ConversationMessage } from '../domain/pane'
import { PaneNode } from '../domain/pane-tree'
import type { PaneSupervisor } from '../services/pane-supervisor'
import type { PaneWorkspace } from '../services/pane-workspace'
import type { SettingsStore } from '../services/settings-store'
import { CHANNEL, type ChooseDirectoryResult, IpcCommand, IpcEvent } from './contract'

const decodeCommand = Schema.decodeUnknownEither(IpcCommand)
const encodeEvent = Schema.encodeSync(IpcEvent)
const encodeTree = Schema.encodeSync(PaneNode)
const encodeHistory = Schema.encodeSync(Schema.Array(ConversationMessage))

/**
 * Registers the IPC handler that returns the current pane tree to the renderer.
 * Call once during main-process startup, after `paneWorkspace` is available.
 */
export function wireGetInitialLayout(
  paneWorkspace: Context.Tag.Service<typeof PaneWorkspace>
): void {
  ipcMain.handle(CHANNEL.getInitialLayout, () =>
    Effect.runPromise(paneWorkspace.getTree().pipe(Effect.map(encodeTree)))
  )
}

/**
 * Registers the IPC handler that returns a pane's past conversation to the renderer,
 * read from the Agent SDK session store without spawning a live session. Returns an
 * empty list for a pane with no recorded session (or an unrecognized id). Call once
 * during main-process startup, after `paneWorkspace` is available.
 */
export function wireGetPaneHistory(paneWorkspace: Context.Tag.Service<typeof PaneWorkspace>): void {
  ipcMain.handle(CHANNEL.getPaneHistory, (_event, paneId: unknown) =>
    Effect.runPromise(
      typeof paneId === 'string'
        ? paneWorkspace.getPaneHistory(paneId).pipe(Effect.map(encodeHistory))
        : Effect.succeed(encodeHistory([]))
    )
  )
}

/**
 * Registers the IPC handler that opens a native directory picker and reports the chosen
 * path (with whether it's a git repo) back to the renderer. Call once during main-process
 * startup with the window that should own the dialog.
 */
export function wireChooseDirectory(
  settingsStore: Context.Tag.Service<typeof SettingsStore>,
  ownerWindow: BrowserWindow
): void {
  // Native dialogs are per-call, not deduplicated by Electron itself -- without this guard,
  // rapid double-invokes (or an unresponsive first click) can stack multiple pickers.
  let pending: Promise<ChooseDirectoryResult> | null = null

  ipcMain.handle(CHANNEL.chooseDirectory, (): Promise<ChooseDirectoryResult> => {
    if (pending !== null) return pending

    pending = Effect.runPromise(
      Effect.gen(function* () {
        const lastDirectory = yield* settingsStore.getLastDirectory()
        // Passing the owner window makes this an app-modal dialog: the window can't be
        // interacted with again until the picker closes, reinforcing the single-picker guard.
        const result = yield* Effect.tryPromise(() =>
          dialog.showOpenDialog(ownerWindow, {
            properties: ['openDirectory'],
            defaultPath: Option.getOrUndefined(lastDirectory)
          })
        )
        if (result.canceled || result.filePaths.length === 0) return null
        const path = result.filePaths[0]
        yield* settingsStore.setLastDirectory(path)
        return { path, isGitRepo: existsSync(join(path, '.git')) }
      })
    ).finally(() => {
      pending = null
    })

    return pending
  })
}

/**
 * The subset of Electron's `WebContents` that `wireCommands` needs to push events to the
 * renderer. Narrowed to just `send` so tests can pass a fake sender instead of a real
 * `WebContents` instance.
 */
export interface EventSender {
  readonly send: (channel: string, ...args: ReadonlyArray<unknown>) => void
}

/**
 * Builds the Effect that listens for renderer-issued IPC commands, dispatches each to the
 * appropriate pane workspace/supervisor operation, and pushes resulting events back over
 * `deps.webContents`. Run the returned effect (e.g. via `Effect.runFork`) once during
 * main-process startup to start handling commands.
 */
export function wireCommands(deps: {
  readonly paneWorkspace: Context.Tag.Service<typeof PaneWorkspace>
  readonly paneSupervisor: Context.Tag.Service<typeof PaneSupervisor>
  readonly webContents: EventSender
}): Effect.Effect<void> {
  const { paneWorkspace, paneSupervisor, webContents } = deps

  const onEvent = (event: IpcEvent): Effect.Effect<void> =>
    Effect.sync(() => webContents.send(CHANNEL.event, encodeEvent(event)))

  const sendLayoutChanged = (tree: PaneNode): Effect.Effect<void> =>
    onEvent({ _tag: 'LayoutChanged', tree })

  const rawCommands = Stream.async<unknown>((emit) => {
    const listener = (_event: unknown, raw: unknown): void => void emit.single(raw)
    ipcMain.on(CHANNEL.command, listener)
    return Effect.sync(() => ipcMain.off(CHANNEL.command, listener))
  })

  return Stream.runForEach(rawCommands, (raw) =>
    Effect.gen(function* () {
      const decoded = decodeCommand(raw)
      if (Either.isLeft(decoded)) {
        yield* Effect.logWarning('Dropped malformed IPC command', { issue: decoded.left })
        return
      }

      const command = decoded.right
      switch (command._tag) {
        case 'SendMessage': {
          const handle = yield* paneSupervisor.getHandle(command.paneId)
          if (Option.isNone(handle)) {
            yield* Effect.logWarning('Dropped SendMessage for unknown pane', {
              paneId: command.paneId
            })
            return
          }
          yield* handle.value.sendMessage(command.text).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError('Failed to send message to pane', {
                paneId: command.paneId,
                cause
              })
            )
          )
          return
        }
        case 'ResolvePermission': {
          const handle = yield* paneSupervisor.getHandle(command.paneId)
          if (Option.isNone(handle)) {
            yield* Effect.logWarning('Dropped ResolvePermission for unknown pane', {
              paneId: command.paneId
            })
            return
          }
          const response: PermissionResponse =
            command.decision === 'allow'
              ? { _tag: 'Allow' }
              : { _tag: 'Deny', message: command.message ?? 'Permission denied' }
          yield* handle.value.resolvePermission(command.requestId, response).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError('Failed to resolve permission for pane', {
                paneId: command.paneId,
                cause
              })
            )
          )
          return
        }
        case 'SplitPane': {
          const result = yield* paneWorkspace
            .split(command.paneId, command.direction)
            .pipe(Effect.either)
          if (Either.isLeft(result)) {
            yield* Effect.logWarning('Failed to split pane', {
              paneId: command.paneId,
              issue: result.left
            })
            return
          }
          yield* sendLayoutChanged(result.right)
          return
        }
        case 'ClosePane': {
          const result = yield* paneWorkspace.close(command.paneId).pipe(Effect.either)
          if (Either.isLeft(result)) {
            yield* Effect.logWarning('Failed to close pane', {
              paneId: command.paneId,
              issue: result.left
            })
            return
          }
          yield* sendLayoutChanged(result.right)
          return
        }
        case 'CreatePane': {
          const result = yield* paneWorkspace
            .createPane(command.paneId, command.cwd, command.model, command.useWorktree, onEvent)
            .pipe(Effect.either)
          if (Either.isLeft(result)) {
            yield* Effect.logWarning('Failed to create pane', {
              paneId: command.paneId,
              issue: result.left
            })
            yield* onEvent({
              _tag: 'PaneCreateFailed',
              paneId: command.paneId,
              reason: String(result.left)
            })
            return
          }
          yield* sendLayoutChanged(result.right)
          return
        }
        case 'FocusPane': {
          yield* paneWorkspace.resumePane(command.paneId, onEvent)
          return
        }
      }
    })
  )
}
