import type { AttachedSession } from '@shared/domain/attached-session'
import type { PaneId } from '@shared/domain/pane'
import { AttachedSessionsChanged } from '@shared/ipc/contract'
import { Context, Deferred, Effect, Layer, Option, Ref, type Stream, SubscriptionRef } from 'effect'
import type { HostSessions, SessionAttachment } from '../plugins/host-plugin-context'
import { EventHub } from './event-hub'
import { PaneChatProjection } from './pane-chat-projection'
import { PaneSupervisor } from './pane-supervisor'

/**
 * Where `HostPlugins` finds `HostSessions['attach']` without depending on the services it uses,
 * which themselves depend on `HostPlugins`. {@link AttachedSessionsLive} completes it when built;
 * await it on each call. Build {@link SessionAttacherLive} once per Host and provide that layer to
 * both `HostPlugins` and {@link AttachedSessionsLive}.
 */
export class SessionAttacher extends Context.Service<
  SessionAttacher,
  Deferred.Deferred<HostSessions['attach']>
>()('SessionAttacher') {}

/** Builds an empty {@link SessionAttacher}. */
export const SessionAttacherLive = Layer.effect(
  SessionAttacher,
  Deferred.make<HostSessions['attach']>()
)

/**
 * The sessions plugins have attached to the Host (ADR-0070). `attach` behaves as
 * `HostSessions['attach']`; `current` reads the attached sessions; `changes` emits them now and
 * after each change; `reset` runs the `reset` of the session attached as `paneId`, and does
 * nothing when it has none or no session is attached there. Each change is also published as `AttachedSessionsChanged`, before the
 * attached session can emit its first event. Provide with {@link AttachedSessionsLive}.
 */
export class AttachedSessions extends Context.Service<
  AttachedSessions,
  {
    readonly attach: HostSessions['attach']
    readonly current: Effect.Effect<ReadonlyArray<AttachedSession>>
    readonly changes: Stream.Stream<ReadonlyArray<AttachedSession>>
    readonly reset: (paneId: PaneId) => Effect.Effect<void>
  }
>()('AttachedSessions') {}

/** The live {@link AttachedSessions}; it also completes {@link SessionAttacher}. */
export const AttachedSessionsLive = Layer.effect(
  AttachedSessions,
  Effect.gen(function* () {
    const supervisor = yield* PaneSupervisor
    const paneChats = yield* PaneChatProjection
    const hub = yield* EventHub
    const attacher = yield* SessionAttacher
    const list = yield* SubscriptionRef.make<ReadonlyArray<AttachedSession>>([])
    const resets = yield* Ref.make<ReadonlyMap<PaneId, Effect.Effect<void>>>(new Map())

    const update = (
      f: (current: ReadonlyArray<AttachedSession>) => ReadonlyArray<AttachedSession>
    ) =>
      SubscriptionRef.updateAndGet(list, f).pipe(
        Effect.flatMap((sessions) => hub.publish(AttachedSessionsChanged.make({ sessions })))
      )

    const attach = Effect.fn('AttachedSessions.attach')(function* (attachment: SessionAttachment) {
      const display: AttachedSession = {
        ...attachment.display,
        resettable: Option.isSome(attachment.reset)
      }
      const paneId = display.config.paneId
      yield* Effect.acquireRelease(
        Ref.update(resets, (current) =>
          Option.match(attachment.reset, {
            onNone: () => current,
            onSome: (reset) => new Map(current).set(paneId, reset)
          })
        ).pipe(
          Effect.andThen(
            update((current) => [...current.filter((s) => s.config.paneId !== paneId), display])
          )
        ),
        () =>
          Ref.update(resets, (current) => {
            const next = new Map(current)
            next.delete(paneId)
            return next
          }).pipe(
            Effect.andThen(update((current) => current.filter((s) => s.config.paneId !== paneId))),
            Effect.andThen(paneChats.release(paneId)),
            Effect.andThen(Effect.logInfo('Detached a plugin session', { paneId }))
          )
      )
      yield* paneChats.seed(paneId)
      yield* supervisor.attachPane(attachment, hub.publish)
      yield* Effect.logInfo('Attached a plugin session to the overview', {
        paneId,
        projectId: display.projectId
      })
    })

    const reset = Effect.fn('AttachedSessions.reset')(function* (paneId: PaneId) {
      const found = (yield* Ref.get(resets)).get(paneId)
      if (found === undefined) {
        yield* Effect.logWarning('No reset for this pane; ignored the request', { paneId })
        return
      }
      yield* Effect.logInfo('Resetting an attached session', { paneId })
      yield* found
    })

    yield* Deferred.succeed(attacher, attach)
    return AttachedSessions.of({
      attach,
      current: SubscriptionRef.get(list),
      changes: SubscriptionRef.changes(list),
      reset
    })
  })
)
