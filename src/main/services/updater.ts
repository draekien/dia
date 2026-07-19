import {
  DEFAULT_UPDATE_STATUS,
  UpdateChecking,
  UpdateDownloading,
  UpdateError,
  UpdateReady,
  type UpdateStatus,
  UpdateUpToDate
} from '@shared/domain/update'
import { CHANNEL, IpcEvent, UpdateStatusChanged } from '@shared/ipc/contract'
import { Effect, Match, Ref, Schema } from 'effect'

const encodeEvent = Schema.encodeSync(IpcEvent)

/**
 * The minimal renderer-facing sink the updater bridge pushes events into: the
 * `send` of an Electron `WebContents`, narrowed so tests can pass a fake sender.
 */
export interface UpdateEventSender {
  readonly send: (channel: string, ...args: ReadonlyArray<unknown>) => void
}

/**
 * A normalized self-update signal, decoupled from electron-updater's event
 * surface so the rest of the app (and tests) never depend on that library. The
 * composition root translates electron-updater events into these; the bridge
 * turns them into renderer-facing {@link UpdateStatus}.
 */
export type UpdaterSignal =
  | { readonly _tag: 'Checking' }
  | { readonly _tag: 'NotAvailable' }
  | { readonly _tag: 'Progress'; readonly percent: number }
  | { readonly _tag: 'Downloaded'; readonly version: string }
  | { readonly _tag: 'Failed'; readonly message: string }

/**
 * Maps a normalized {@link UpdaterSignal} to the {@link UpdateStatus} the
 * renderer holds. Pure and total — the single place the updater's event
 * vocabulary becomes app state.
 */
export const toUpdateStatus = (signal: UpdaterSignal): UpdateStatus =>
  Match.value(signal).pipe(
    Match.tag('Checking', () => UpdateChecking.make({})),
    Match.tag('NotAvailable', () => UpdateUpToDate.make({})),
    Match.tag('Progress', ({ percent }) => UpdateDownloading.make({ percent })),
    Match.tag('Downloaded', ({ version }) => UpdateReady.make({ version })),
    Match.tag('Failed', ({ message }) => UpdateError.make({ message })),
    Match.exhaustive
  )

/**
 * The handle a wired updater bridge exposes: `report` records a normalized
 * signal (updating the held status, logging it, and pushing a
 * {@link UpdateStatusChanged} event to the renderer), and `current` reads the
 * latest status so a late-mounting renderer can seed itself over the
 * `getUpdateStatus` channel.
 */
export interface UpdaterBridge {
  readonly report: (signal: UpdaterSignal) => Effect.Effect<void>
  readonly current: Effect.Effect<UpdateStatus>
}

/**
 * Builds an {@link UpdaterBridge} over `sender`. Register the composition root's
 * electron-updater listeners to call `report`, and back the `getUpdateStatus`
 * IPC handler with `current`. Starts holding {@link DEFAULT_UPDATE_STATUS}.
 */
export const makeUpdaterBridge = Effect.fn('makeUpdaterBridge')(function* (
  sender: UpdateEventSender
) {
  const statusRef = yield* Ref.make(DEFAULT_UPDATE_STATUS)

  const report = (signal: UpdaterSignal): Effect.Effect<void> =>
    Effect.gen(function* () {
      const status = toUpdateStatus(signal)
      yield* Ref.set(statusRef, status)
      yield* Effect.logInfo('Update status changed', { status: status._tag })
      yield* Effect.sync(() =>
        sender.send(CHANNEL.event, encodeEvent(UpdateStatusChanged.make({ status })))
      )
    })

  return {
    report,
    current: Ref.get(statusRef)
  } satisfies UpdaterBridge
})
