import { assert, describe, it } from '@effect/vitest'
import { ProjectId } from '@shared/domain/project'
import { Effect, Exit, Layer, Option, Ref, Scope } from 'effect'
import type { AgentSession } from '../session/agent-backend'
import { AttachedSessions, AttachedSessionsLive, SessionAttacherLive } from './attached-sessions'
import { EventHub } from './event-hub'
import { PaneChatProjection } from './pane-chat-projection'
import { PaneSupervisor } from './pane-supervisor'

const PANE = '00000000-0000-4000-8000-0000000000a1'

const display = {
  config: {
    paneId: PANE,
    cwd: '/assistant',
    model: 'm',
    thinkingLevel: 'adaptive' as const,
    permissionMode: 'dontAsk' as const
  },
  projectId: null,
  label: 'Executive assistant',
  caption: ''
}

const collaborators = Layer.mergeAll(
  Layer.succeed(PaneSupervisor, {
    attachPane: () => Effect.void
  } as unknown as PaneSupervisor['Service']),
  Layer.succeed(PaneChatProjection, {
    seed: () => Effect.void,
    release: () => Effect.void
  } as unknown as PaneChatProjection['Service']),
  Layer.succeed(EventHub, { publish: () => Effect.void } as unknown as EventHub['Service']),
  SessionAttacherLive
)

const attachedSessions = AttachedSessionsLive.pipe(Layer.provide(collaborators))

const attachWith = (reset: Option.Option<Effect.Effect<void>>) =>
  Effect.gen(function* () {
    const service = yield* AttachedSessions
    const scope = yield* Scope.make()
    yield* service
      .attach({
        display,
        resume: Option.none(),
        open: () => Effect.succeed({} as AgentSession),
        reset
      })
      .pipe(Scope.provide(scope))
    return { service, scope }
  })

describe('AttachedSessions.reset', () => {
  it.effect(
    'runs the reset of the session attached as the pane, and publishes it as resettable',
    () =>
      Effect.gen(function* () {
        const resets = yield* Ref.make(0)
        const { service } = yield* attachWith(Option.some(Ref.update(resets, (n) => n + 1)))

        yield* service.reset(PANE)

        assert.deepStrictEqual(
          [yield* Ref.get(resets), (yield* service.current).map((session) => session.resettable)],
          [1, [true]]
        )
      }).pipe(Effect.provide(attachedSessions))
  )

  it.effect('publishes a session with no reset as not resettable, and ignores a reset of it', () =>
    Effect.gen(function* () {
      const { service } = yield* attachWith(Option.none())

      yield* service.reset(PANE)

      assert.deepStrictEqual(
        (yield* service.current).map((session) => [session.projectId, session.resettable]),
        [[null, false]]
      )
    }).pipe(Effect.provide(attachedSessions))
  )

  it.effect('no longer runs the reset once the session is detached', () =>
    Effect.gen(function* () {
      const resets = yield* Ref.make(0)
      const { service, scope } = yield* attachWith(Option.some(Ref.update(resets, (n) => n + 1)))

      yield* Scope.close(scope, Exit.void)
      yield* service.reset(PANE)

      assert.deepStrictEqual([yield* Ref.get(resets), yield* service.current], [0, []])
    }).pipe(Effect.provide(attachedSessions))
  )
})
