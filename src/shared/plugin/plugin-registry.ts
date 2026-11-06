import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream
} from 'effect'
import type { PluginServices, PluginSetup } from './api'
import {
  ServiceKeyReservedError,
  ServiceKeyTakenError,
  ServiceNotDeclaredError,
  WhenProvidedRefusedError
} from './api'
import {
  formatMegabytes,
  isApiCompatible,
  PLUGIN_API_VERSION,
  type PluginCategory,
  PluginInfo,
  type PluginLoadMode,
  type PluginManifest,
  type PluginOrigin,
  type PluginRestartReason,
  type PluginStatus
} from './manifest'

/**
 * What the registry requires of adapter plugins. `keys` are the service keys only an adapter may
 * provide: a feature plugin that provides one fails to load with {@link ServiceKeyReservedError}.
 * `problems` checks what an adapter's setup provided, through `provided`, which reads the value the
 * plugin provided under a service key; it returns one sentence per problem, and an empty list lets
 * the adapter load.
 */
export interface AdapterContract {
  readonly keys: ReadonlyArray<string>
  readonly problems: (provided: (key: string) => Option.Option<unknown>) => ReadonlyArray<string>
}

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
 * plugin outside `root` changed. `peek` reads and decodes the manifest at `root` without
 * importing any entry and without changing loader state.
 */
