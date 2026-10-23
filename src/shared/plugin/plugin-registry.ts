import { Cause, Data, Effect, Exit, Option, Predicate, Scope, Semaphore } from 'effect'
import type { PluginServices, PluginSetup } from './api'
import { ServiceKeyTakenError } from './api'
import {
  PLUGIN_API_VERSION,
  type PluginInfo,
  type PluginManifest,
  type PluginOrigin,
  type PluginStatus
} from './manifest'

/** A plugin's code location: `root` is what the {@link PluginLoader} receives, `origin` is shown in the plugin list. */
export interface PluginSource {
  readonly root: string
  readonly origin: PluginOrigin
}

/**
 * Where plugins come from. `names` lists every plugin that can be loaded; `resolve` returns the
 * source a plugin loads from right now, or none when no plugin has that name.
 */
export interface PluginCatalog {
  readonly names: () => Effect.Effect<ReadonlyArray<string>>
  readonly resolve: (name: string) => Effect.Effect<Option.Option<PluginSource>>
}

/** Failure of a {@link PluginLoader}; `message` is shown as the plugin's failure reason. */
export class PluginLoadError extends Data.TaggedError('PluginLoadError')<{
  readonly message: string
}> {}

/**
 * A plugin's decoded manifest and `resolveSetup`, the effect that imports the plugin's entry for
 * this side and yields its setup function (none when the plugin has no such entry). Nothing is
 * imported until `resolveSetup` runs; the registry runs it only after the manifest passed its checks.
 */
export interface LoadedPlugin<Context extends PluginServices> {
  readonly manifest: PluginManifest
  readonly resolveSetup: Effect.Effect<Option.Option<PluginSetup<Context>>, PluginLoadError>
}

/** Reads the manifest at a {@link PluginSource} root into a {@link LoadedPlugin}. Importing the entry is deferred to `resolveSetup`. */
export interface PluginLoader<Context extends PluginServices> {
  readonly load: (root: string) => Effect.Effect<LoadedPlugin<Context>, PluginLoadError>
}

/**
 * Plugin lifecycle. Every method serialises with the others, so scopes never interleave.
 * `load` opens a plugin, or replaces it when it is already open, and returns its resulting
 * state; a failure is reported as a `Failed` status and never as an error. `unload` closes it.
 * Plugins that inject a service the changed plugin provides are closed and wait until it is
 * provided again. `list` returns every known plugin; `loadAll` loads each of them one after
 * another and returns their resulting states.
 */
export interface PluginRegistry {
  readonly list: () => Effect.Effect<ReadonlyArray<PluginInfo>>
  readonly loadAll: () => Effect.Effect<ReadonlyArray<PluginInfo>>
  readonly load: (name: string) => Effect.Effect<PluginInfo>
  readonly unload: (name: string) => Effect.Effect<PluginInfo>
}

/** The `message` of an error-like value, or its string form when it has none. */
export const errorMessage = (error: unknown): string =>
  Predicate.hasProperty(error, 'message') && typeof error.message === 'string'
    ? error.message
    : String(error)

const describeCause = (cause: Cause.Cause<unknown>): string => errorMessage(Cause.squash(cause))

interface Entry<Context extends PluginServices> {
  origin: PluginOrigin
  manifest: PluginManifest | undefined
  setup: Option.Option<PluginSetup<Context>> | undefined
  scope: Scope.Closeable | undefined
  status: PluginStatus
  readonly provided: Set<string>
}

/**
 * Builds a {@link PluginRegistry} whose plugin scopes are forks of the scope it runs in, so
 * closing that scope closes every plugin. `extend` turns the shared services into the context
 * this side's plugins receive (for example by adding an event stream).
 */
