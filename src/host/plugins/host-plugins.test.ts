import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, FileSystem, Layer, Option, Path, Stream } from 'effect'
import { EventHub, makeEventHubLive } from '../services/event-hub'
import { SettingsStore } from '../services/settings-store'
import { HostPlugins, makeHostPluginsLive } from './host-plugins'
import { makePluginSourcesLive } from './plugin-sources'

const settings = Layer.succeed(SettingsStore)({
  getLastDirectory: () => Effect.succeed(Option.none()),
  setLastDirectory: () => Effect.void,
  getTheme: () => Effect.succeed(Option.none()),
  setTheme: () => Effect.void,
  getPluginOverrides: () => Effect.succeed({}),
  setPluginOverride: () => Effect.void,
  clearPluginOverride: () => Effect.void
})

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const writePlugin = (root: string, name: string, extra: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.join(root, name), { recursive: true })
    yield* fs.writeFileString(
      path.join(root, name, 'plugin.json'),
      JSON.stringify({ name, api: '1', ...extra })
    )
  })

const hostPluginsFor = (root: string) => {
  const sources = Layer.provide(
    makePluginSourcesLive(root),
    Layer.mergeAll(settings, NodeFileSystem.layer, NodePath.layer)
  )
  const plugins = Layer.provide(
    makeHostPluginsLive('/not-used/plugin-api.js'),
    Layer.merge(sources, platform)
  )
  return Layer.provideMerge(plugins, makeEventHubLive())
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
})