export interface PluginLoader<Context extends PluginServices> {
  readonly peek: (root: string) => Effect.Effect<PluginManifest, PluginLoadError>
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
 * directory changed, reports `RestartRequired`. An adapter plugin loads only once: `load` of a
 * running adapter and every `unload` of an adapter return its state unchanged. An adapter whose
 * setup does not meet the adapter contract fails to load. `unload` closes a feature plugin.
 * Plugins that inject a service the changed plugin provides are closed and wait until it is
 * provided again. `list` returns every known plugin. `inject` reads the value a loaded plugin provides
 * under a service key without holding the provider open; it is empty while no plugin provides the
 * key. Use it only for a service an adapter plugin provides (adapters never unload) or for a value
 * read again each time `changes` emits its key; read a feature plugin's service with `use`.
 * `changes` emits a service key each time a plugin starts or stops providing it, from the moment
 * it is subscribed; read the new value with `inject`. A plugin whose entry import, or whose setup,
 * does not finish within {@link PLUGIN_SETUP_TIME_LIMIT} fails like any other load failure.
 * `use` runs `f` with the value a loaded plugin provides under a service key and returns `Some` of
 * its result. It returns `None` without running `f` while no plugin provides the key or while its
 * provider is closing. It fails with {@link ServiceWithdrawnError} when the provider closed while
 * `f` ran and `f` did not finish within {@link SERVICE_USE_TIME_LIMIT}, and with `f`'s error when
 * `f` fails. Closing a plugin, by `unload`, a reload or a failed setup, first waits for the `use`
 * calls on its services to end. Do not keep the value after `f` returns; call `use` again for the
 * next operation.
 * `start` is the startup entry point: it marks every plugin `Loading`, loads every adapter and
 * every plugin whose manifest says `load: "eager"` one after another, and resolves once each of
 * them has settled (loaded, waiting, failed or restart-required), which does not require it to be
 * `Loaded`. The remaining plugins keep loading in the background, in the registry's scope, and a plugin the
 * caller unloads before its turn is skipped. Call it once per registry.
 */
export interface PluginRegistry {
  readonly list: () => Effect.Effect<ReadonlyArray<PluginInfo>>
  readonly start: () => Effect.Effect<void>
  readonly load: (name: string) => Effect.Effect<PluginInfo>
  readonly unload: (name: string) => Effect.Effect<PluginInfo>
  readonly inject: (key: string) => Effect.Effect<Option.Option<unknown>>
  readonly use: <A, E, R>(
    key: string,
    f: (value: unknown) => Effect.Effect<A, E, R>
  ) => Effect.Effect<Option.Option<A>, E | ServiceWithdrawnError, R>
  readonly changes: Stream.Stream<string>
}

/**
 * How long a plugin's entry-module import, and separately its setup, may run before the registry
 * stops waiting and fails the load.
 */
export const PLUGIN_SETUP_TIME_LIMIT: Duration.Duration = Duration.seconds(10)

/**
 * How long closing a plugin waits for the `use` calls that hold its services before it
 * interrupts them.
 */
export const SERVICE_USE_TIME_LIMIT: Duration.Duration = Duration.seconds(30)

/**
 * Failure of {@link PluginRegistry.use} when the plugin providing the service closed while `f`
 * ran and `f` did not finish within {@link SERVICE_USE_TIME_LIMIT}; `f` may have partly run.
 * `message` names the plugin and the key.
 */
export class ServiceWithdrawnError extends Data.TaggedError('ServiceWithdrawnError')<{
  readonly key: string
  readonly plugin: string
  readonly message: string
}> {}

/** The `message` of an error-like value, or its string form when it has none. */
export const errorMessage = (error: unknown): string =>
  Predicate.hasProperty(error, 'message') && typeof error.message === 'string'
    ? error.message
    : String(error)

const describeCause = (cause: Cause.Cause<unknown>): string => errorMessage(Cause.squash(cause))

const sameInfo = Schema.toEquivalence(PluginInfo)

interface Entry<Context extends PluginServices> {
  origin: PluginOrigin
  root: string
  category: PluginCategory | undefined
  manifest: PluginManifest | undefined
  setup: Option.Option<PluginSetup<Context>> | undefined
  scope: Scope.Closeable | undefined
  leases: Leases | undefined
  status: PluginStatus
  readonly provided: Set<string>
}

interface Leases {
  closing: boolean
  readonly active: Map<Fiber.Fiber<unknown, unknown>, string>
  readonly drained: Deferred.Deferred<void>
  readonly withdrawn: Deferred.Deferred<void>
}

const makeLeases = (): Leases => ({
  closing: false,
  active: new Map(),
  drained: Deferred.makeUnsafe(),
  withdrawn: Deferred.makeUnsafe()
})

type WatcherState = Data.TaggedEnum<{
  Idle: Record<never, never>
  Running: { readonly scope: Scope.Closeable }
  Failed: Record<never, never>
}>
const WatcherState = Data.taggedEnum<WatcherState>()

interface Watcher {
  readonly plugin: string
  readonly keys: ReadonlyArray<string>
  readonly setup: (services: Record<string, unknown>) => Effect.Effect<void, unknown, Scope.Scope>
  readonly parent: Scope.Scope
  readonly provided: Set<string>
  readonly nested: Set<Watcher>
  state: WatcherState
}

interface SetupWindow {
  readonly plugin: string
  readonly watcher: Watcher | undefined
  accepting: boolean
}

const CurrentSetup = Context.Reference<SetupWindow | undefined>('dia/plugin/CurrentSetup', {
  defaultValue: () => undefined
})

type WhenProvidedRefusal = 'adapter' | 'no-setup' | 'other-plugin' | 'setup-ended'

const acceptingWindow = (
  name: string,
  category: PluginCategory | undefined,
  window: SetupWindow | undefined
): SetupWindow | WhenProvidedRefusal => {
  if (category === 'adapter') return 'adapter'
  if (window === undefined) return 'no-setup'
  if (window.plugin !== name) return 'other-plugin'
  return window.accepting ? window : 'setup-ended'
}

const makeEntry = <Context extends PluginServices>(source: PluginSource): Entry<Context> => ({
  origin: source.origin,
  root: source.root,
  category: undefined,
  manifest: undefined,
  setup: undefined,
  scope: undefined,
  leases: undefined,
  status: { _tag: 'Unloaded' },
  provided: new Set()
})

const isRunning = <Context extends PluginServices>(entry: Entry<Context>): boolean =>
  entry.setup !== undefined &&
  (entry.status._tag === 'Loaded' || entry.status._tag === 'RestartRequired')

/**
 * Builds a {@link PluginRegistry} whose plugin scopes are forks of the scope it runs in, so
 * closing that scope closes every plugin. `extend` turns the shared services into the context
 * this side's plugins receive (for example by adding an event stream); it runs before each setup,
 * and its failure fails that load like a failing setup. `memory`, when given,
 * limits the memory each plugin's loads may retain and fills `PluginInfo.memoryBytes`.
 * `onChange`, when given, runs after every operation with the plugins whose `PluginInfo` differs
 * from the last one it reported (the first report covers every plugin the registry has seen).
 * `adapterContract` is the {@link AdapterContract} adapter plugins are held to.
 */
export const makePluginRegistry = <Context extends PluginServices>(deps: {
  readonly catalog: PluginCatalog
  readonly loader: PluginLoader<Context>
  readonly extend: (services: PluginServices) => Effect.Effect<Context, PluginLoadError>
  readonly memory?: PluginMemoryGuard
  readonly onChange?: (changed: ReadonlyArray<PluginInfo>) => Effect.Effect<void>
  readonly adapterContract: AdapterContract
}): Effect.Effect<PluginRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const lock = yield* Semaphore.make(1)
    const entries = new Map<string, Entry<Context>>()
    const slots = new Map<string, { readonly owner: string; readonly value: unknown }>()
    const watchers = new Set<Watcher>()
    const providedKeys = yield* PubSub.unbounded<string>()

