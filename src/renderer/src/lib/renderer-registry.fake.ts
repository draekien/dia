import type { PluginServices, PluginSetup } from '@shared/plugin/api'
import { type FeatureManifest, PLUGIN_API_VERSION } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, Scope } from 'effect'
import { setPluginRegistry } from './slots'

const rendererManifest = (name: string): FeatureManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  renderer: 'renderer.ts',
  load: 'eager'
})

/**
 * Starts a renderer plugin registry for a test, with one renderer plugin per entry of `setups`
 * (keyed by plugin name), and hands it to `Slot`, `useProvided` and `useList`. Wrap the call in
 * React's `act` when components are already rendered.
 */
export const startRendererRegistry = (
  setups: Record<string, PluginSetup<PluginServices>>
): Promise<PluginRegistry> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const registry = yield* makePluginRegistry<PluginServices>({
        catalog: {
          names: () => Effect.succeed(Object.keys(setups)),
          resolve: (name) => Effect.succeed(Option.some({ root: name, origin: 'default' as const }))
        },
        loader: {
          peek: (name) => Effect.succeed(rendererManifest(name)),
          load: (name, _root, use) =>
            use({
              manifest: rendererManifest(name),
              resolveSetup: Effect.succeed(Option.fromNullishOr(setups[name])),
              importers: []
            })
        },
        extend: (services) => Effect.succeed(services),
        adapterContract: { keys: [], problems: () => [] }
      }).pipe(Scope.provide(scope))
      setPluginRegistry(registry)
      yield* registry.start()
      return registry
    })
  )
