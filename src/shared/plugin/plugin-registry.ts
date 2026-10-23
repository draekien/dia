import { Cause, Data, Effect, Exit, Option, Predicate, Scope, Semaphore } from 'effect'
import type { PluginServices, PluginSetup } from './api'
import { ServiceKeyTakenError } from './api'
import {
  PLUGIN_API_VERSION,
  type PluginInfo,
  type PluginManifest,
  type PluginOrigin,
  type PluginRestartReason,
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

/**
 * Failure of a {@link PluginLoader} or {@link PluginMemoryGuard}: the plugin cannot reload in this
 * process. `reason` is `dependency` when a file outside the plugin directory changed, or `memory`
 * when the plugin reached its memory limit; `message` is shown to the user.
 */
export class PluginRestartRequiredError extends Data.TaggedError('PluginRestartRequiredError')<{
  readonly reason: PluginRestartReason
  readonly message: string
}> {}

/**
 * Reads the manifest at a {@link PluginSource} root into a {@link LoadedPlugin} and runs `use` with it.
 * Importing the entry is deferred to `resolveSetup`. When `use` fails, everything the load changed
 * in the loader is restored, so a failed reload leaves later loads seeing the previous version.
 * Fails with {@link PluginRestartRequiredError} without running `use` when a dependency of the
 * plugin outside `root` changed.
 */
export interface PluginLoader<Context extends PluginServices> {
  readonly load: <A, E, R>(
    root: string,
    use: (loaded: LoadedPlugin<Context>) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | PluginLoadError | PluginRestartRequiredError, R>
}

/**
 * Estimates the Host memory each plugin's loads retain. `used` is the plugin's total in bytes;
 * `limit` is the total at which the registry refuses further loads. `track` runs an effect and
 * adds the memory it retained to the plugin's total.
 */
export interface PluginMemoryGuard {
  readonly limit: number
  readonly used: (plugin: string) => Effect.Effect<number>
  readonly track: <A, E, R>(
    plugin: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
}

/**
 * Plugin lifecycle. Every method serialises with the others, so scopes never interleave.
 * `load` opens a plugin, or replaces it when it is already open, and returns its resulting
 * state; a failure is reported in the status and never as an error. The new version is validated
 * before the running one stops. When it fails, the previous version keeps running (or is
 * reopened) with the failure in `Loaded.reloadError`; a plugin with no previous version is
 * `Failed`. A plugin whose loads reached the memory limit, or whose dependency outside its
 * directory changed, reports `RestartRequired`. `unload` closes it.
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
  root: string
  manifest: PluginManifest | undefined
  setup: Option.Option<PluginSetup<Context>> | undefined
  scope: Scope.Closeable | undefined
  status: PluginStatus
  readonly provided: Set<string>
}

const makeEntry = <Context extends PluginServices>(source: PluginSource): Entry<Context> => ({
  origin: source.origin,
  root: source.root,
  manifest: undefined,
  setup: undefined,
  scope: undefined,
  status: { _tag: 'Unloaded' },
  provided: new Set()
})

const isRunning = <Context extends PluginServices>(entry: Entry<Context>): boolean =>
  entry.setup !== undefined &&
  (entry.status._tag === 'Loaded' || entry.status._tag === 'RestartRequired')

/**
 * Builds a {@link PluginRegistry} whose plugin scopes are forks of the scope it runs in, so
 * closing that scope closes every plugin. `extend` turns the shared services into the context
 * this side's plugins receive (for example by adding an event stream). `memory`, when given,
 * limits the memory each plugin's loads may retain and fills `PluginInfo.memoryBytes`.
 */
export const makePluginRegistry = <Context extends PluginServices>(deps: {
  readonly catalog: PluginCatalog
  readonly loader: PluginLoader<Context>
  readonly extend: (services: PluginServices) => Context
  readonly memory?: PluginMemoryGuard
}): Effect.Effect<PluginRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const lock = yield* Semaphore.make(1)
    const entries = new Map<string, Entry<Context>>()
    const slots = new Map<string, { readonly owner: string; readonly value: unknown }>()

    const memoryOf = (name: string): Effect.Effect<number> =>
      deps.memory === undefined ? Effect.succeed(0) : deps.memory.used(name)

    const tracked = <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      deps.memory === undefined ? effect : deps.memory.track(name, effect)

    const infoOf = (name: string, entry: Entry<Context>): Effect.Effect<PluginInfo> =>
      Effect.gen(function* () {
        const memoryBytes = yield* memoryOf(name)
        return {
          name,
          origin: entry.origin,
          root: entry.root,
          status: entry.status,
          memoryBytes
        }
      })

    const failedInfo = (name: string, message: string): PluginInfo => ({
      name,
      origin: 'default',
      root: '',
      status: { _tag: 'Failed', message },
      memoryBytes: 0
    })

    const markFailed = (entry: Entry<Context>, message: string) => {
      entry.manifest = undefined
      entry.setup = undefined
      entry.status = { _tag: 'Failed', message }
    }

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
        if (dependantName === name || !isRunning(entry)) continue
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

    const open = (name: string, entry: Entry<Context>): Effect.Effect<void, PluginLoadError> =>
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
        const exit = yield* Effect.exit(
          Scope.provide(scope)(Effect.suspend(() => setup.value(context)))
        )
        if (Exit.isFailure(exit)) {
          yield* Scope.close(scope, exit)
          yield* Effect.logError('Plugin setup failed', { plugin: name, cause: exit.cause })
          return yield* new PluginLoadError({ message: describeCause(exit.cause) })
        }
        entry.scope = scope
        entry.status = { _tag: 'Loaded' }
        yield* Effect.logInfo('Plugin loaded', { plugin: name, origin: entry.origin })
      })

    const openOrFail = (name: string, entry: Entry<Context>): Effect.Effect<void> =>
      open(name, entry).pipe(
        Effect.catchTag('PluginLoadError', (error) =>
          Effect.sync(() => markFailed(entry, error.message))
        )
      )

    const openWaiting = Effect.gen(function* () {
      let progressed = true
      while (progressed) {
        progressed = false
        for (const [name, entry] of entries) {
          if (entry.status._tag !== 'Waiting') continue
          yield* openOrFail(name, entry)
          if (entry.status._tag !== 'Waiting') progressed = true
        }
      }
    })

    const swap = (name: string, source: PluginSource, entry: Entry<Context>) =>
      Effect.fnUntraced(function* (loaded: LoadedPlugin<Context>) {
        if (loaded.manifest.api !== PLUGIN_API_VERSION) {
          return yield* new PluginLoadError({
            message: `Plugin API version "${loaded.manifest.api}" does not match the installed version "${PLUGIN_API_VERSION}"`
          })
        }
        if (loaded.manifest.name !== name) {
          return yield* new PluginLoadError({
            message: `Manifest name "${loaded.manifest.name}" does not match the plugin directory "${name}"`
          })
        }
        const setup = yield* loaded.resolveSetup

        const previous = {
          origin: entry.origin,
          root: entry.root,
          manifest: entry.manifest,
          setup: entry.setup
        }
        yield* closeWithDependants(name)
        entry.origin = source.origin
        entry.root = source.root
        entry.manifest = loaded.manifest
        entry.setup = setup
        const opened = yield* Effect.exit(open(name, entry))
        if (Exit.isSuccess(opened)) return
        Object.assign(entry, previous)
        yield* openOrFail(name, entry)
        return yield* Effect.failCause(opened.cause)
      })

    const load = (name: string): Effect.Effect<PluginInfo> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* deps.catalog.resolve(name)
          if (Option.isNone(found)) return failedInfo(name, `No plugin named "${name}"`)
          const source = found.value

          let entry = entries.get(name)
          if (entry === undefined) {
            entry = makeEntry<Context>(source)
            entries.set(name, entry)
          }

          if (deps.memory !== undefined) {
            const used = yield* deps.memory.used(name)
            if (used >= deps.memory.limit) {
              const message = `Plugin "${name}" retained ${used} bytes across loads, over the limit of ${deps.memory.limit}. Restart dia to reload it.`
              entry.status = { _tag: 'RestartRequired', reason: 'memory', message }
              yield* Effect.logWarning('Plugin reload refused', { plugin: name, used })
              return yield* infoOf(name, entry)
            }
          }

          const exit = yield* Effect.exit(
            tracked(name, deps.loader.load(source.root, swap(name, source, entry)))
          )
          if (Exit.isFailure(exit)) {
            const error = Cause.squash(exit.cause)
            const message = errorMessage(error)
            if (error instanceof PluginRestartRequiredError) {
              entry.status = { _tag: 'RestartRequired', reason: error.reason, message }
            } else if (entry.setup === undefined) {
              entry.origin = source.origin
              entry.root = source.root
              markFailed(entry, message)
            } else if (entry.status._tag === 'Loaded') {
              entry.status = { _tag: 'Loaded', reloadError: message }
            }
            yield* Effect.logWarning('Plugin failed to load', { plugin: name, message })
          }
          yield* openWaiting
          return yield* infoOf(name, entry)
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
              root: source.value.root,
              status: { _tag: 'Unloaded' },
              memoryBytes: 0
            } satisfies PluginInfo
          }
          yield* tracked(name, closeWithDependants(name))
          entry.manifest = undefined
          entry.setup = undefined
          entry.status = { _tag: 'Unloaded' }
          yield* Effect.logInfo('Plugin unloaded', { plugin: name })
          return yield* infoOf(name, entry)
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
            if (entry !== undefined) return infoOf(name, entry)
            return deps.catalog.resolve(name).pipe(
              Effect.map(
                (source): PluginInfo => ({
                  name,
                  origin: Option.match(source, {
                    onNone: () => 'default',
                    onSome: (found) => found.origin
                  }),
                  root: Option.match(source, {
                    onNone: () => '',
                    onSome: (found) => found.root
                  }),
                  status: { _tag: 'Unloaded' },
                  memoryBytes: 0
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
