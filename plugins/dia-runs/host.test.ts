import { type HostPluginContext, RunsKey } from '@dia/plugin'
import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, FileSystem, Option } from 'effect'
import { callPlugin, servePluginCall } from '../../src/host/plugins/plugin-messages'
import { makePluginDatabase } from '../../src/host/services/database'
import { StartRun } from './calls'
import setup from './host'

const NAME = 'dia-runs'

const manifest: PluginManifest = {
  name: NAME,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
}

const startPlugin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-runs-host-' })
  const registry = yield* makePluginRegistry<HostPluginContext>({
    catalog: {
      names: () => Effect.succeed([NAME]),
      resolve: (name) => Effect.succeed(Option.some({ root: name, origin: 'default' as const }))
    },
    loader: {
      peek: () => Effect.succeed(manifest),
      load: (_name, _root, use) =>
        use({ manifest, resolveSetup: Effect.succeed(Option.some(setup)), importers: [] })
    },
    extend: (services) => {
      const served = new Set<string>()
      const serve: HostPluginContext['serve'] = (rpc, handler) =>
        servePluginCall(services, served, rpc, handler)
      return Effect.succeed({
        ...services,
        dataDir,
        database: makePluginDatabase(`${dataDir}/data.db`, services.name),
        serve
      } as unknown as HostPluginContext)
    }
  })
  yield* registry.load(NAME)
  return registry
})

describe('dia-runs host entry', () => {
  it.live('starts the run StartRun names on the backend it names', () =>
    Effect.gen(function* () {
      const registry = yield* startPlugin
      const runs = Option.getOrThrow(yield* registry.inject(RunsKey))

      yield* callPlugin(registry, {
        plugin: NAME,
        tag: 'StartRun',
        payload: StartRun.payloadSchema.make({
          cwd: '/repo',
          model: 'm',
          backend: 'other',
          thinkingLevel: 'adaptive',
          permissionMode: 'default',
          text: 'tidy the README'
        }),
        call: { id: 'call-1', resent: false }
      })

      assert.deepStrictEqual(
        (yield* runs.list).map((run) => run.backend),
        ['other']
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
