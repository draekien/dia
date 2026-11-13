import {
  Attention,
  type HostPluginContext,
  type PluginSetup,
  type RunInfo,
  type RunRequest,
  type Runs,
  RunsKey
} from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Fiber, Option, Schema, Stream, SubscriptionRef } from 'effect'
import { servePluginCall, subscribePlugin } from '../../src/host/plugins/plugin-messages'
import { InboxItem } from './calls'
import setup from './host'

const INBOX = 'dia-inbox'
const RUNS = 'fake-runs'
const TABLESS_RUN = 'aaaaaaaa-0000-4000-8000-000000000001'
const TAB_RUN = 'bbbbbbbb-0000-4000-8000-000000000002'

const permission = (requestId: string) =>
  Attention.PermissionRequest.make({ requestId, toolName: 'Bash', input: { command: 'ls' } })

const runInfo = (runId: string, cwd: string): RunInfo => ({
  runId,
  cwd,
  model: 'sonnet',
  thinkingLevel: 'off',
  permissionMode: 'default',
  sessionId: Option.none(),
  status: 'waiting',
  live: true
})

const fakeRuns = (requests: SubscriptionRef.SubscriptionRef<ReadonlyArray<RunRequest>>): Runs => {
  const nothing = () => Effect.void
  return {
    open: () => Effect.die('not used'),
    start: () => Effect.die('not used'),
    send: nothing,
    editQueued: nothing,
    removeQueued: nothing,
    sendQueuedNow: nothing,
    answer: nothing,
    requests: SubscriptionRef.changes(requests),
    busy: Stream.make([]),
    interrupt: nothing,
    resumeParked: nothing,
    rewind: nothing,
    setThinkingLevel: nothing,
    setPermissionMode: nothing,
    setModel: nothing,
    awaitIdle: nothing,
    isLive: () => Effect.succeed(true),
    close: nothing,
    retire: nothing,
    list: Effect.succeed([runInfo(TABLESS_RUN, '/repo/a'), runInfo(TAB_RUN, '/repo/b')]),
    openInTab: nothing,
    changes: Stream.empty,
    discoverSessions: () => Effect.succeed([])
  }
}

const manifestOf = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const startInbox = (requests: SubscriptionRef.SubscriptionRef<ReadonlyArray<RunRequest>>) =>
  Effect.gen(function* () {
    const provideRuns: PluginSetup<HostPluginContext> = (ctx) =>
      ctx.provide(RunsKey, fakeRuns(requests))
    const setups: Record<string, PluginSetup<HostPluginContext>> = {
      [INBOX]: setup,
      [RUNS]: provideRuns
    }
    const registry = yield* makePluginRegistry<HostPluginContext>({
      catalog: {
        names: () => Effect.succeed([RUNS, INBOX]),
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
    yield* registry.load(RUNS)
    yield* registry.load(INBOX)
    return yield* subscribePlugin(registry, { plugin: INBOX, tag: 'FollowInbox', payload: {} })
  })

const decodeItems = Schema.decodeUnknownSync(Schema.Array(InboxItem))

const inboxUntil = (
  updates: Stream.Stream<unknown, unknown>,
  done: (items: ReadonlyArray<InboxItem>) => boolean
) =>
  updates.pipe(
    Stream.map((value) => decodeItems(value)),
    Stream.filter(done),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.forkScoped({ startImmediately: true })
  )

describe('dia-inbox host entry', () => {
  it.live('lists the permission request of a run with no tab, with the run’s folder', () =>
    Effect.gen(function* () {
      const requests = yield* SubscriptionRef.make<ReadonlyArray<RunRequest>>([])
      const updates = yield* startInbox(requests)
      const listed = yield* inboxUntil(updates, (items) => items.length > 0)

      yield* SubscriptionRef.set(requests, [{ runId: TABLESS_RUN, request: permission('p1') }])

      const items = yield* Fiber.join(listed)
      assert.deepStrictEqual(
        items.map((item) => [item.runId, item.cwd, item.request.requestId]),
        [[TABLESS_RUN, '/repo/a', 'p1']]
      )
    })
  )

  it.live('drops a request once its run no longer lists it, as after an answer in a tab', () =>
    Effect.gen(function* () {
      const requests = yield* SubscriptionRef.make<ReadonlyArray<RunRequest>>([
        { runId: TABLESS_RUN, request: permission('p1') },
        { runId: TAB_RUN, request: permission('p2') }
      ])
      const updates = yield* startInbox(requests)
      const shrunk = yield* inboxUntil(updates, (items) => items.length === 1)

      yield* SubscriptionRef.set(requests, [{ runId: TABLESS_RUN, request: permission('p1') }])

      const items = yield* Fiber.join(shrunk)
      assert.deepStrictEqual(
        items.map((item) => item.request.requestId),
        ['p1']
      )
    })
  )
})
