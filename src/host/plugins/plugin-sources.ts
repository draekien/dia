import type { PluginCatalog } from '@shared/plugin/plugin-registry'
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Result, Schema } from 'effect'
import { SettingsStore } from '../services/settings-store'

/** Failure of {@link PluginSources.setOverride}; `message` says why the directory cannot be a plugin source. */
export class InvalidOverrideError extends Data.TaggedError('InvalidOverrideError')<{
  readonly message: string
}> {}

/**
 * Where each plugin loads from. As a {@link PluginCatalog} it resolves a plugin to its override
 * directory when one is set, otherwise to its default copy under the plugin root the Host was
 * started with. `setOverride` points one plugin at a source directory (the later call wins) and
 * persists it in settings; `clearOverride` returns the plugin to its default copy. Neither loads
 * or reloads anything.
 */
export class PluginSources extends Context.Service<
  PluginSources,
  PluginCatalog & {
    readonly setOverride: (
      name: string,
      directory: string
    ) => Effect.Effect<void, InvalidOverrideError>
    readonly clearOverride: (name: string) => Effect.Effect<void>
  }
>()('PluginSources') {}

const PackageType = Schema.Struct({ type: Schema.optional(Schema.String) })
const decodePackageType = Schema.decodeUnknownResult(Schema.fromJsonString(PackageType))

/**
 * Builds the live {@link PluginSources} layer. `defaultRoot` is the directory holding one
 * subdirectory per shipped plugin. Requires `SettingsStore`, `FileSystem` and `Path`.
 */
export const makePluginSourcesLive = (defaultRoot: string) =>
  Layer.effect(
    PluginSources,
    Effect.gen(function* () {
      const settings = yield* SettingsStore
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const hasManifest = (directory: string) =>
        fs.exists(path.join(directory, 'plugin.json')).pipe(Effect.orElseSucceed(() => false))

      const resolvesToModule = Effect.fn('PluginSources.resolvesToModule')(function* (
        start: string
      ) {
        let directory = path.resolve(start)
        while (true) {
          const packageJson = path.join(directory, 'package.json')
          if (yield* fs.exists(packageJson).pipe(Effect.orElseSucceed(() => false))) {
            const raw = yield* fs.readFileString(packageJson).pipe(Effect.orElseSucceed(() => ''))
            const decoded = decodePackageType(raw)
            return Result.isSuccess(decoded) && decoded.success.type === 'module'
          }
          const parent = path.dirname(directory)
          if (parent === directory) return false
          directory = parent
        }
      })

      const names = Effect.fn('PluginSources.names')(function* () {
        const entries = yield* fs.readDirectory(defaultRoot).pipe(Effect.orElseSucceed(() => []))
        const shipped = yield* Effect.filter(
          entries,
          (entry) => hasManifest(path.join(defaultRoot, entry)),
          { concurrency: 'unbounded' }
        )
        const overrides = yield* settings.getPluginOverrides()
        return [...new Set([...shipped, ...Object.keys(overrides)])]
      })

      const resolve = Effect.fn('PluginSources.resolve')(function* (name: string) {
        const overrides = yield* settings.getPluginOverrides()
        const override = overrides[name]
        if (override !== undefined) {
          return Option.some({ root: override, origin: 'override' as const })
        }
        const root = path.join(defaultRoot, name)
        return (yield* hasManifest(root))
          ? Option.some({ root, origin: 'default' as const })
          : Option.none()
      })

      const setOverride = Effect.fn('PluginSources.setOverride')(function* (
        name: string,
        directory: string
      ) {
        if (!(yield* hasManifest(directory))) {
          return yield* new InvalidOverrideError({
            message: `"${directory}" has no plugin.json`
          })
        }
        if (!(yield* resolvesToModule(directory))) {
          return yield* new InvalidOverrideError({
            message: `"${directory}" does not resolve to a package with "type": "module"`
          })
        }
        yield* settings.setPluginOverride(name, directory)
        yield* Effect.logInfo('Plugin override set', { plugin: name, directory })
      })

      const clearOverride = Effect.fn('PluginSources.clearOverride')(function* (name: string) {
        yield* settings.clearPluginOverride(name)
        yield* Effect.logInfo('Plugin override cleared', { plugin: name })
      })

      return { names, resolve, setOverride, clearOverride }
    })
  )
