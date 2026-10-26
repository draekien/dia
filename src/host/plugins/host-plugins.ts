import { PluginStatusChanged } from '@shared/ipc/contract'
import type { HostPluginContext } from '@shared/plugin/api'
import { PLUGIN_MEMORY_LIMIT } from '@shared/plugin/manifest'
import {
  makePluginRegistry,
  PluginLoadError,
  type PluginRegistry
} from '@shared/plugin/plugin-registry'
import { ByteSize, Context, Effect, FileSystem, Layer, Path } from 'effect'
import { BackgroundActivities } from '../services/background-activities'
import { EventHub } from '../services/event-hub'
import { adapterContract } from '../session/agent-backend'
import { makeHostPluginLoader } from './plugin-loader'
import { heapUsedAfterGc, makePluginMemoryGuard } from './plugin-memory-guard'
import { makePluginModules } from './plugin-modules'
import { PluginSources } from './plugin-sources'

/**
 * The Host's plugin lifecycle: `load` opens a plugin (or replaces it when open), `unload` closes
 * it, `list` reports every plugin's origin and state. Plugin scopes close with the layer that
 * provides this service, so tear that layer down on shutdown. Provide it via
 * {@link makeHostPluginsLive}.
 */
export class HostPlugins extends Context.Service<HostPlugins, PluginRegistry>()('HostPlugins') {}

/**
 * Builds the live {@link HostPlugins} layer. Each plugin's context carries `events`, a live
 * subscription to the Host's {@link EventHub}; `dataDir`, the directory
 * `<userDataPath>/plugins/<name>`, created before the plugin's setup runs; and `activities`,
 * registration with {@link BackgroundActivities} under the plugin's name. Every plugin state
 * change is published to the hub as a `PluginStatusChanged` event. `pluginApiPath` is the
 * absolute path of the built module that `import '@dia/plugin'` resolves to inside a plugin
 * (`out/main/plugin-api.js`). Build the layer once per process, because it installs a
 * process-wide resolution hook. Requires `PluginSources`, `EventHub`, `BackgroundActivities`,
 * `FileSystem` and `Path`.
 */
export const makeHostPluginsLive = (pluginApiPath: string, userDataPath: string) =>
  Layer.effect(
    HostPlugins,
    Effect.gen(function* () {
      const sources = yield* PluginSources
      const hub = yield* EventHub
      const activities = yield* BackgroundActivities
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const pluginApiUrl = yield* path.toFileUrl(pluginApiPath).pipe(Effect.orDie)
      const loader = yield* makeHostPluginLoader(makePluginModules(pluginApiUrl.href))
      return yield* makePluginRegistry<HostPluginContext>({
        catalog: sources,
        loader,
        memory: makePluginMemoryGuard({
          limit: ByteSize.toNumberUnsafe(PLUGIN_MEMORY_LIMIT),
          heapUsed: heapUsedAfterGc
        }),
        extend: (services) => {
          const dataDir = path.join(userDataPath, 'plugins', services.name)
          return fs.makeDirectory(dataDir, { recursive: true }).pipe(
            Effect.mapError(
              (error) =>
                new PluginLoadError({
                  message: `Could not create the plugin data directory ${dataDir}: ${error.message}`
                })
            ),
            Effect.as({
              ...services,
              events: hub.subscribe({}),
              dataDir,
              activities: {
                register: (spec) => activities.register(services.name, spec)
              }
            })
          )
        },
        adapterContract,
        onChange: (changed) =>
          Effect.forEach(
            changed,
            (info) => hub.publish(PluginStatusChanged.make({ name: info.name })),
            {
              discard: true
            }
          )
      })
    })
  )
