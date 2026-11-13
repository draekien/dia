import type { HostPluginContext } from '@dia/plugin'
import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { MessageUpdated } from '@shared/domain/agent-event'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Fiber, FileSystem, Option, Schema, type Scope, Stream } from 'effect'
import { servePluginCall, subscribePlugin } from '../../src/host/plugins/plugin-messages'
import { makePluginDatabase, openDatabase } from '../../src/host/services/database'
import { kernelMigrations } from '../../src/host/services/kernel-migrations'
import { RunEventsKey, StoredEvent } from '../../src/host/services/run-events-seam'
import { RunChatUpdate } from './calls'
import setup from './host'

const NAME = 'dia-run-events'
const RUN = '11111111-1111-4111-8111-111111111111'
const OTHER_RUN = '22222222-2222-4222-8222-222222222222'

const manifest: PluginManifest = {
  name: NAME,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
}

const reply = (itemId: string, content: string) =>
  MessageUpdated.make({ itemId, message: { role: 'assistant', content }, streaming: false })

const workspaceWithTab = {
  projects: [
    {
      project: {
        projectId: '33333333-3333-4333-8333-333333333333',
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'repo',
        isGitRepo: false
      },
      tabs: [
        {
          name: 'heron',
          config: {
            paneId: RUN,
            cwd: '/repo',
            model: 'm',
            thinkingLevel: 'adaptive',
            permissionMode: 'default'
          },
          archived: false
        }
      ]
    }
  ],
  visibleTab: null
}

const startPlugin = (userData: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataDir = `${userData}/plugins/${NAME}`
    yield* fs.makeDirectory(dataDir, { recursive: true })
    const registry = yield* makePluginRegistry<HostPluginContext>({
      catalog: {
        names: () => Effect.succeed([NAME]),
        resolve: (name) => Effect.succeed(Option.some({ root: name, origin: 'default' as const }))
      },
      loader: {
        peek: () => Effect.succeed(manifest),
        load: (_name, _root, use) =>
          use({
            manifest,
            resolveSetup: Effect.succeed(Option.some(setup)),
            importers: []
          })
      },
      extend: (services) => {
        const served = new Set<string>()
        const serve: HostPluginContext['serve'] = (rpc, handler) =>
          servePluginCall(services, served, rpc, handler)
        return Effect.succeed({
          ...services,
          dataDir,
          database: makePluginDatabase(`${dataDir}/data.db`, services.name),
          workspace: Stream.make(workspaceWithTab),
          serve
        } as unknown as HostPluginContext)
      }
    })
    yield* registry.load(NAME)
    return registry
  })

const runEventsOf = (registry: PluginRegistry) =>
  Effect.map(registry.inject(RunEventsKey), Option.getOrThrow)

const inUserData = <A, E>(
  body: (userData: string) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const userData = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-run-events-host-' })
    return yield* body(userData)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('dia-run-events host entry', () => {
  it.effect("serves a tab's conversation copied from host.db at its first start", () =>
    inUserData((userData) =>
      Effect.gen(function* () {
        const host = yield* openDatabase(`${userData}/host.db`, kernelMigrations)
        yield* host`INSERT INTO agent_events ${host.insert({
          sequence: 1,
          agent_id: RUN,
          event_type: 'MessageUpdated',
          item_id: 'm1',
          source_uuid: null,
          occurred_at: 0,
          payload_json: Schema.encodeSync(Schema.fromJsonString(StoredEvent))(
            reply('m1', 'from before')
          )
        })}`
        yield* host`INSERT INTO agent_items ${host.insert({
          agent_id: RUN,
          item_id: 'm1',
          position: 0,
          kind: 'message',
          streaming: 0,
          payload_json: JSON.stringify({ message: { role: 'assistant', content: 'from before' } })
        })}`
        const registry = yield* startPlugin(userData)

        const { state, seq } = yield* (yield* runEventsOf(registry)).snapshot(RUN)

        assert.deepStrictEqual(
          [
            state.messages.flatMap((message) =>
              message.parts.map((part) => (part.type === 'text' ? part.content : part.type))
            ),
            seq
          ],
          [['from before'], 1]
        )
      })
    )
  )

  it.effect('streams a run chat snapshot, then only that run’s later events in order', () =>
    inUserData((userData) =>
      Effect.gen(function* () {
        const registry = yield* startPlugin(userData)
        const runEvents = yield* runEventsOf(registry)
        yield* runEvents.append(RUN, [{ event: reply('m0', 'before following') }])
        const updates = yield* subscribePlugin(registry, {
          plugin: NAME,
          tag: 'FollowRunChat',
          payload: { runId: RUN }
        })
        const following = yield* updates.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow

        yield* runEvents.append(OTHER_RUN, [{ event: reply('x1', 'other run') }])
        const [first] = yield* runEvents.append(RUN, [{ event: reply('m1', 'one') }])
        const [second] = yield* runEvents.append(RUN, [{ event: reply('m2', 'two') }])

        const received = (yield* Fiber.join(following)).map((value) =>
          Schema.decodeUnknownSync(RunChatUpdate)(value)
        )
        assert.deepStrictEqual(
          received.map((update) =>
            update._tag === 'RunChatSnapshot'
              ? `snapshot@${update.snapshot.seq}`
              : `event@${update.sequence}`
          ),
          ['snapshot@1', `event@${Option.getOrThrow(first)}`, `event@${Option.getOrThrow(second)}`]
        )
      })
    )
  )
})
