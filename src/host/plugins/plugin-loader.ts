import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { HostPluginContext } from '@shared/plugin/api'
import { importSetup } from '@shared/plugin/entry'
import { PluginManifest } from '@shared/plugin/manifest'
import { PluginLoadError, type PluginLoader } from '@shared/plugin/plugin-registry'
import { Effect, FileSystem, Option, Path, Result, Schema } from 'effect'

/**
 * Imports the module at the absolute path `entry`, which lies inside the plugin directory
 * `root`, and returns its namespace. Every call must evaluate the plugin's current code, not a
 * cached instance from an earlier call.
 */
export type ModuleImporter = (root: string, entry: string) => Promise<unknown>

const generations = new Map<string, number>()
const SHARED_LIBRARY = /^effect(\/|$)/
let hooksRegistered = false

const underPluginRoot = (url: string | undefined): boolean => {
  if (url === undefined) return false
  for (const prefix of generations.keys()) if (url.startsWith(prefix)) return true
  return false
}

const registerGenerationHooks = (): void => {
  if (hooksRegistered) return
  hooksRegistered = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const sharedFromHost =
        SHARED_LIBRARY.test(specifier) && underPluginRoot(context.parentURL)
          ? { ...context, parentURL: import.meta.url }
          : context
      const resolved = nextResolve(specifier, sharedFromHost)
      for (const [prefix, generation] of generations) {
        if (resolved.url.startsWith(prefix)) {
          return { ...resolved, url: `${resolved.url}?gen=${generation}` }
        }
      }
      return resolved
    }
  })
}

/**
 * The {@link ModuleImporter} the Host uses: it gives every module under `root` a new URL on
 * each call, so the plugin and everything it imports evaluate again with their current source.
 * Imports of `effect` made from inside a plugin resolve to the Host's own copy, so one copy of
 * the library exists at runtime. Earlier module instances stay in memory (Node has no public
 * eviction API). Requires the Host to have registered tsx for `.ts` entries.
 */
export const importFreshModule: ModuleImporter = (root, entry) => {
  registerGenerationHooks()
  const prefix = pathToFileURL(root).href.replace(/\/?$/, '/')
  generations.set(prefix, (generations.get(prefix) ?? 0) + 1)
  return import(pathToFileURL(entry).href)
}

const decodeManifest = Schema.decodeUnknownResult(Schema.fromJsonString(PluginManifest))

/**
 * Builds the Host's {@link PluginLoader}. A load reads `plugin.json` from the plugin directory,
 * decodes it, and, when the manifest names a `host` entry, imports that entry with `importModule`
 * and takes its default export as the setup function. Every failure (missing or invalid
 * `plugin.json`, an entry that does not import, a default export that is not a function) is a
 * {@link PluginLoadError} naming the cause. Requires `FileSystem` and `Path`.
 */
export const makeHostPluginLoader = (
  importModule: ModuleImporter = importFreshModule
): Effect.Effect<PluginLoader<HostPluginContext>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const load = Effect.fn('PluginLoader.load')(function* (root: string) {
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
        importModule(root, entry)
      ).pipe(
        Effect.map(Option.some),
        Effect.tap(() => Effect.logDebug('Plugin entry imported', { plugin: manifest.name, entry }))
      )
      return { manifest, resolveSetup }
    })

    return { load }
  })
