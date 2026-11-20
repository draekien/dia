import type { StartupEvent, StartupLog } from '@shared/domain/startup'
import { CHANNEL, IpcEvent, StartupLogChanged } from '@shared/ipc/contract'
import { Clock, Effect, Ref, Schema } from 'effect'

const encodeEvent = Schema.encodeSync(IpcEvent)

/**
 * Where a {@link StartupRecorder} pushes `StartupLogChanged`: the `send` of the main window's
 * `WebContents`, narrowed so tests can pass a fake sender.
 */
export interface StartupEventSender {
  readonly send: (channel: string, ...args: ReadonlyArray<unknown>) => void
}

/**
 * main's record of the current Host run's startup. `record` stamps `event` with the current time,
 * appends it to the log and pushes the whole log to the renderer as `StartupLogChanged`; a
 * `HostStarting` first empties the log, so the log always covers one Host run. `record` never
 * suspends, so it can run synchronously and keeps the order of its calls. `current` reads the log
 * for a renderer that mounts after some steps were recorded.
 */
export interface StartupRecorder {
  readonly record: (event: StartupEvent) => Effect.Effect<void>
  readonly current: Effect.Effect<StartupLog>
}

/**
 * Builds a {@link StartupRecorder} over `sender`, holding an empty log. Build one per app run,
 * before the Host process starts, and back the `getStartupLog` IPC handler with its `current`.
 */
export const makeStartupRecorder = Effect.fn('makeStartupRecorder')(function* (
  sender: StartupEventSender
) {
  const logRef = yield* Ref.make<StartupLog>([])

  const record = Effect.fnUntraced(function* (event: StartupEvent) {
    const atMillis = yield* Clock.currentTimeMillis
    const entry = { atMillis, event }
    const startsNewRun = event._tag === 'HostStarting'
    const log = yield* Ref.updateAndGet(logRef, (previous) =>
      startsNewRun ? [entry] : [...previous, entry]
    )
    if (startsNewRun) yield* Effect.logInfo('Startup log reset for a new Host run')
    yield* Effect.logDebug('Startup step recorded', { event })
    yield* Effect.sync(() =>
      sender.send(CHANNEL.event, encodeEvent(StartupLogChanged.make({ log })))
    )
  })

  return { record, current: Ref.get(logRef) } satisfies StartupRecorder
})
