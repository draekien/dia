import { assert, describe, it } from '@effect/vitest'
import { MessageUpdated } from '@shared/domain/agent-event'
import { emptyPaneChatState } from '@shared/domain/pane-chat'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { fakeInject } from '@shared/plugin/plugin-registry.fake'
import { Deferred, Effect, Fiber, Option, PubSub, Stream } from 'effect'
import { RunEventLog, RunEventLogLive, RunEventLogRegistry } from './run-event-log'
import {
  type CommittedEvent,
  ReloadRequired,
  type RunEvents,
  RunEventsKey
} from './run-events-seam'

const RUN = '11111111-1111-4111-8111-111111111111'

const committedAt = (sequence: number): CommittedEvent => ({
  runId: RUN,
  sequence,
  event: MessageUpdated.make({
    itemId: `m${sequence}`,
    message: { role: 'assistant', content: `${sequence}` },
    streaming: false
  })
})

const providerOf = (
  startSequence: number,
  committed: Stream.Stream<CommittedEvent>
): RunEvents => ({
  append: () => Effect.succeed([Option.some(startSequence + 1)]),
  committed,
  readAfter: () => Effect.die('not called'),
  highestSequence: Effect.succeed(startSequence),
  startSequence,
  record: () => Effect.succeed(() => Effect.void),
  snapshot: () => Effect.succeed({ state: emptyPaneChatState, seq: startSequence }),
  seed: () => Effect.void,
  release: () => Effect.void
})

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

const withLog = <A, E>(
  body: (env: {
    readonly log: RunEventLog['Service']
    readonly provide: (events: Option.Option<RunEvents>) => Effect.Effect<void>
  }) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    let provided = Option.none<RunEvents>()
    const changes = yield* PubSub.unbounded<string>()
    const holder = yield* Deferred.make<Pick<PluginRegistry, 'inject' | 'changes'>>()
    yield* Deferred.succeed(holder, {
      inject: fakeInject((key) => (key === RunEventsKey.name ? provided : Option.none())),
      changes: Stream.fromPubSub(changes)
    })
    const log = yield* Effect.gen(function* () {
      return yield* RunEventLog
    }).pipe(Effect.provide(RunEventLogLive), Effect.provideService(RunEventLogRegistry, holder))
    const provide = (events: Option.Option<RunEvents>) =>
      Effect.gen(function* () {
        provided = events
        yield* PubSub.publish(changes, RunEventsKey.name)
        yield* settle
      })
    return yield* body({ log, provide })
  })

describe('RunEventLog with no provider', () => {
  it.effect('fails an append with RunEventWriteError', () =>
    withLog(({ log }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(log.append(RUN, []))

        assert.strictEqual(error._tag, 'RunEventWriteError')
      })
    )
  )

  it.effect('tells a replay to reload', () =>
    withLog(({ log }) =>
      Effect.gen(function* () {
        const read = yield* log.readAfter(RUN, 3, { maxEvents: 1, maxBytes: 1 })

        assert.deepStrictEqual(read, ReloadRequired.make({ reason: 'readFailed' }))
      })
    )
  )

  it.effect('serves an empty chat at sequence 0', () =>
    withLog(({ log }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* log.snapshot(RUN), { state: emptyPaneChatState, seq: 0 })
      })
    )
  )
})

describe('RunEventLog with a provider', () => {
  it.effect('forwards each call to the provider loaded at the time of the call', () =>
    withLog(({ log, provide }) =>
      Effect.gen(function* () {
        yield* provide(Option.some(providerOf(5, Stream.empty)))
        const first = yield* log.snapshot(RUN)
        yield* provide(Option.some(providerOf(9, Stream.empty)))
        const second = yield* log.snapshot(RUN)

        assert.deepStrictEqual([first.seq, second.seq], [5, 9])
      })
    )
  )

  it.effect('keeps the first provider’s start sequence after a reload', () =>
    withLog(({ log, provide }) =>
      Effect.gen(function* () {
        yield* provide(Option.some(providerOf(5, Stream.empty)))
        yield* log.snapshot(RUN)
        yield* provide(Option.some(providerOf(9, Stream.empty)))
        yield* log.snapshot(RUN)

        assert.strictEqual(yield* log.hostStartSequence, 5)
      })
    )
  )

  it.effect('follows committed events across a provider change', () =>
    withLog(({ log, provide }) =>
      Effect.gen(function* () {
        const before = yield* PubSub.unbounded<CommittedEvent>()
        const after = yield* PubSub.unbounded<CommittedEvent>()
        const received = yield* log.committed.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* provide(Option.some(providerOf(0, Stream.fromPubSub(before))))
        yield* PubSub.publish(before, committedAt(1))
        yield* settle

        yield* provide(Option.some(providerOf(1, Stream.fromPubSub(after))))
        yield* PubSub.publish(before, committedAt(99))
        yield* PubSub.publish(after, committedAt(2))

        const sequences = (yield* Fiber.join(received)).map(({ sequence }) => sequence)
        assert.deepStrictEqual(sequences, [1, 2])
      })
    )
  )
})