    const memoryOf = (name: string): Effect.Effect<number> =>
      deps.memory === undefined ? Effect.succeed(0) : deps.memory.used(name)

    const tracked = <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      deps.memory === undefined ? effect : deps.memory.track(name, effect)

    const peekCategory = (root: string): Effect.Effect<PluginCategory> =>
      deps.loader.peek(root).pipe(
        Effect.map((manifest) => manifest.category),
        Effect.orElseSucceed((): PluginCategory => 'feature')
      )

    const categoryOfEntry = (entry: Entry<Context>): Effect.Effect<PluginCategory> =>
      entry.category === undefined ? peekCategory(entry.root) : Effect.succeed(entry.category)

    const categoryOf = (name: string): Effect.Effect<PluginCategory> =>
      Effect.gen(function* () {
        const entry = entries.get(name)
        if (entry !== undefined) return yield* categoryOfEntry(entry)
        const source = yield* deps.catalog.resolve(name)
        if (Option.isNone(source)) return 'feature'
        return yield* peekCategory(source.value.root)
      })

    const infoOf = (name: string, entry: Entry<Context>): Effect.Effect<PluginInfo> =>
      Effect.gen(function* () {
        const memoryBytes = yield* memoryOf(name)
        const category = yield* categoryOfEntry(entry)
        return {
          name,
          category,
          origin: entry.origin,
          root: entry.root,
          status: entry.status,
          memoryBytes,
          provides: [...entry.provided].sort()
        }
      })

    const failedInfo = (name: string, message: string): PluginInfo => ({
      name,
      category: 'feature',
      origin: 'default',
      root: '',
      status: { _tag: 'Failed', message },
      memoryBytes: 0,
      provides: []
    })

    const markFailed = (entry: Entry<Context>, message: string) => {
      entry.manifest = undefined
      entry.setup = undefined
      entry.status = { _tag: 'Failed', message }
    }

    const reported = new Map<string, PluginInfo>()
    const queuedByStart = new Set<string>()

    const publishChanges = Effect.fnUntraced(function* () {
      if (deps.onChange === undefined) return
      const changed: Array<PluginInfo> = []
      for (const [name, entry] of entries) {
        const info = yield* infoOf(name, entry)
        const previous = reported.get(name)
        if (previous !== undefined && sameInfo(previous, info)) continue
        reported.set(name, info)
        changed.push(info)
      }
      if (changed.length > 0) yield* deps.onChange(changed)
    })

    const entryFor = (name: string, source: PluginSource): Entry<Context> => {
      const existing = entries.get(name)
      if (existing !== undefined) return existing
      const created = makeEntry<Context>(source)
      entries.set(name, created)
      return created
    }

    const markLoading = (entry: Entry<Context>): boolean => {
      if (entry.status._tag !== 'Unloaded' && entry.status._tag !== 'Failed') return false
      entry.status = { _tag: 'Loading' }
      return true
    }

