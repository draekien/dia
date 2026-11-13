import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Duration, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from 'effect'
import {
  callPlugin,
  servePluginCall,
  subscribePlugin
} from '../../src/host/plugins/plugin-messages'
import { makePluginDatabase } from '../../src/host/services/database'
import setup from './host'
import { McpServerRegistryKey, PluginSource, RegisteredServer, UserSource } from './registry'
import type { McpServer } from './servers'

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const GITHUB: McpServer = {
  type: 'stdio',
  command: 'github-mcp',
  args: ['--read-only'],
  env: { GITHUB_HOST: 'github.com' }
}
const LINEAR: McpServer = {
  type: 'http',
  url: 'https://mcp.linear.app/mcp',
  headers: { 'X-Team': 'dia' }
}

const manifest = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const contributing = (name: string, server: McpServer) => (ctx: HostPluginContext) =>
  ctx.whenProvided([McpServerRegistryKey], ({ mcpServerRegistry }) =>
    mcpServerRegistry.register(name, server, ctx.name)
  )

const startHost = (
  filename: string,
  contributors: Record<string, PluginSetup<HostPluginContext>>
) =>
  Effect.gen(function* () {
    const setups: Record<string, PluginSetup<HostPluginContext>> = { mcp: setup, ...contributors }
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
        return Effect.succeed({
          ...services,
          database: makePluginDatabase(filename, services.name),
          serve
        } as unknown as HostPluginContext)
      }
    })
    yield* registry.load('mcp')
    return registry
  })

const tempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return path.join(yield* fs.makeTempDirectoryScoped(), 'mcp.db')
})

const decodeList = Schema.decodeUnknownSync(Schema.Array(RegisteredServer))

const listWhere = (
  registry: PluginRegistry,
  done: (list: ReadonlyArray<RegisteredServer>) => boolean
) =>
  Effect.gen(function* () {
    const stream = yield* subscribePlugin(registry, {
      plugin: 'mcp',
      tag: 'WatchServers',
      payload: {}
    })
    const found = yield* stream.pipe(
      Stream.map((value) => decodeList(value)),
      Stream.filter(done),
      Stream.runHead,
      Effect.timeout(Duration.seconds(5))
    )
    return Option.getOrThrow(found)
  })

const userServers = (list: ReadonlyArray<RegisteredServer>) =>
  Object.fromEntries(
    list.filter((entry) => entry.source._tag === 'User').map((entry) => [entry.name, entry.server])
  )

const save = (registry: PluginRegistry, servers: Record<string, McpServer>) =>
  callPlugin(registry, {
    plugin: 'mcp',
    tag: 'SaveUserServers',
    payload: { servers },
    call: { id: 'save', resent: false }
  })

describe('mcp host entry', () => {
  it.effect('lists a server a plugin registers, and drops it when that plugin unloads', () =>
    Effect.gen(function* () {
      const registry = yield* startHost(yield* tempDatabase, {
        'gh-tools': contributing('github', GITHUB)
      })
      yield* registry.load('gh-tools')
      const whileLoaded = yield* listWhere(registry, (list) => list.length > 0)

      yield* registry.unload('gh-tools')
      const afterUnload = yield* listWhere(registry, (list) => list.length === 0)

      assert.deepStrictEqual(
        [whileLoaded, afterUnload],
        [
          [{ name: 'github', server: GITHUB, source: PluginSource.make({ plugin: 'gh-tools' }) }],
          []
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('keeps saved user servers, exactly as sent, across a reload of mcp', () =>
    Effect.gen(function* () {
      const registry = yield* startHost(yield* tempDatabase, {})
      yield* save(registry, { github: GITHUB, linear: LINEAR })

      yield* registry.unload('mcp')
      yield* registry.load('mcp')
      const reloaded = yield* listWhere(registry, () => true)

      assert.deepStrictEqual(
        [userServers(reloaded), reloaded.every((entry) => entry.source._tag === 'User')],
        [{ github: GITHUB, linear: LINEAR }, true]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect("refuses a save that uses a plugin's name and stores none of it", () =>
    Effect.gen(function* () {
      const registry = yield* startHost(yield* tempDatabase, {
        'linear-tools': contributing('linear', LINEAR)
      })
      yield* registry.load('linear-tools')
      yield* listWhere(registry, (list) => list.length > 0)

      const refused = yield* save(registry, { github: GITHUB, linear: GITHUB }).pipe(Effect.flip)
      yield* registry.unload('mcp')
      yield* registry.load('mcp')
      const reloaded = yield* listWhere(registry, (list) => list.length > 0)

      assert.deepStrictEqual(
        [
          (refused as { readonly error: unknown }).error,
          reloaded.map(({ name, source }) => ({ name, source }))
        ],
        [
          {
            _tag: 'McpServerNameTaken',
            name: 'linear',
            holder: { _tag: 'Plugin', plugin: 'linear-tools' }
          },
          [{ name: 'linear', source: PluginSource.make({ plugin: 'linear-tools' }) }]
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect("holds the user's names before a plugin can register the same name", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase
      const first = yield* startHost(filename, {})
      yield* save(first, { github: GITHUB })
      yield* first.unload('mcp')

      const registry = yield* startHost(filename, { 'gh-tools': contributing('github', LINEAR) })
      yield* registry.load('gh-tools')
      const list = yield* listWhere(registry, (entries) => entries.length > 0)

      assert.deepStrictEqual(list, [
        { name: 'github', server: GITHUB, source: UserSource.make({}) }
      ])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )
})
