import { diaTool, type HostPluginContext, type PluginSetup, type ToolScope } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Deferred, Duration, Effect, FileSystem, Option, Schema, Stream } from 'effect'
import { servePluginCall, subscribePlugin } from '../../src/host/plugins/plugin-messages'
import { PendingApproval } from './calls'
import setup from './host'
import { newToken, type Tools, ToolsKey } from './tools'

const RUN: ToolScope = { runId: 'run-1', project: '/work/dia', labels: [], context: undefined }
const OUTSIDE: ToolScope = { labels: [], context: undefined }

const manifest = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const askingPlugin =
  (provided: Deferred.Deferred<Tools>, answers: Array<string>): PluginSetup<HostPluginContext> =>
  (ctx) =>
    ctx.whenProvided([ToolsKey], ({ tools }) =>
      Effect.gen(function* () {
        yield* tools.register(
          diaTool({
            name: 'ask',
            description: 'Ask the user to approve a change.',
            input: Schema.Struct({}),
            run: (_, scope) =>
              tools.requestApproval(scope, { title: 'Change it', before: 'a', after: 'b' }).pipe(
                Effect.tap((answer) => Effect.sync(() => void answers.push(answer))),
                Effect.map((answer) => ({ text: answer, isError: false }))
              )
          }),
          { when: () => true }
        )
        yield* Deferred.succeed(provided, tools)
      })
    )

const startHost = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dataDir = yield* fs.makeTempDirectoryScoped()
  const provided = yield* Deferred.make<Tools>()
  const answers: Array<string> = []
  const setups: Record<string, PluginSetup<HostPluginContext>> = {
    'dia-tools': setup,
    asker: askingPlugin(provided, answers)
  }
  const registry = yield* makePluginRegistry<HostPluginContext>({
    catalog: {
      names: () => Effect.succeed(Object.keys(setups)),
      resolve: (name) => Effect.succeed(Option.some({ root: name, origin: 'default' as const }))
    },
    loader: {
      peek: (name) => Effect.succeed(manifest(name)),
      load: (name, _root, use) =>
        use({
          manifest: manifest(name),
          resolveSetup: Effect.succeed(Option.fromNullishOr(setups[name])),
          importers: []
        })
    },
    extend: (services) => {
      const served = new Set<string>()
      const serve: HostPluginContext['serve'] = (rpc, handler) =>
        servePluginCall(services, served, rpc, handler)
      return Effect.succeed({ ...services, dataDir, serve } as unknown as HostPluginContext)
    }
  })
  yield* registry.load('dia-tools')
  yield* registry.load('asker')
  return { registry, tools: yield* Deferred.await(provided), answers }
}).pipe(Effect.provide(NodeServices.layer))

const decodePending = Schema.decodeUnknownSync(Schema.Array(PendingApproval))

const whenPending = (registry: PluginRegistry, count: number) =>
  Effect.gen(function* () {
    const stream = yield* subscribePlugin(registry, {
      plugin: 'dia-tools',
      tag: 'WatchApprovals',
      payload: {}
    })
    const found = yield* stream.pipe(
      Stream.map((value) => decodePending(value)),
      Stream.filter((list) => list.length === count),
      Stream.runHead,
      Effect.timeout(Duration.seconds(5))
    )
    return Option.getOrThrow(found)
  })

const askWith = (tools: Tools, scope: ToolScope) =>
  Effect.gen(function* () {
    const { token, hash } = yield* newToken.pipe(Effect.provide(NodeCrypto.layer))
    yield* tools.grant(hash, scope)
    const client = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const created = new Client({ name: 'test', version: '1' })
        await created.connect(
          new StreamableHTTPClientTransport(new URL(tools.url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } }
          })
        )
        return created
      }),
      (created) => Effect.promise(() => created.close())
    )
    yield* Effect.tryPromise(() => client.callTool({ name: 'ask', arguments: {} })).pipe(
      Effect.ignore,
      Effect.forkScoped
    )
    return hash
  })

const answered = (answers: ReadonlyArray<string>, count: number) =>
  Effect.gen(function* () {
    while (answers.length < count) yield* Effect.sleep(Duration.millis(10))
    return answers
  }).pipe(Effect.timeout(Duration.seconds(5)))

describe('dia-tools host entry', () => {
  it.live('revoking one of two tokens of a run declines only the request made under it', () =>
    Effect.gen(function* () {
      const { registry, tools, answers } = yield* startHost
      const revoked = yield* askWith(tools, RUN)
      yield* askWith(tools, RUN)
      yield* whenPending(registry, 2)

      yield* tools.revoke(revoked)

      assert.deepStrictEqual(yield* answered(answers, 1), ['declined'])
      assert.strictEqual((yield* whenPending(registry, 1)).length, 1)
    }).pipe(Effect.scoped)
  )

  it.live('revoking one of two outside tokens declines only the request made under it', () =>
    Effect.gen(function* () {
      const { registry, tools, answers } = yield* startHost
      const revoked = yield* askWith(tools, OUTSIDE)
      yield* askWith(tools, OUTSIDE)
      yield* whenPending(registry, 2)

      yield* tools.revoke(revoked)

      assert.deepStrictEqual(yield* answered(answers, 1), ['declined'])
      assert.strictEqual((yield* whenPending(registry, 1)).length, 1)
    }).pipe(Effect.scoped)
  )

  it.live('unloading dia-tools declines a pending request', () =>
    Effect.gen(function* () {
      const { registry, tools, answers } = yield* startHost
      yield* askWith(tools, RUN)
      yield* whenPending(registry, 1)

      yield* registry.unload('dia-tools')

      assert.deepStrictEqual(yield* answered(answers, 1), ['declined'])
    }).pipe(Effect.scoped)
  )
})
