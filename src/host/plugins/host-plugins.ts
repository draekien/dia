import type { HostPluginContext } from '@shared/plugin/api'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { ByteSize, Context, Effect, Layer } from 'effect'
import { EventHub } from '../services/event-hub'
import { makeHostPluginLoader } from './plugin-loader'
import { heapUsedAfterGc, makePluginMemoryGuard } from './plugin-memory-guard'
import { PluginSources } from './plugin-sources'

/**
 * Host heap growth, summed over a plugin's loads, at which the Host refuses to reload that plugin
 * until it restarts.
 */
export const PLUGIN_MEMORY_LIMIT = ByteSize.megabytes(100)

/**
 * The Host's plugin lifecycle: `load` opens a plugin (or replaces it when open), `unload` closes
 * it, `list` reports every plugin's origin and state. Plugin scopes close with the layer that
 * provides this service, so tear that layer down on shutdown. Provide it via
 * {@link HostPluginsLive}.
 */
export class HostPlugins extends Context.Service<HostPlugins, PluginRegistry>()('HostPlugins') {}

/**
 * Builds the live {@link HostPlugins} layer. Each plugin's context carries `events`, a live
 * subscription to the Host's {@link EventHub}. Requires `PluginSources`, `EventHub`,
 * `FileSystem` and `Path`.
 */
export const HostPluginsLive = Layer.effect(
  HostPlugins,
  Effect.gen(function* () {
    const sources = yield* PluginSources
    const hub = yield* EventHub
    const loader = yield* makeHostPluginLoader()
    return yield* makePluginRegistry<HostPluginContext>({
      catalog: sources,
      loader,
      memory: makePluginMemoryGuard({
        limit: ByteSize.toNumberUnsafe(PLUGIN_MEMORY_LIMIT),
        heapUsed: heapUsedAfterGc
      }),
      extend: (services) => ({ ...services, events: hub.subscribe({}) })
    })
  })
)