    const withinTimeLimit = <A, E>(
      name: string,
      stage: 'import' | 'setup',
      effect: Effect.Effect<A, E>
    ): Effect.Effect<A, E | PluginLoadError> =>
      Effect.gen(function* () {
        const exit = yield* Effect.acquireUseRelease(
          Effect.forkDetach(effect, { startImmediately: true }),
          (fiber) => Fiber.await(fiber).pipe(Effect.timeoutOption(PLUGIN_SETUP_TIME_LIMIT)),
          (fiber) => Effect.forkDetach(Fiber.interrupt(fiber))
        )
        if (Option.isSome(exit)) return yield* exit.value
        return yield* new PluginLoadError({
          message: `Plugin "${name}" did not finish its ${stage} within ${Duration.format(PLUGIN_SETUP_TIME_LIMIT)}`
        })
      })

    const withinSetupWindow = <A, E>(
      window: SetupWindow,
      effect: Effect.Effect<A, E>
    ): Effect.Effect<A, E | PluginLoadError> =>
      withinTimeLimit(
        window.plugin,
        'setup',
        Effect.provideService(effect, CurrentSetup, window)
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            window.accepting = false
          })
        )
      )

    const watchersOf = (name: string): ReadonlyArray<Watcher> =>
      [...watchers].filter((watcher) => watcher.plugin === name)

    const providedByWatcher = (name: string, key: string): boolean =>
      watchersOf(name).some((watcher) => watcher.provided.has(key))

    const isRunningName = (name: string): boolean => {
      const entry = entries.get(name)
      return entry !== undefined && isRunning(entry)
    }

    const inject = (key: string): Effect.Effect<Option.Option<unknown>> =>
      Effect.sync(() => Option.fromNullishOr(slots.get(key)).pipe(Option.map((slot) => slot.value)))

    const servicesFor = (name: string, entry: Entry<Context>): PluginServices => ({
      name,
      provide: (key, value) =>
        Effect.gen(function* () {
          if (entry.category !== 'adapter' && deps.adapterContract.keys.includes(key)) {
            yield* Effect.logError('A feature plugin provided a key reserved for adapters', {
              plugin: name,
              key
            })
            return yield* new ServiceKeyReservedError({
              key,
              message: `"${key}" can be provided only by an adapter plugin`
            })
          }
          const scope = yield* Scope.Scope
          if (scope.state._tag === 'Closed') {
            yield* Effect.logWarning('A plugin provided a service after its setup was abandoned', {
              plugin: name,
              key
            })
            return
          }
          const current = slots.get(key)
          if (current !== undefined && current.owner !== name) {
            return yield* new ServiceKeyTakenError({ key, owner: current.owner })
          }
          const window = yield* CurrentSetup
          const watcher = window?.plugin === name ? window.watcher : undefined
          if (entry.provided.has(key) && (watcher !== undefined || providedByWatcher(name, key))) {
            yield* Effect.logError(
              'A plugin provided a key twice while one is in a whenProvided setup',
              {
                plugin: name,
                key
              }
            )
            return yield* new ServiceKeyTakenError({ key, owner: name })
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              slots.set(key, { owner: name, value })
              entry.provided.add(key)
              watcher?.provided.add(key)
            }).pipe(Effect.andThen(PubSub.publish(providedKeys, key))),
            () =>
              Effect.sync(() => {
                if (slots.get(key)?.owner === name) slots.delete(key)
                entry.provided.delete(key)
                watcher?.provided.delete(key)
              }).pipe(Effect.andThen(PubSub.publish(providedKeys, key)))
          )
        }),
      inject: (key) =>
        injectedKeys(entry).includes(key)
          ? inject(key)
          : Effect.gen(function* () {
              yield* Effect.logError('A plugin read a service it does not declare', {
                plugin: name,
                key
              })
              return yield* new ServiceNotDeclaredError({
                key,
                message:
                  entry.category === 'adapter'
                    ? `Adapter plugin "${name}" reads "${key}", but an adapter cannot declare "inject"`
                    : watchersOf(name).some((watcher) => watcher.keys.includes(key))
                      ? `Plugin "${name}" reads "${key}" without declaring it; use the value whenProvided passes to its setup, or add "${key}" to "inject" in its plugin.json if the plugin requires it`
                      : `Plugin "${name}" reads "${key}" without declaring it; add "${key}" to "inject" in its plugin.json`
              })
            }),
      whenProvided: (keys, setup) =>
        Effect.gen(function* () {
          const window = acceptingWindow(name, entry.category, yield* CurrentSetup)
          if (typeof window === 'string') {
            const refusal = window
            yield* Effect.logError('A plugin called whenProvided outside its setup', {
              plugin: name,
              reason: refusal
            })
            return yield* new WhenProvidedRefusedError({
              plugin: name,
              message:
                refusal === 'adapter'
                  ? `Adapter plugin "${name}" cannot call whenProvided`
                  : `Plugin "${name}" called whenProvided outside its setup; call it during setup or inside another whenProvided setup`
            })
          }
          const parent = yield* Scope.Scope
          if (parent.state._tag === 'Closed') {
            yield* Effect.logWarning('A plugin called whenProvided after its setup was abandoned', {
              plugin: name,
              keys
            })
            return
          }
          const watcher: Watcher = {
            plugin: name,
            keys,
            setup: (services) =>
              setup(services as { readonly [K in (typeof keys)[number]]: unknown }),
            parent,
            provided: new Set(),
            nested: new Set(),
            state: WatcherState.Idle()
          }
          const outer = window.watcher
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              watchers.add(watcher)
              outer?.nested.add(watcher)
            }),
            () =>
              Effect.sync(() => {
                watchers.delete(watcher)
                outer?.nested.delete(watcher)
              })
          )
          yield* Effect.logDebug('Registered a setup that waits for services', {
            plugin: name,
            keys
          })
        })
    })

    const providedBy = (entry: Entry<Context>, key: string): Option.Option<unknown> =>
      entry.provided.has(key)
        ? Option.fromNullishOr(slots.get(key)).pipe(Option.map((slot) => slot.value))
        : Option.none()

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

    const drainLeases = (
      name: string,
      leases: Leases,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    ) =>
      Effect.gen(function* () {
        leases.closing = true
        if (leases.active.size === 0) return
        yield* Effect.logInfo("Waiting for calls that use the plugin's services", {
          plugin: name,
          calls: leases.active.size
        })
        yield* restore(
          Deferred.await(leases.drained).pipe(Effect.timeoutOption(SERVICE_USE_TIME_LIMIT))
        ).pipe(Effect.exit)
        if (leases.active.size === 0) return
        yield* Effect.logWarning('Interrupted calls that still used a closing plugin', {
          plugin: name,
          keys: [...leases.active.values()]
        })
        yield* Deferred.succeed(leases.withdrawn, undefined)
        for (const fiber of leases.active.keys()) yield* Effect.forkDetach(Fiber.interrupt(fiber))
      })

    const closePlugin = (
      name: string,
      entry: Entry<Context>,
      scope: Scope.Closeable,
      exit: Exit.Exit<unknown, unknown>
    ): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const leases = entry.leases
          if (leases !== undefined) yield* drainLeases(name, leases, restore)
          entry.leases = undefined
          yield* Scope.close(scope, exit)
        })
      )

    const use = <A, E, R>(
      key: string,
      f: (value: unknown) => Effect.Effect<A, E, R>
    ): Effect.Effect<Option.Option<A>, E | ServiceWithdrawnError, R> =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const slot = slots.get(key)
          if (slot === undefined) return { _tag: 'NotProvided' } as const
          const leases = entries.get(slot.owner)?.leases
          if (leases === undefined || leases.closing) {
            return { _tag: 'Closing', plugin: slot.owner } as const
          }
          const fiber = yield* Effect.forkDetach(f(slot.value), { startImmediately: true })
          leases.active.set(fiber, key)
          return { _tag: 'Granted', plugin: slot.owner, leases, fiber } as const
        }),
        (grant) =>
          Effect.gen(function* () {
            if (grant._tag === 'NotProvided') {
              yield* Effect.logDebug('No plugin provides the service', { key })
              return Option.none<A>()
            }
            if (grant._tag === 'Closing') {
              yield* Effect.logDebug('The plugin providing the service is closing', {
                key,
                plugin: grant.plugin
              })
              return Option.none<A>()
            }
            const finished = yield* Effect.raceFirst(
              Fiber.await(grant.fiber).pipe(Effect.asSome),
              Deferred.await(grant.leases.withdrawn).pipe(Effect.as(Option.none<Exit.Exit<A, E>>()))
            )
            const withdrawnMeanwhile =
              Option.isSome(finished) &&
              Exit.hasInterrupts(finished.value) &&
              Deferred.isDoneUnsafe(grant.leases.withdrawn)
            if (Option.isSome(finished) && !withdrawnMeanwhile) {
              return Option.some(yield* finished.value)
            }
            yield* Effect.logWarning('A call using the service ended because its plugin closed', {
              key,
              plugin: grant.plugin
            })
            return yield* new ServiceWithdrawnError({
              key,
              plugin: grant.plugin,
              message: `The "${grant.plugin}" plugin closed while a call using "${key}" was running`
            })
          }),
        (grant) =>
          grant._tag === 'Granted'
            ? Effect.gen(function* () {
                grant.leases.active.delete(grant.fiber)
                if (grant.leases.closing && grant.leases.active.size === 0) {
                  yield* Deferred.succeed(grant.leases.drained, undefined)
                }
                if (grant.fiber.pollUnsafe() === undefined) {
                  yield* Effect.forkDetach(Fiber.interrupt(grant.fiber))
                }
              })
            : Effect.void
      )

    const closeDependantsOf = (
      keys: ReadonlySet<string>,
      owner: string,
      closing: string
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const dependant of dependantsOf(owner, keys)) {
          yield* closeWithDependants(dependant.name)
          dependant.entry.status = { _tag: 'Waiting', missing: dependant.missing }
          yield* Effect.logInfo('Plugin waiting for a service', {
            plugin: dependant.name,
            missing: dependant.missing
          })
        }
        for (const watcher of [...watchers]) {
          if (!watchers.has(watcher) || !watcher.keys.some((key) => keys.has(key))) continue
          if (watcher.state._tag === 'Running') yield* closeWatcher(watcher, closing)
          else if (watcher.state._tag === 'Failed') watcher.state = WatcherState.Idle()
        }
      })

    const closeWatcher = (watcher: Watcher, closing: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (watcher.state._tag !== 'Running') return
        const scope = watcher.state.scope
        watcher.state = WatcherState.Idle()
        for (const nested of [...watcher.nested]) yield* closeWatcher(nested, closing)
        yield* closeDependantsOf(new Set(watcher.provided), watcher.plugin, closing)
        yield* Scope.close(scope, Exit.void)
        if (watcher.plugin !== closing) {
          yield* Effect.logInfo('Closed a setup because a service it waits for is closing', {
            plugin: watcher.plugin,
            keys: watcher.keys
          })
        }
      })

    const closeWithDependants = (name: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entry = entries.get(name)
        if (entry === undefined) return
        yield* closeDependantsOf(new Set(entry.provided), name, name)
        const scope = entry.scope
        entry.scope = undefined
        if (scope !== undefined) yield* closePlugin(name, entry, scope, Exit.void)
      })

    const isReady = (watcher: Watcher): boolean =>
      watcher.state._tag === 'Idle' &&
      isRunningName(watcher.plugin) &&
      watcher.keys.every((key) => {
        const slot = slots.get(key)
        return slot !== undefined && isRunningName(slot.owner)
      })

    const runWatcher = (watcher: Watcher): Effect.Effect<void> =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(watcher.parent)
        const services = Object.fromEntries(watcher.keys.map((key) => [key, slots.get(key)?.value]))
        const window: SetupWindow = { plugin: watcher.plugin, watcher, accepting: true }
        const exit = yield* Effect.exit(
          withinSetupWindow(
            window,
            Scope.provide(scope)(Effect.suspend(() => watcher.setup(services)))
          )
        )
        if (Exit.isSuccess(exit)) {
          watcher.state = WatcherState.Running({ scope })
          yield* Effect.logInfo('Started a setup whose services are provided', {
            plugin: watcher.plugin,
            keys: watcher.keys
          })
          return
        }
        yield* Scope.close(scope, exit)
        watcher.state = WatcherState.Failed()
        yield* Effect.logError('A setup whose services are provided failed', {
          plugin: watcher.plugin,
          keys: watcher.keys,
          cause: exit.cause
        })
      })

    const runWatchers: Effect.Effect<boolean> = Effect.gen(function* () {
      let ran = false
      for (const watcher of [...watchers]) {
        if (!watchers.has(watcher) || !isReady(watcher)) continue
        yield* runWatcher(watcher)
        ran = true
      }
      return ran
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
        const context = yield* deps.extend(servicesFor(name, entry)).pipe(
          Effect.tapError((error) =>
            Effect.logError('Plugin context could not be prepared', {
              plugin: name,
              message: error.message
            })
          )
        )
        const scope = yield* Scope.fork(parentScope)
        entry.leases = makeLeases()
        const exit = yield* Effect.exit(
          withinSetupWindow(
            { plugin: name, watcher: undefined, accepting: true },
            Scope.provide(scope)(Effect.suspend(() => setup.value(context)))
          )
        )
        if (Exit.isFailure(exit)) {
          yield* closePlugin(name, entry, scope, exit)
          yield* Effect.logError('Plugin setup failed', { plugin: name, cause: exit.cause })
          return yield* new PluginLoadError({ message: describeCause(exit.cause) })
        }
        if (entry.manifest?.category === 'adapter') {
          const problems = deps.adapterContract.problems((key) => providedBy(entry, key))
          if (problems.length > 0) {
            yield* closePlugin(name, entry, scope, Exit.void)
            yield* Effect.logError('Adapter plugin does not meet the adapter contract', {
              plugin: name,
              problems
            })
            return yield* new PluginLoadError({
              message: [
                `Plugin "${name}" does not meet the adapter contract:`,
                ...problems.map((problem) => `- ${problem}`)
              ].join('\n')
            })
          }
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

    const settle = Effect.gen(function* () {
      let ran = true
      while (ran) {
        yield* openWaiting
        ran = yield* runWatchers
      }
    })

    const swap = (name: string, source: PluginSource, entry: Entry<Context>) =>
      Effect.fnUntraced(function* (loaded: LoadedPlugin<Context>) {
        if (!isApiCompatible(PLUGIN_API_VERSION, loaded.manifest.api)) {
          return yield* new PluginLoadError({
            message: `Plugin API version "${loaded.manifest.api}" is not supported; this dia implements "${PLUGIN_API_VERSION}"`
          })
        }
        if (loaded.manifest.name !== name) {
          return yield* new PluginLoadError({
            message: `Manifest name "${loaded.manifest.name}" does not match the plugin directory "${name}"`
          })
        }
        const setup = yield* withinTimeLimit(name, 'import', loaded.resolveSetup)

        const previous = {
          origin: entry.origin,
          root: entry.root,
          category: entry.category,
          manifest: entry.manifest,
          setup: entry.setup
        }
        yield* closeWithDependants(name)
        entry.origin = source.origin
        entry.root = source.root
        entry.category = loaded.manifest.category
        entry.manifest = loaded.manifest
        entry.setup = setup
        const opened = yield* Effect.exit(open(name, entry))
        if (Exit.isSuccess(opened)) return
        Object.assign(entry, previous)
        yield* openOrFail(name, entry)
        return yield* Effect.failCause(opened.cause)
      })

    const loadNamed = (name: string, fromStart: boolean): Effect.Effect<PluginInfo> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = entries.get(name)
          if (fromStart && !queuedByStart.delete(name) && current !== undefined) {
            return yield* infoOf(name, current)
          }
          if (current?.category === 'adapter' && isRunning(current)) {
            yield* Effect.logWarning('Refused to reload an adapter plugin', { plugin: name })
            return yield* infoOf(name, current)
          }
          const found = yield* deps.catalog.resolve(name)
          if (Option.isNone(found)) return failedInfo(name, `No plugin named "${name}"`)
          const source = found.value

          const entry = entryFor(name, source)
          if (markLoading(entry)) yield* publishChanges()

          if (deps.memory !== undefined) {
            const used = yield* deps.memory.used(name)
            if (used >= deps.memory.limit) {
              const message = `Plugin "${name}" retained ${formatMegabytes(used)} across loads, over the limit of ${formatMegabytes(deps.memory.limit)}. Restart dia to reload it.`
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
          yield* settle
          return yield* infoOf(name, entry)
        }).pipe(Effect.tap(publishChanges))
      )

    const load = (name: string): Effect.Effect<PluginInfo> =>
      Effect.suspend(() => {
        queuedByStart.delete(name)
        return loadNamed(name, false)
      })

    const refuseUnload = (name: string): Effect.Effect<PluginInfo> =>
      Effect.gen(function* () {
        yield* Effect.logWarning('Refused to unload an adapter plugin', { plugin: name })
        const infos = yield* list()
        return (
          infos.find((info) => info.name === name) ?? failedInfo(name, `No plugin named "${name}"`)
        )
      })

    const unload = (name: string): Effect.Effect<PluginInfo> =>
      Effect.gen(function* () {
        if ((yield* categoryOf(name)) === 'adapter') return yield* refuseUnload(name)
        queuedByStart.delete(name)
        return yield* unloadLocked(name)
      })

    const unloadLocked = (name: string): Effect.Effect<PluginInfo> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = entries.get(name)
          if (entry === undefined) {
            const source = yield* deps.catalog.resolve(name)
            if (Option.isNone(source)) return failedInfo(name, `No plugin named "${name}"`)
            return {
              name,
              category: yield* peekCategory(source.value.root),
              origin: source.value.origin,
              root: source.value.root,
              status: { _tag: 'Unloaded' },
              memoryBytes: 0,
              provides: []
            } satisfies PluginInfo
          }
          yield* tracked(name, closeWithDependants(name))
          entry.manifest = undefined
          entry.setup = undefined
          entry.status = { _tag: 'Unloaded' }
          yield* Effect.logInfo('Plugin unloaded', { plugin: name })
          return yield* infoOf(name, entry)
        }).pipe(Effect.tap(publishChanges))
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
            return Effect.gen(function* () {
              const source = yield* deps.catalog.resolve(name)
              return {
                name,
                category: Option.isSome(source)
                  ? yield* peekCategory(source.value.root)
                  : 'feature',
                origin: Option.match(source, {
                  onNone: () => 'default',
                  onSome: (found) => found.origin
                }),
                root: Option.match(source, {
                  onNone: () => '',
                  onSome: (found) => found.root
                }),
                status: { _tag: 'Unloaded' },
                memoryBytes: 0,
                provides: []
              } satisfies PluginInfo
            })
          },
          { concurrency: 'unbounded' }
        )
      })

    const loadModeOf = (name: string): Effect.Effect<PluginLoadMode> =>
      Effect.gen(function* () {
        const source = yield* deps.catalog.resolve(name)
        if (Option.isNone(source)) return 'lazy'
        return yield* deps.loader.peek(source.value.root).pipe(
          Effect.map(
            (manifest): PluginLoadMode =>
              manifest.category === 'adapter' ? 'eager' : (manifest.load ?? 'lazy')
          ),
          Effect.catchTag('PluginLoadError', (error) =>
            Effect.logDebug('Plugin manifest unreadable at startup; loading it lazily', {
              plugin: name,
              message: error.message
            }).pipe(Effect.as<PluginLoadMode>('lazy'))
          )
        )
      })

    const markAllLoading = (names: ReadonlyArray<string>): Effect.Effect<void> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          for (const name of names) {
            const source = yield* deps.catalog.resolve(name)
            if (Option.isSome(source) && markLoading(entryFor(name, source.value))) {
              queuedByStart.add(name)
            }
          }
        }).pipe(Effect.tap(publishChanges))
      )

    const loadIfQueued = (name: string): Effect.Effect<void> => Effect.asVoid(loadNamed(name, true))

    const start = Effect.fn('PluginRegistry.start')(function* () {
      const names = (yield* list()).map((info) => info.name)
      yield* markAllLoading(names)
      const modes = yield* Effect.forEach(names, loadModeOf, { concurrency: 'unbounded' })
      const eager = names.filter((_, index) => modes[index] === 'eager')
      const lazy = names.filter((_, index) => modes[index] !== 'eager')
      yield* Effect.logInfo('Plugins starting', { eager, lazy })
      yield* Effect.forEach(eager, loadIfQueued, { discard: true })
      yield* Effect.logInfo('Eager plugins settled', { count: eager.length })
      yield* Effect.forEach(lazy, loadIfQueued, { discard: true }).pipe(
        Effect.tap(() => Effect.logInfo('Lazy plugins settled', { count: lazy.length })),
        Effect.forkIn(parentScope)
      )
    })

    return { list, start, load, unload, inject, use, changes: Stream.fromPubSub(providedKeys) }
  })
