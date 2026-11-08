import type { AttachedSession } from '@shared/domain/attached-session'
import { AttachedSessionsChanged } from '@shared/ipc/contract'
import { Context, Deferred, Effect, Layer, type Stream, SubscriptionRef } from 'effect'
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
 * after each change. Each change is also published as `AttachedSessionsChanged`, before the
 * attached session can emit its first event. Provide with {@link AttachedSessionsLive}.
 */
export class AttachedSessions extends Context.Service<
  AttachedSessions,
  {
    readonly attach: HostSessions['attach']
    readonly current: Effect.Effect<ReadonlyArray<AttachedSession>>
    readonly changes: Stream.Stream<ReadonlyArray<AttachedSession>>
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

    const update = (
      f: (current: ReadonlyArray<AttachedSession>) => ReadonlyArray<AttachedSession>
    ) =>
      SubscriptionRef.updateAndGet(list, f).pipe(
        Effect.flatMap((sessions) => hub.publish(AttachedSessionsChanged.make({ sessions })))
      )

    const attach = Effect.fn('AttachedSessions.attach')(function* (attachment: SessionAttachment) {
      const { display } = attachment
      const paneId = display.config.paneId
      yield* Effect.acquireRelease(
        update((current) => [...current.filter((s) => s.config.paneId !== paneId), display]),
        () =>
          update((current) => current.filter((s) => s.config.paneId !== paneId)).pipe(
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

    yield* Deferred.succeed(attacher, attach)
    return AttachedSessions.of({
      attach,
      current: SubscriptionRef.get(list),
      changes: SubscriptionRef.changes(list)
    })
  })
)