export const makePluginRegistry = <Context extends PluginServices>(deps: {
  readonly catalog: PluginCatalog
  readonly loader: PluginLoader<Context>
  readonly extend: (services: PluginServices) => Context
}): Effect.Effect<PluginRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const lock = yield* Semaphore.make(1)
    const entries = new Map<string, Entry<Context>>()
    const slots = new Map<string, { readonly owner: string; readonly value: unknown }>()

    const infoOf = (name: string, entry: Entry<Context>): PluginInfo => ({
      name,
      origin: entry.origin,
      status: entry.status
    })

    const failedInfo = (name: string, message: string): PluginInfo => ({
      name,
      origin: 'default',
      status: { _tag: 'Failed', message }
    })

    const servicesFor = (name: string, entry: Entry<Context>): PluginServices => ({
      name,
      provide: (key, value) =>
        Effect.gen(function* () {
          const current = slots.get(key)
          if (current !== undefined && current.owner !== name) {
            return yield* new ServiceKeyTakenError({ key, owner: current.owner })
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              slots.set(key, { owner: name, value })
              entry.provided.add(key)
            }),
            () =>
              Effect.sync(() => {
                if (slots.get(key)?.owner === name) slots.delete(key)
                entry.provided.delete(key)
              })
          )
        }),
      inject: (key) =>
        Effect.sync(() =>
          Option.fromNullishOr(slots.get(key)).pipe(Option.map((slot) => slot.value))
        )
    })

    const injectedKeys = (entry: Entry<Context>): ReadonlyArray<string> =>
      entry.manifest?.inject ?? []

    const dependantsOf = (name: string, keys: ReadonlySet<string>) => {
      const dependants: Array<{
        readonly name: string
        readonly entry: Entry<Context>
        readonly missing: ReadonlyArray<string>
      }> = []
      for (const [dependantName, entry] of entries) {
        if (dependantName === name || entry.status._tag !== 'Loaded') continue
        const missing = injectedKeys(entry).filter((key) => keys.has(key))
        if (missing.length > 0) dependants.push({ name: dependantName, entry, missing })
      }
      return dependants
    }

    const closeWithDependants = (name: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entry = entries.get(name)
        if (entry === undefined) return
        for (const dependant of dependantsOf(name, new Set(entry.provided))) {
          yield* closeWithDependants(dependant.name)
          dependant.entry.status = { _tag: 'Waiting', missing: dependant.missing }
          yield* Effect.logInfo('Plugin waiting for a service', {
            plugin: dependant.name,
            missing: dependant.missing
          })
        }
        const scope = entry.scope
        entry.scope = undefined
        if (scope !== undefined) yield* Scope.close(scope, Exit.void)
      })

    const open = (name: string, entry: Entry<Context>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const setup = entry.setup
        if (setup === undefined) return
        const missing = injectedKeys(entry).filter((key) => !slots.has(key))
        if (missing.length > 0) {
          entry.status = { _tag: 'Waiting', missing }
          return
        }
        if (Option.isNone(setup)) {
          entry.status = { _tag: 'Loaded' }
          return
        }
        const scope = yield* Scope.fork(parentScope)
        const context = deps.extend(servicesFor(name, entry))
        const exit = yield* Effect.exit(Scope.provide(scope)(setup.value(context)))
        if (Exit.isFailure(exit)) {
          yield* Scope.close(scope, exit)
          entry.manifest = undefined
          entry.setup = undefined
          entry.status = { _tag: 'Failed', message: describeCause(exit.cause) }
          yield* Effect.logError('Plugin setup failed', { plugin: name, cause: exit.cause })
          return
        }
        entry.scope = scope
        entry.status = { _tag: 'Loaded' }
        yield* Effect.logInfo('Plugin loaded', { plugin: name, origin: entry.origin })
      })

    const openWaiting = Effect.gen(function* () {
      let progressed = true
      while (progressed) {
        progressed = false
        for (const [name, entry] of entries) {
          if (entry.status._tag !== 'Waiting') continue
          yield* open(name, entry)
          if (entry.status._tag !== 'Waiting') progressed = true
        }
      }
    })

    const load = (name: string): Effect.Effect<PluginInfo> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const source = yield* deps.catalog.resolve(name)
          if (Option.isNone(source)) return failedInfo(name, `No plugin named "${name}"`)

          yield* closeWithDependants(name)
          const entry: Entry<Context> = {
            origin: source.value.origin,
            manifest: undefined,
            setup: undefined,
            scope: undefined,
            status: { _tag: 'Unloaded' },
            provided: new Set()
          }
          entries.set(name, entry)

          const fail = Effect.fnUntraced(function* (message: string) {
            entry.status = { _tag: 'Failed', message }
            yield* Effect.logWarning('Plugin failed to load', { plugin: name, message })
            yield* openWaiting
            return infoOf(name, entry)
          })

          const loadExit = yield* Effect.exit(deps.loader.load(source.value.root))
          if (Exit.isFailure(loadExit)) return yield* fail(describeCause(loadExit.cause))
          const loaded = loadExit.value
          if (loaded.manifest.api !== PLUGIN_API_VERSION) {
            return yield* fail(
              `Plugin API version "${loaded.manifest.api}" does not match the installed version "${PLUGIN_API_VERSION}"`
            )
          }
          if (loaded.manifest.name !== name) {
            return yield* fail(
              `Manifest name "${loaded.manifest.name}" does not match the plugin directory "${name}"`
            )
          }

          const setupExit = yield* Effect.exit(loaded.resolveSetup)
          if (Exit.isFailure(setupExit)) return yield* fail(describeCause(setupExit.cause))

          entry.manifest = loaded.manifest
          entry.setup = setupExit.value
          yield* open(name, entry)
          yield* openWaiting
          return infoOf(name, entry)
        })
      )

    const unload = (name: string): Effect.Effect<PluginInfo> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = entries.get(name)
          if (entry === undefined) {
            const source = yield* deps.catalog.resolve(name)
            if (Option.isNone(source)) return failedInfo(name, `No plugin named "${name}"`)
            return {
              name,
              origin: source.value.origin,
              status: { _tag: 'Unloaded' }
            } satisfies PluginInfo
          }
          yield* closeWithDependants(name)
          entry.manifest = undefined
          entry.setup = undefined
          entry.status = { _tag: 'Unloaded' }
          yield* Effect.logInfo('Plugin unloaded', { plugin: name })
          return infoOf(name, entry)
        })
      )

    const list = (): Effect.Effect<ReadonlyArray<PluginInfo>> =>
      Effect.gen(function* () {
        const known = yield* deps.catalog.names()
        const names = [...new Set([...known, ...entries.keys()])].sort()
        return yield* Effect.forEach(
          names,
          (name) => {
            const entry = entries.get(name)
            if (entry !== undefined) return Effect.succeed(infoOf(name, entry))
            return deps.catalog.resolve(name).pipe(
              Effect.map(
                (source): PluginInfo => ({
                  name,
                  origin: Option.match(source, {
                    onNone: () => 'default',
                    onSome: (found) => found.origin
                  }),
                  status: { _tag: 'Unloaded' }
                })
              )
            )
          },
          { concurrency: 'unbounded' }
        )
      })

    const loadAll = (): Effect.Effect<ReadonlyArray<PluginInfo>> =>
      list().pipe(Effect.flatMap((infos) => Effect.forEach(infos, (info) => load(info.name))))

    return { list, load, unload, loadAll }
  })
