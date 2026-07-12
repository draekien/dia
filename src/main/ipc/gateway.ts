import { ipcMain, type WebContents } from 'electron'
import { Effect, Either, Schema, Stream } from 'effect'
import type { PaneHandle } from '../services/pane-supervisor'
import { CHANNEL, IpcCommand, IpcEvent } from './contract'

const decodeCommand = Schema.decodeUnknownEither(IpcCommand)
const encodeEvent = Schema.encodeSync(IpcEvent)

export function wireCommands(handle: PaneHandle): void {
  ipcMain.on(CHANNEL.command, (_event, raw: unknown) => {
    const decoded = decodeCommand(raw)
    if (Either.isLeft(decoded)) {
      Effect.runSync(Effect.logWarning('Dropped malformed IPC command', { issue: decoded.left }))
      return
    }

    const command = decoded.right
    if (command._tag === 'SendMessage') {
      Effect.runPromise(
        Effect.logDebug('Received SendMessage command', { paneId: command.paneId }).pipe(
          Effect.andThen(handle.sendMessage(command.text))
        )
      ).catch((cause) => {
        Effect.runSync(Effect.logError('Failed to send message to pane', { paneId: command.paneId, cause }))
      })
    }
  })
}

export function wireEvents(webContents: WebContents, handle: PaneHandle): Effect.Effect<void> {
  return Stream.runForEach(handle.subscribe(), (event) =>
    Effect.logDebug('Publishing event to renderer', { paneId: event.paneId, tag: event._tag }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          webContents.send(CHANNEL.event, encodeEvent(event))
        })
      )
    )
  )
}
