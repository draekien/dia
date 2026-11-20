import {
  type PluginDescription,
  type PluginInfo,
  type PluginManifest,
  PluginManifestUnreadable,
  PluginNotFound,
  type PluginOverrideResult
} from '@shared/plugin/manifest'
import type { PluginLoadError } from '@shared/plugin/plugin-registry'
import { Effect, Fiber } from 'effect'
import type { PluginControl } from './host-plugin-context'

/**
 * What {@link makePluginControl} reads and changes: the registry's plugin list and reload, a
 * manifest read from a plugin folder (`peek`), and the override store.
 */
export interface PluginControlHost {
  readonly list: () => Effect.Effect<ReadonlyArray<PluginInfo>>
  readonly load: (name: string) => Effect.Effect<PluginInfo>
  readonly peek: (name: string, root: string) => Effect.Effect<PluginManifest, PluginLoadError>
  readonly setOverride: (name: string, directory: string) => Effect.Effect<PluginOverrideResult>
}

/** Builds the {@link PluginControl} a plugin's host context carries, over `host`. */
export const makePluginControl = (host: PluginControlHost): PluginControl => ({
  list: Effect.suspend(host.list),
  inspect: Effect.fn('PluginControl.inspect')(function* (name: string) {
    const info = (yield* host.list()).find((plugin) => plugin.name === name)
    if (info === undefined) return yield* new PluginNotFound({ plugin: name })
    const manifest = yield* host
      .peek(name, info.root)
      .pipe(
        Effect.mapError(
          (error) => new PluginManifestUnreadable({ plugin: name, message: error.message })
        )
      )
    const description: PluginDescription = {
      info,
      inject: manifest.inject ?? [],
      exports: manifest.exports ?? [],
      load: manifest.load ?? 'lazy'
    }
    return description
  }),
  setOverride: (name, directory) =>
    host.setOverride(name, directory).pipe(
      Effect.tap((result) =>
        Effect.logInfo('Plugin override set by a plugin', {
          name,
          directory,
          result: result._tag
        })
      )
    ),
  reload: (name) =>
    host.load(name).pipe(
      Effect.forkDetach,
      Effect.flatMap(Fiber.join),
      Effect.tap((info) =>
        Effect.logInfo('Plugin reloaded by a plugin', { name, status: info.status._tag })
      )
    )
})
