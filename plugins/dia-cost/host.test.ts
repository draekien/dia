import {
  type CommittedEvent,
  type HostPluginContext,
  PaneEvents,
  type PluginSetup,
  RunEventReadError,
  type RunEvents,
  RunEventsKey,
  type TokenUsage
} from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, PubSub, Queue, Schema, Stream } from 'effect'
import { servePluginCall, subscribePlugin } from '../../src/host/plugins/plugin-messages'
import { RunUsage } from './calls'
import setup from './host'

const COST = 'dia-cost'
const FAKES = 'fake-run-events'
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_RUN = 'bbbbbbbb-0000-4000-8000-000000000002'

const tokens = (outputTokens: number): TokenUsage => ({
  inputTokens: 1,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
})

const usageEvent = (runId: string, sequence: number, outputTokens: number): CommittedEvent => ({
  runId,
  sequence,
  event: PaneEvents.PaneTurnUsageReported.make({ paneId: runId, usage: tokens(outputTokens) })
})

const STORED = usageEvent(RUN, 4, 10)

const fakeRunEvents = (
  committed: PubSub.PubSub<CommittedEvent>,
  readTagged: RunEvents['readTagged']
): RunEvents => ({
  append: () => Effect.die('not used'),
  committed: Stream.fromPubSub(committed),
  subscribe: Effect.map(PubSub.subscribe(committed), Stream.fromSubscription),
  readAfter: () => Effect.die('not used'),
  readTagged,
  highestSequence: Effect.succeed(0),
  startSequence: 0,
  record: () => Effect.die('not used'),
  snapshot: () => Effect.die('not used'),
  seed: () => Effect.void,
  release: () => Effect.void
})

const manifestOf = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const decodeUsage = Schema.decodeUnknownSync(RunUsage)

const readStored: RunEvents['readTagged'] = (runId) => Effect.succeed(runId === RUN ? [STORED] : [])

const startPlugin = Effect.fnUntraced(function* (readTagged: RunEvents['readTagged']) {
  const committed = yield* PubSub.unbounded<CommittedEvent>()
  const provideFakes: PluginSetup<HostPluginContext> = (ctx) =>
    ctx.provide(RunEventsKey, fakeRunEvents(committed, readTagged))
  const setups: Record<string, PluginSetup<HostPluginContext>> = {
    [COST]: setup,
    [FAKES]: provideFakes
  }
  const registry = yield* makePluginRegistry<HostPluginContext>({
    catalog: {
      names: () => Effect.succeed([FAKES, COST]),
      resolve: (name) => Effect.succeed(Option.some({ root: name, origin: 'default' as const }))
    },
    loader: {
      peek: (name) => Effect.succeed(manifestOf(name)),
      load: (name, _root, use) =>
        use({
          manifest: manifestOf(name),
          resolveSetup: Effect.succeed(Option.fromNullishOr(setups[name])),
          importers: []
        })
    },
    extend: (services) => {
      const served = new Set<string>()
      const serve: HostPluginContext['serve'] = (rpc, handler) =>
        servePluginCall(services, served, rpc, handler)
      return Effect.succeed({ ...services, serve } as unknown as HostPluginContext)
    }
  })
  yield* registry.load(FAKES)
  yield* registry.load(COST)
  const updates = yield* subscribePlugin(registry, {
    plugin: COST,
    tag: 'FollowRunUsage',
    payload: { runId: RUN }
  })
  const seen = yield* Queue.unbounded<RunUsage>()
  yield* updates.pipe(
    Stream.runForEach((value) => Queue.offer(seen, decodeUsage(value))),
    Effect.forkScoped({ startImmediately: true })
  )
  const withTurns = (count: number) =>
    Queue.take(seen).pipe(Effect.repeat({ until: (usage) => usage.turns.length === count }))
  const outputsOf = (usage: RunUsage) => usage.turns.map((turn) => turn.usage.outputTokens)
  return { committed, seen, withTurns, outputsOf }
})

describe('dia-cost host entry', () => {
  it.live("follows a run's stored usage, then each new turn of that run only", () =>
    Effect.gen(function* () {
      const { committed, withTurns, outputsOf } = yield* startPlugin(readStored)
      const first = yield* withTurns(1)

      yield* PubSub.publish(committed, STORED)
      yield* PubSub.publish(committed, usageEvent(OTHER_RUN, 5, 99))
      yield* PubSub.publish(committed, {
        runId: RUN,
        sequence: 6,
        event: PaneEvents.PaneUserMessagesSent.make({
          paneId: RUN,
          messages: [{ id: 'm2', text: 'next' }]
        })
      })
      yield* PubSub.publish(committed, usageEvent(RUN, 7, 20))
      const second = yield* withTurns(2).pipe(
        Effect.repeat({ until: (usage) => usage.turns[1]?.usage.outputTokens !== 0 })
      )

      assert.deepStrictEqual(
        [outputsOf(first), outputsOf(second), second.total],
        [[10], [10, 20], { ...tokens(30), inputTokens: 2 }]
      )
    }).pipe(Effect.scoped)
  )

  it.live('shows no usage, and stops following, when the stored usage cannot be read', () =>
    Effect.gen(function* () {
      const { committed, seen } = yield* startPlugin(() =>
        Effect.fail(new RunEventReadError({ cause: 'disk' }))
      )
      const first = yield* Queue.take(seen)

      yield* PubSub.publish(committed, usageEvent(RUN, 6, 20))
      yield* Effect.sleep('50 millis')

      assert.deepStrictEqual([first.turns, yield* Queue.size(seen)], [[], 0])
    }).pipe(Effect.scoped)
  )
})
