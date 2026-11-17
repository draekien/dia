import type { PluginApi } from '@shared/ipc/contract'
import type { PluginServices } from '@shared/plugin/api'
import { importSetup } from '@shared/plugin/entry'
import { type PluginInfo, PluginManifest } from '@shared/plugin/manifest'
import {
  type LoadedPlugin,
  makePluginRegistry,
  PluginLoadError,
  type PluginRegistry
} from '@shared/plugin/plugin-registry'
import { Data, Effect, Option, Queue, Result, Schema, type Scope, Stream } from 'effect'

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
        _root: string,
        use: (loaded: LoadedPlugin<PluginServices>) => Effect.Effect<A, E, R>
      ) => read(name).pipe(Effect.flatMap((loaded) => use({ ...loaded, importers: [] })))
    },
    extend: (services) => Effect.succeed(services)
  })
}

class HostPluginListFailed extends Data.TaggedError('HostPluginListFailed')<{
  readonly message: string
}> {}

const statusIn = (plugins: ReadonlyArray<PluginInfo>, name: string) =>
  plugins.find((plugin) => plugin.name === name)?.status._tag

const reconcile = Effect.fnUntraced(
  function* (
    renderer: PluginRegistry,
    host: Pick<PluginApi, 'list'>,
    names: ReadonlyArray<string>
  ) {
    const rendererPlugins = yield* renderer.list()
    const followed = names.filter((name) => statusIn(rendererPlugins, name) !== undefined)
    if (followed.length === 0) return
    const hostPlugins = yield* Effect.tryPromise({
      try: () => host.list(),
      catch: (cause) => new HostPluginListFailed({ message: String(cause) })
    })
    for (const name of followed) {
      const hostStatus = statusIn(hostPlugins, name)
      const rendererStatus = statusIn(rendererPlugins, name)
      if (hostStatus === 'Unloaded' && rendererStatus !== 'Unloaded') {
        yield* Effect.logInfo('Unloading renderer entry to follow the Host', { plugin: name })
        yield* renderer.unload(name)
      }
      if (hostStatus === 'Loaded' && rendererStatus === 'Unloaded') {
        yield* Effect.logInfo('Loading renderer entry to follow the Host', { plugin: name })
        yield* renderer.load(name)
      }
    }
  },
  Effect.catchTag('HostPluginListFailed', (error) =>
    Effect.logWarning('Could not read the Host plugin list', { message: error.message })
  )
)

/**
 * Keeps `renderer` in step with the Host's plugins for as long as the surrounding scope is open:
 * when the Host reports a plugin `Unloaded`, its renderer entry is unloaded, so its pages and slot
 * fillers leave the UI; when the Host reports an `Unloaded` renderer entry's plugin `Loaded`, the
 * renderer entry is loaded. It compares every renderer entry with the Host once when it starts,
 * then each plugin the Host reports a status change for. Pass `window.dia.plugins` as `host`.
 * Call it once, after `renderer.start()`. A reload of a plugin that stays loaded does not reload
 * its renderer entry.
 */
export const followHostPlugins = (
  renderer: PluginRegistry,
  host: Pick<PluginApi, 'list' | 'onStatusChanged'>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pending = yield* Queue.unbounded<ReadonlyArray<string>>()
    const everyEntry = (yield* renderer.list()).map((plugin) => plugin.name)
    Queue.offerUnsafe(pending, everyEntry)
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        host.onStatusChanged(({ name }) => void Queue.offerUnsafe(pending, [name]))
      ),
      (stopListening) => Effect.sync(stopListening)
    )
    yield* Stream.fromQueue(pending).pipe(
      Stream.runForEach((names) => reconcile(renderer, host, names)),
      Effect.forkScoped
    )
  })
