import { PluginStatusChanged } from '@shared/ipc/contract'
import { PLUGIN_MEMORY_LIMIT } from '@shared/plugin/manifest'
import {
  makePluginRegistry,
  PluginLoadError,
  type PluginRegistry
} from '@shared/plugin/plugin-registry'
import {
  ByteSize,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  SubscriptionRef
} from 'effect'
import type { Rpc } from 'effect/rpc'
import { AppWindow } from '../services/app-window'
import { SessionAttacher } from '../services/attached-sessions'
import { BackgroundActivities } from '../services/background-activities'
import { makePluginDatabase } from '../services/database'
import { EventHub } from '../services/event-hub'
import { WorkspaceFeed } from '../services/workspace-feed'
import type { HostPluginContext, SessionAttachment } from './host-plugin-context'
import { makeHostPluginLoader } from './plugin-loader'
import { heapUsedAfterGc, makePluginMemoryGuard } from './plugin-memory-guard'
import { servePluginCall } from './plugin-messages'
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
 * `<userDataPath>/plugins/<name>`, created before the plugin's setup runs; `activities`,
 * registration with {@link BackgroundActivities} under the plugin's name; and `database`, which
 * opens `<dataDir>/data.db` only when the plugin calls it; `pluginsSettled`, which succeeds once `start` has settled every eager plugin; `workspace`, following
 * {@link WorkspaceFeed}; `window`, backed by {@link AppWindow}; and `sessions`, which waits
 * for {@link SessionAttacher} on each call. Every plugin state
 * change is published to the hub as a `PluginStatusChanged` event. `pluginApiPath` is the
 * absolute path of the built module that `import '@dia/plugin'` resolves to inside a plugin
 * (`out/main/plugin-api.js`). Build the layer once per process, because it installs a
 * process-wide resolution hook. Requires `PluginSources`, `EventHub`, `BackgroundActivities`,
 * `WorkspaceFeed`, `AppWindow`, `SessionAttacher`, `FileSystem` and `Path`.
 */
export const makeHostPluginsLive = (pluginApiPath: string, userDataPath: string) =>
  Layer.effect(
    HostPlugins,
    Effect.gen(function* () {
      const sources = yield* PluginSources
      const hub = yield* EventHub
      const activities = yield* BackgroundActivities
      const workspaceFeed = yield* WorkspaceFeed
      const appWindow = yield* AppWindow
      const attacher = yield* SessionAttacher
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const pluginApiUrl = yield* path.toFileUrl(pluginApiPath).pipe(Effect.orDie)
      const loader = yield* makeHostPluginLoader(makePluginModules(pluginApiUrl.href))
      const settled = yield* Deferred.make<void>()
      const registry = yield* makePluginRegistry<HostPluginContext>({
        catalog: sources,
        loader,
        memory: makePluginMemoryGuard({
          limit: ByteSize.toNumberUnsafe(PLUGIN_MEMORY_LIMIT),
          heapUsed: heapUsedAfterGc
        }),
        extend: (services) => {
          const dataDir = path.join(userDataPath, 'plugins', services.name)
          const served = new Set<string>()
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
              workspace: SubscriptionRef.changes(workspaceFeed),
              window: { attended: appWindow.attended, notify: appWindow.notify },
              sessions: {
                attach: (attachment: SessionAttachment) =>
                  Deferred.await(attacher).pipe(Effect.flatMap((attach) => attach(attachment)))
              },
              dataDir,
              pluginsSettled: Deferred.await(settled),
              activities: {
                register: (spec) => activities.register(services.name, spec)
              },
              database: makePluginDatabase(path.join(dataDir, 'data.db'), services.name),
              serve: <R extends Rpc.AnyWithProps>(
                rpc: R,
                handler: Parameters<typeof servePluginCall<R>>[3]
              ) => servePluginCall(services, served, rpc, handler)
            })
          )
        },
        onChange: (changed) =>
          Effect.forEach(
            changed,
            (info) => hub.publish(PluginStatusChanged.make({ name: info.name })),
            {
              discard: true
            }
          )
      })
      return {
        ...registry,
        start: () =>
          registry.start().pipe(
            Effect.ensuring(Deferred.succeed(settled, undefined)),
            Effect.tap(() => Effect.logDebug('Plugins settled signalled'))
          )
      }
    })
  )
