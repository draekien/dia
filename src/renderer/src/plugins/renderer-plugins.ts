import type { PluginServices } from '@shared/plugin/api'
import { importSetup } from '@shared/plugin/entry'
import { PluginManifest } from '@shared/plugin/manifest'
import {
  type LoadedPlugin,
  makePluginRegistry,
  PluginLoadError,
  type PluginRegistry
} from '@shared/plugin/plugin-registry'
import { Effect, Option, Result, Schema, type Scope } from 'effect'

/**
 * The renderer plugins available to the app, keyed by plugin name. `manifests` holds each
 * plugin's decoded-or-raw `plugin.json` contents; `entries` holds, for plugins with a `renderer`
 * entry, a function that imports that entry module.
 */
export interface RendererPluginSources {
  readonly manifests: Readonly<Record<string, unknown>>
  readonly entries: Readonly<Record<string, () => Promise<unknown>>>
}

const decodeManifest = Schema.decodeUnknownResult(PluginManifest, { errors: 'all' })

/**
 * Builds the renderer's plugin registry over `sources`, with the same lifecycle as the Host's:
 * `load` opens or replaces a plugin's `renderer` entry in its own scope, `unload` closes it,
 * dependants of a changed service wait and reopen. Every plugin scope closes with the scope the
 * returned effect runs in. A plugin with no `renderer` entry loads as a plugin with nothing to run.
 * The renderer registry has no memory limit.
 */
export const makeRendererPlugins = (
  sources: RendererPluginSources
): Effect.Effect<PluginRegistry, never, Scope.Scope> => {
  const read = Effect.fn('RendererPluginLoader.read')(function* (name: string) {
    const decoded = decodeManifest(sources.manifests[name])
    if (Result.isFailure(decoded)) {
      return yield* new PluginLoadError({
        message: `Invalid manifest for "${name}": ${String(decoded.failure)}`
      })
    }
    const manifest = decoded.success
    if (manifest.renderer === undefined) {
      return { manifest, resolveSetup: Effect.succeed(Option.none()) }
    }

    const importEntry = sources.entries[name]
    if (importEntry === undefined) {
      return yield* new PluginLoadError({
        message: `Plugin "${name}" declares a renderer entry but none was bundled`
      })
    }
    return {
      manifest,
      resolveSetup: importSetup<PluginServices>(manifest.renderer, importEntry).pipe(
        Effect.map(Option.some)
      )
    }
  })

  return makePluginRegistry<PluginServices>({
    catalog: {
      names: () => Effect.succeed(Object.keys(sources.manifests)),
      resolve: (name) =>
        Effect.succeed(
          name in sources.manifests ? Option.some({ root: name, origin: 'default' }) : Option.none()
        )
    },
    loader: {
      peek: (name) => read(name).pipe(Effect.map((loaded) => loaded.manifest)),
      load: <A, E, R>(
        name: string,
        use: (loaded: LoadedPlugin<PluginServices>) => Effect.Effect<A, E, R>
      ) => read(name).pipe(Effect.flatMap(use))
    },
    extend: (services) => Effect.succeed(services),
    adapterContract: { keys: [], problems: () => [] }
  })
}
