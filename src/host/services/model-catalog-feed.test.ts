import { assert, describe, it } from '@effect/vitest'
import {
  type ModelCatalogState,
  ModelsLoading,
  ModelsReady,
  ModelsUnavailable
} from '@shared/domain/model'
import { type IpcEvent, ModelsChanged } from '@shared/ipc/contract'
import { DateTime, Effect, Layer, Option, Stream, SubscriptionRef } from 'effect'
import { TestClock } from 'effect/testing'
import { HostPlugins } from '../plugins/host-plugins'
import { AGENT_BACKEND_KEY, type AgentBackend } from '../session/agent-backend'
import { EventHub } from './event-hub'
import { ModelCatalogFeed, ModelCatalogFeedLive } from './model-catalog-feed'

const STARTED_AT_MILLIS = 5_000

const READY = ModelsReady.make({
  models: [
    {
      value: 'sonnet',
      displayName: 'Sonnet',
      description: '',
      adaptiveThinking: true,
      effortLevels: ['low', 'medium', 'high'],
      autoMode: true,
      fastMode: false
    }
  ],
  fetchedAt: DateTime.makeUnsafe(STARTED_AT_MILLIS),
  refreshing: false
})

const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

const backendWith = (
  models: AgentBackend['models'],
  refreshModels: AgentBackend['refreshModels'] = () => Effect.void
): AgentBackend => ({
  openSession: () => Effect.die('not called'),
  readHistory: () => Effect.die('not called'),
  models,
  refreshModels,
  status: () => Stream.empty,
  checkHealth: () => Effect.void,
  setInstallPath: () => Effect.void,
  disabledPermissionModes: () => Effect.succeed([])
})

const feedWith = (backend: Option.Option<AgentBackend>, published: Array<IpcEvent>) =>
  Layer.provide(
    ModelCatalogFeedLive,
    Layer.mergeAll(
      Layer.succeed(HostPlugins)({
        list: () => Effect.succeed([]),
        start: () => Effect.void,
        changes: Stream.empty,
        load: () => Effect.die(new Error('load should not be called in these tests')),
        unload: () => Effect.die(new Error('unload should not be called in these tests')),
        inject: (key) => Effect.succeed(key === AGENT_BACKEND_KEY ? backend : Option.none())
      }),
      Layer.succeed(EventHub)({
        publish: (event) =>
          Effect.sync(() => {
            published.push(event)
          }),
        subscribe: () => Stream.empty
      })
    )
  )

const startFeed = Effect.gen(function* () {
  yield* TestClock.setTime(STARTED_AT_MILLIS)
  const feed = yield* ModelCatalogFeed
  yield* feed.start
  return feed
})

describe('ModelCatalogFeed', () => {
  it.effect('is Loading at revision 0 before start', () =>
    Effect.gen(function* () {
      const feed = yield* ModelCatalogFeed

      assert.deepStrictEqual(yield* feed.current, { revision: 0, state: ModelsLoading.make({}) })
    }).pipe(Effect.provide(feedWith(Option.none(), [])))
  )

  it.effect('holds Unavailable when no agent adapter is loaded', () =>
    Effect.gen(function* () {
      const feed = yield* startFeed

      const current = yield* feed.current

      assert.deepStrictEqual(
        current.state,
        ModelsUnavailable.make({
          message: 'The claude-code adapter is not loaded',
          refreshing: false
        })
      )
    }).pipe(Effect.provide(feedWith(Option.none(), [])))
  )

  it.effect('stamps the first state with the current time so it outranks an earlier run', () =>
    Effect.gen(function* () {
      const feed = yield* startFeed

      assert.deepStrictEqual(yield* feed.current, { revision: STARTED_AT_MILLIS, state: READY })
    }).pipe(Effect.provide(feedWith(Option.some(backendWith(() => Stream.make(READY))), [])))
  )

  it.effect('publishes each state it forwards as ModelsChanged', () => {
    const published: Array<IpcEvent> = []
    return Effect.gen(function* () {
      const feed = yield* startFeed

      assert.deepStrictEqual(published, [ModelsChanged.make({ snapshot: yield* feed.current })])
    }).pipe(Effect.provide(feedWith(Option.some(backendWith(() => Stream.make(READY))), published)))
  })

  it.effect('raises the revision by one for a change within the same millisecond', () =>
    Effect.gen(function* () {
      const states = yield* SubscriptionRef.make<ModelCatalogState>(ModelsLoading.make({}))
      yield* Effect.gen(function* () {
        const feed = yield* startFeed

        yield* SubscriptionRef.set(states, READY)
        yield* settle

        assert.deepStrictEqual(yield* feed.current, {
          revision: STARTED_AT_MILLIS + 1,
          state: READY
        })
      }).pipe(
        Effect.provide(
          feedWith(Option.some(backendWith(() => SubscriptionRef.changes(states))), [])
        )
      )
    })
  )

  it.effect('refresh asks the agent adapter to re-read the list', () => {
    const refreshes = { count: 0 }
    const backend = backendWith(
      () => Stream.make(READY),
      () =>
        Effect.sync(() => {
          refreshes.count += 1
        })
    )
    return Effect.gen(function* () {
      const feed = yield* startFeed

      yield* feed.refresh

      assert.strictEqual(refreshes.count, 1)
    }).pipe(Effect.provide(feedWith(Option.some(backend), [])))
  })
})
