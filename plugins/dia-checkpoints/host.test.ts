import {
  Attention,
  type CommittedEvent,
  GitKey,
  type HostPluginContext,
  PaneEvents,
  type PluginSetup,
  type RunEvents,
  RunEventsKey,
  type RunInfo,
  type Runs,
  RunsKey,
  type StoredEvent
} from '@dia/plugin'
import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, FileSystem, Option, Path, PubSub, Queue, Schema, Stream } from 'effect'
import { servePluginCall, subscribePlugin } from '../../src/host/plugins/plugin-messages'
import { TurnChanges, TurnFinished } from './calls'
import setup from './host'

const CHECKPOINTS = 'dia-checkpoints'
const FAKES = 'fake-services'
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

const runInfo = (cwd: string): RunInfo => ({
  runId: RUN,
  cwd,
  model: 'sonnet',
  thinkingLevel: 'off',
  permissionMode: 'default',
  sessionId: Option.none(),
  status: 'running',
  live: true
})

const fakeRuns = (cwd: string): Runs => {
  const nothing = () => Effect.void
  return {
    open: () => Effect.die('not used'),
    start: () => Effect.die('not used'),
    send: nothing,
    editQueued: nothing,
    removeQueued: nothing,
    sendQueuedNow: nothing,
    answer: nothing,
    requests: Stream.make([]),
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
    list: Effect.succeed([runInfo(cwd)]),
    openInTab: nothing,
    changes: Stream.empty,
    discoverSessions: () => Effect.succeed([])
  }
}

const fakeRunEvents = (committed: PubSub.PubSub<CommittedEvent>): RunEvents => ({
  append: () => Effect.die('not used'),
  committed: Stream.fromPubSub(committed),
  subscribe: Effect.map(PubSub.subscribe(committed), Stream.fromSubscription),
  readAfter: () => Effect.die('not used'),
  readTagged: () => Effect.die('not used'),
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

const decodeTurns = Schema.decodeUnknownSync(Schema.Array(TurnChanges))

const startPlugin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = yield* makeGit
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-checkpoints-host-' })
  yield* Effect.addFinalizer(() => git.stopFsmonitor(directory))
  yield* git.init(directory)
  yield* fs.writeFileString(path.join(directory, 'a.txt'), 'one\n')
  yield* git.commitAll(directory, { message: 'init', author: { name: 'dia', email: 'dia@x' } })

  const committed = yield* PubSub.unbounded<CommittedEvent>()
  let sequence = 0
  const publish = (event: StoredEvent) =>
    PubSub.publish(committed, { runId: RUN, sequence: ++sequence, event })
  const provideFakes: PluginSetup<HostPluginContext> = (ctx) =>
    Effect.gen(function* () {
      yield* ctx.provide(RunsKey, fakeRuns(directory))
      yield* ctx.provide(RunEventsKey, fakeRunEvents(committed))
      yield* ctx.provide(GitKey, git)
    })
  const setups: Record<string, PluginSetup<HostPluginContext>> = {
    [CHECKPOINTS]: setup,
    [FAKES]: provideFakes
  }
  const registry = yield* makePluginRegistry<HostPluginContext>({
    catalog: {
      names: () => Effect.succeed([FAKES, CHECKPOINTS]),
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
  yield* registry.load(CHECKPOINTS)
  const updates = yield* subscribePlugin(registry, {
    plugin: CHECKPOINTS,
    tag: 'FollowRunChanges',
    payload: { runId: RUN }
  })
  const write = (file: string, content: string) =>
    fs.writeFileString(path.join(directory, file), content)
  return { updates, publish, write }
})

describe('dia-checkpoints host entry', { timeout: 30_000 }, () => {
  it.live('lists the files a run changed in a turn its events started and ended', () =>
    Effect.gen(function* () {
      const { updates, publish, write } = yield* startPlugin
      const seen = yield* Queue.unbounded<ReadonlyArray<TurnChanges>>()
      yield* updates.pipe(
        Stream.runForEach((value) => Queue.offer(seen, decodeTurns(value))),
        Effect.forkScoped({ startImmediately: true })
      )
      const firstWith = (tag: TurnChanges['_tag']) =>
        Queue.take(seen).pipe(
          Effect.repeat({ until: (turns) => turns.some((turn) => turn._tag === tag) })
        )

      yield* publish(
        PaneEvents.PaneUserMessagesSent.make({
          paneId: RUN,
          messages: [{ id: 'm1', text: 'Edit a' }]
        })
      )
      yield* firstWith('TurnOpen')
      yield* write('a.txt', 'one\ntwo\n')
      yield* publish(
        PaneEvents.PaneAttentionChanged.make({ paneId: RUN, attention: Attention.Idle.make({}) })
      )
      yield* publish(
        PaneEvents.PaneAttentionChanged.make({
          paneId: RUN,
          attention: Attention.Completed.make({})
        })
      )

      assert.deepStrictEqual(yield* firstWith('TurnFinished'), [
        TurnFinished.make({
          turn: 1,
          prompt: 'Edit a',
          files: [{ path: 'a.txt', added: 1, deleted: 0, binary: false }]
        })
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
