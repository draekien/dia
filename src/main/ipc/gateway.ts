import { Effect, Either, Schema, Stream } from 'effect'
import { ipcMain, type WebContents } from 'electron'
import type { PaneHandle } from '../services/pane-supervisor'
import { CHANNEL, IpcCommand, IpcEvent } from './contract'

const decodeCommand = Schema.decodeUnknownEither(IpcCommand)
const encodeEvent = Schema.encodeSync(IpcEvent)

export function wireCommands(handle: PaneHandle): Effect.Effect<void> {
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
      if (command._tag === 'SendMessage') {
        yield* Effect.logDebug('Received SendMessage command', { paneId: command.paneId })
        yield* handle
          .sendMessage(command.text)
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError('Failed to send message to pane', { paneId: command.paneId, cause })
            )
          )
      }
    })
  )
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
