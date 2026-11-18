import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { AgentName } from '@shared/domain/project'
import type { HostPluginContext } from '@shared/plugin/api'
import { PLUGIN_API_VERSION } from '@shared/plugin/manifest'
import { Effect, Fiber, FileSystem, Layer, Option, Path, Ref, Stream } from 'effect'
import { makeAppWindowLive } from '../services/app-window'
import { BackgroundActivitiesLive } from '../services/background-activities'
import { makeHostDatabaseLive } from '../services/database'
import { EventHub } from '../services/event-hub'
import { EventHubTestLayer } from '../services/event-hub-test-layer'
import { PathMovesLive } from '../services/path-moves'
import { SettingsStore } from '../services/settings-store'
import { TabRenamer, TabRenamerLive } from '../services/tab-renamer'
import { WorkspaceFeedLive } from '../services/workspace-feed'
import { HostPlugins, makeHostPluginsLive } from './host-plugins'
import { makePluginSourcesLive } from './plugin-sources'

const settings = Layer.succeed(SettingsStore)({
  getAdapterPreferences: () => Effect.succeed({ adapters: {}, defaults: {} }),
  setAdapterPreferences: () => Effect.void,
  getTheme: () => Effect.succeed(Option.none()),
  setTheme: () => Effect.void,
  getSendMode: () => Effect.succeed(Option.none()),
  setSendMode: () => Effect.void,
  getPluginOverrides: () => Effect.succeed({}),
  setPluginOverride: () => Effect.void,
  clearPluginOverride: () => Effect.void,
  getTranscriptWidth: () => Effect.succeed(Option.none()),
  setTranscriptWidth: () => Effect.void,
  getUsageLimitResume: () => Effect.succeed(Option.none()),
  setUsageLimitResume: () => Effect.void
})

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const writePlugin = (root: string, name: string, extra: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.join(root, name), { recursive: true })
    yield* fs.writeFileString(
      path.join(root, name, 'plugin.json'),
      JSON.stringify({ name, api: PLUGIN_API_VERSION, category: 'feature', ...extra })
    )
  })

const hostPluginsFor = (root: string) => {
  const sources = Layer.provide(
    makePluginSourcesLive(root),
    Layer.mergeAll(settings, NodeFileSystem.layer, NodePath.layer)
  )
  const hub = EventHubTestLayer
  const plugins = Layer.provide(
    makeHostPluginsLive('/not-used/plugin-api.js', root),
    Layer.mergeAll(
      sources,
      platform,
      Layer.provide(BackgroundActivitiesLive, hub),
      WorkspaceFeedLive,
      TabRenamerLive,
      makeAppWindowLive(() => Effect.void),
      Layer.provide(PathMovesLive, makeHostDatabaseLive(root))
    )
  )
  return Layer.provideMerge(plugins, Layer.merge(hub, TabRenamerLive))
}

describe('HostPlugins', () => {
  it.effect('publishes a PluginStatusChanged event for each plugin as startup loads it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      yield* writePlugin(root, 'core', { load: 'eager' })
      yield* writePlugin(root, 'extra', {})

      yield* Effect.gen(function* () {
        const hub = yield* EventHub
        const plugins = yield* HostPlugins
        const collecting = yield* hub
          .subscribe({})
          .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow

        yield* plugins.start()
        const frames = yield* Fiber.join(collecting)

        assert.deepStrictEqual(
          frames.map((frame) => frame._tag === 'GlobalEvent' && frame.event),
          [
            { _tag: 'PluginStatusChanged', name: 'core' },
            { _tag: 'PluginStatusChanged', name: 'extra' },
            { _tag: 'PluginStatusChanged', name: 'core' },
            { _tag: 'PluginStatusChanged', name: 'extra' }
          ]
        )
        const infos = yield* plugins.list()
        assert.deepStrictEqual(
          infos.map((info) => [info.name, info.status._tag]),
          [
            ['core', 'Loaded'],
            ['extra', 'Loaded']
          ]
        )
      }).pipe(Effect.provide(hostPluginsFor(root)))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('moves a plugin data folder its manifest migrates before the plugin loads', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      yield* writePlugin(root, 'dia-core', {
        load: 'eager',
        dataMigrations: [{ id: '1_dia_prefix', from: 'plugins/core' }]
      })
      yield* fs.makeDirectory(path.join(root, 'plugins', 'core'), { recursive: true })
      yield* fs.writeFileString(path.join(root, 'plugins', 'core', 'kept.txt'), 'kept')

      yield* Effect.flatMap(HostPlugins, (plugins) => plugins.start()).pipe(
        Effect.provide(hostPluginsFor(root))
      )

      assert.strictEqual(
        yield* fs.readFileString(path.join(root, 'plugins', 'dia-core', 'kept.txt')),
        'kept'
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  describe('ctx.renameTab', () => {
    const captureContext = (root: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* writePlugin(root, 'namer', { load: 'eager', host: 'host.mjs' })
        yield* fs.writeFileString(
          path.join(root, 'namer', 'host.mjs'),
          'export default (ctx) => globalThis.__diaSetup(ctx)'
        )
        let captured: HostPluginContext | undefined
        const g = globalThis as unknown as { __diaSetup?: unknown }
        g.__diaSetup = (ctx: HostPluginContext) =>
          Effect.sync(() => {
            captured = ctx
          })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            delete g.__diaSetup
          })
        )
        yield* Effect.flatMap(HostPlugins, (plugins) => plugins.start())
        if (captured === undefined) return yield* Effect.die('the plugin setup did not run')
        return captured
      })

    it.effect('renames the tab through the Host tab renamer', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const renamed: Array<[string, string]> = []
        yield* Effect.gen(function* () {
          yield* Ref.set(
            yield* TabRenamer,
            Option.some((paneId: string, name: AgentName) =>
              Effect.sync(() => void renamed.push([paneId, name]))
            )
          )
          const ctx = yield* captureContext(root)

          yield* ctx.renameTab('pane-1', AgentName.make('Fix login'))
        }).pipe(Effect.provide(hostPluginsFor(root)))

        assert.deepStrictEqual(renamed, [['pane-1', 'Fix login']])
      }).pipe(Effect.scoped, Effect.provide(platform))
    )

    it.effect('fails with TabNotFoundError before the Host has a tab renamer', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const failure = yield* Effect.gen(function* () {
          const ctx = yield* captureContext(root)
          return yield* Effect.flip(ctx.renameTab('pane-1', AgentName.make('Fix login')))
        }).pipe(Effect.provide(hostPluginsFor(root)))

        assert.strictEqual(failure._tag, 'TabNotFoundError')
        assert.strictEqual(failure.paneId, 'pane-1')
      }).pipe(Effect.scoped, Effect.provide(platform))
    )
  })
})
