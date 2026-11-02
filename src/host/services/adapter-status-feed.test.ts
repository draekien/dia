import { assert, describe, it } from '@effect/vitest'
import { type AdapterStatus, HealthReady } from '@shared/domain/adapter-status'
import { DateTime, Effect, Layer, Option, PubSub, Stream } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { AGENT_BACKEND_KEY, type AgentBackend } from '../session/agent-backend'
import { AdapterStatusFeed, AdapterStatusFeedLive } from './adapter-status-feed'
import { EventHub } from './event-hub'

const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

const backendWithStatus = (status: AdapterStatus): AgentBackend => ({
  openSession: () => Effect.die('not called'),
  readHistory: () => Effect.die('not called'),
  models: () => Stream.empty,
  refreshModels: () => Effect.void,
  status: () => Stream.make(status),
  checkHealth: () => Effect.void,
  setInstallPath: () => Effect.void,
  disabledPermissionModes: () => Effect.succeed([]),
  attachmentTypes: () => Effect.succeed([])
})

const feedFollowing = (
  current: () => Option.Option<AgentBackend>,
  changes: PubSub.PubSub<string>
) =>
  Layer.provide(
    AdapterStatusFeedLive,
    Layer.mergeAll(
      Layer.succeed(HostPlugins)({
        list: () => Effect.succeed([]),
        start: () => Effect.void,
        changes: Stream.fromPubSub(changes),
        load: () => Effect.die(new Error('load should not be called in these tests')),
        unload: () => Effect.die(new Error('unload should not be called in these tests')),
        inject: (key) => Effect.sync(() => (key === AGENT_BACKEND_KEY ? current() : Option.none()))
      }),
      Layer.succeed(EventHub)({
        publish: () => Effect.void,
        subscribe: () => Stream.empty,
        lastSeq: () => Effect.succeed(0)
      })
    )
  )

describe('AdapterStatusFeed', () => {
  it.effect('forwards the status of an adapter loaded after start', () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<string>()
      const loadedStatus: AdapterStatus = {
        health: HealthReady.make({
          version: '2.1.0',
          installPath: 'C:/claude',
          checkedAt: DateTime.makeUnsafe(1_000)
        }),
        checking: false,
        installPathOverride: null
      }
      let provided = Option.none<AgentBackend>()
      yield* Effect.gen(function* () {
        const feed = yield* AdapterStatusFeed
        yield* feed.start
        assert.strictEqual((yield* feed.current).status.health._tag, 'HealthError')

        provided = Option.some(backendWithStatus(loadedStatus))
        yield* PubSub.publish(changes, AGENT_BACKEND_KEY)
        yield* settle

        assert.deepStrictEqual((yield* feed.current).status, loadedStatus)
      }).pipe(Effect.provide(feedFollowing(() => provided, changes)))
    })
  )
})
