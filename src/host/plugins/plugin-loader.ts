import type { HostPluginContext } from '@shared/plugin/api'
import { importSetup } from '@shared/plugin/entry'
import { PluginManifest } from '@shared/plugin/manifest'
import {
  type LoadedPlugin,
  PluginLoadError,
  type PluginLoader
} from '@shared/plugin/plugin-registry'
import { Effect, FileSystem, Option, Path, Result, Schema } from 'effect'
import { type PluginModules, processPluginModules } from './plugin-modules'

const decodeManifest = Schema.decodeUnknownResult(Schema.fromJsonString(PluginManifest), {
  errors: 'all'
})

/**
 * Builds the Host's {@link PluginLoader}. A load reads `plugin.json` from the plugin directory,
 * decodes it, and runs the caller's `use` inside `modules.transact`, with the plugins that
 * import a module the load gives a new instance as `importers`. When the manifest names a
 * `host` entry, `resolveSetup` imports that entry with `modules.importEntry` and takes its
 * default export as the setup function. Every failure (missing or invalid `plugin.json`, an
 * entry that does not import, a default export that is not a function) is a
 * {@link PluginLoadError} naming the cause. `peek` does the same read and decode without importing
 * or transacting anything, and declares the plugin's exports to `modules` when the manifest's
 * name is the catalog name. Requires `FileSystem` and `Path`.
 */
export const makeHostPluginLoader = (
  modules: PluginModules = processPluginModules
): Effect.Effect<PluginLoader<HostPluginContext>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const read = Effect.fn('PluginLoader.read')(function* (root: string) {
      const manifestPath = path.join(root, 'plugin.json')
      const raw = yield* fs
        .readFileString(manifestPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PluginLoadError({ message: `Cannot read "${manifestPath}": ${cause.message}` })
          )
        )
      const decoded = decodeManifest(raw)
      if (Result.isFailure(decoded)) {
        return yield* new PluginLoadError({
          message: `Invalid "${manifestPath}": ${String(decoded.failure)}`
        })
      }
      const manifest = decoded.success
      if (manifest.host === undefined)
        return { manifest, resolveSetup: Effect.succeed(Option.none()) }

      const entry = path.resolve(root, manifest.host)
      const resolveSetup = importSetup<HostPluginContext>(entry, () =>
        modules.importEntry(root, entry)
      ).pipe(
        Effect.map(Option.some),
        Effect.tap(() => Effect.logDebug('Plugin entry imported', { plugin: manifest.name, entry }))
      )
      return { manifest, resolveSetup }
    })

    const load = Effect.fn('PluginLoader.load')(function* <A, E, R>(
      name: string,
      root: string,
      use: (loaded: LoadedPlugin<HostPluginContext>) => Effect.Effect<A, E, R>
    ) {
      const { manifest, resolveSetup } = yield* read(root)
      return yield* modules.transact(
        name,
        root,
        manifest.category,
        manifest.exports ?? [],
        (importers) => use({ manifest, resolveSetup, importers })
      )
    })

    const peek = (name: string, root: string) =>
      read(root).pipe(
        Effect.map(({ manifest }) => manifest),
        Effect.tap((manifest) =>
          Effect.sync(() => {
            if (manifest.name === name) {
              modules.declare(name, root, manifest.category, manifest.exports ?? [])
            }
          })
        )
      )

    return { peek, load }
  })
